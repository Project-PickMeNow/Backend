import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { configureApp } from './../src/configure-app';

/**
 * REST 관통 e2e — 실제 Redis·PostgreSQL 이 떠 있어야 한다.
 * (로컬: docker compose up -d / CI: ci.yml 의 서비스 컨테이너 + prisma migrate deploy)
 *
 * configureApp 으로 main.ts 와 동일한 전역 설정(prefix·검증·에러필터)을 적용해
 * 실제 배포와 같은 동작을 검증한다.
 */

/** 성공 응답 공통 형태 — supertest 의 res.body 는 any 라 여기서 타입을 붙인다. */
interface ApiEnvelope<T> {
  success: boolean;
  data: T;
}

/** 에러 응답 공통 형태 — { success:false, error:{ code, message } } */
interface ErrorEnvelope {
  success: boolean;
  error: { code: string; message: string };
}

interface RoomSummary {
  roomId: string;
  title: string;
  status: string;
  gameType: string | null;
  participantCount: number;
}

describe('REST API (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    // 닫지 않으면 Redis 연결이 남아 jest 가 종료되지 않는다.
    await app.close();
  });

  it('GET /api/health — 헬스체크', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/health')
      .expect(200);

    expect(res.body).toMatchObject({ status: 'ok' });
  });

  it('GET /api/stats — 누적 통계', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/stats')
      .expect(200);

    const body = res.body as ApiEnvelope<{ totalRooms: number }>;
    expect(body.success).toBe(true);
    expect(typeof body.data.totalRooms).toBe('number');
  });

  it('POST /api/rooms → GET /api/rooms/:roomId 관통', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/rooms')
      .send({ title: '점심 뭐 먹지', gameType: 'roulette' })
      .expect(201);

    const { roomId, joinUrl, hostToken } = (
      created.body as ApiEnvelope<{
        roomId: string;
        joinUrl: string;
        hostToken: string;
      }>
    ).data;

    expect(roomId).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
    expect(joinUrl).toContain(roomId);
    expect(hostToken).toBeTruthy();

    const fetched = await request(app.getHttpServer())
      .get(`/api/rooms/${roomId}`)
      .expect(200);

    expect((fetched.body as ApiEnvelope<RoomSummary>).data).toMatchObject({
      roomId,
      title: '점심 뭐 먹지',
      status: 'waiting',
      gameType: 'roulette',
      participantCount: 0,
    });
    // 참가자도 받는 응답이라 hostToken 이 새어나가면 안 된다.
    expect(JSON.stringify(fetched.body)).not.toContain(hostToken);
  });

  it('GET /api/rooms/:roomId — 없는 방은 404, 에러 봉투 { success:false, error:{code} }', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/rooms/ZZZZZZ')
      .expect(404);

    const body = res.body as ErrorEnvelope;
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('ROOM_NOT_FOUND');
    expect(typeof body.error.message).toBe('string');
  });

  it('POST /api/rooms — 잘못된 gameType 은 400 VALIDATION_ERROR', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/rooms')
      .send({ gameType: 'bogus' })
      .expect(400);

    expect((res.body as ErrorEnvelope).error.code).toBe('VALIDATION_ERROR');
  });

  it('POST /api/rooms — DTO 에 없는 필드는 거부(whitelist) → 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/rooms')
      .send({ title: '정상', hacker: 'inject' })
      .expect(400);

    expect((res.body as ErrorEnvelope).error.code).toBe('VALIDATION_ERROR');
  });
});
