import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AddressInfo } from 'node:net';
import { Server } from 'node:http';
import request from 'supertest';
import { App } from 'supertest/types';
import { io, Socket } from 'socket.io-client';
import { AppModule } from './../src/app.module';
import { configureApp } from './../src/configure-app';

/**
 * 정원 초과(ROOM_FULL) 관통 e2e.
 * 방을 생성할 때 정원을 2 로 지정(POST body maxParticipants)하고 3번째 입장이 거절되는지 본다.
 * (정원은 이제 방마다 host 가 정하는 per-room 값이다)
 */
type Ack = { ok: true } | { ok: false; code: string };

describe('정원 초과 ROOM_FULL (e2e)', () => {
  let app: INestApplication<App>;
  let baseUrl: string;

  const once = <T = unknown>(
    socket: Socket,
    event: string,
    ms = 3000,
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`'${event}' 타임아웃`)),
        ms,
      );
      socket.once(event, (data: T) => {
        clearTimeout(timer);
        resolve(data);
      });
    });

  const connect = (roomId: string): Socket =>
    io(`${baseUrl}/rooms`, {
      auth: { roomId },
      transports: ['websocket'],
      forceNew: true,
    });

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.listen(0);
    const server = app.getHttpServer() as Server;
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://localhost:${port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('정원(2)이 차면 다음 입장은 ROOM_FULL', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/rooms')
      .send({ title: '정원 테스트', maxParticipants: 2 })
      .expect(201);
    const { roomId } = (created.body as { data: { roomId: string } }).data;

    const s1 = connect(roomId);
    const s2 = connect(roomId);
    const s3 = connect(roomId);
    try {
      await Promise.all([
        once(s1, 'room:state'),
        once(s2, 'room:state'),
        once(s3, 'room:state'),
      ]);

      expect(await s1.emitWithAck('room:join', { nickname: '1번' })).toEqual({
        ok: true,
      });
      expect(await s2.emitWithAck('room:join', { nickname: '2번' })).toEqual({
        ok: true,
      });
      // 정원 2 초과 → 3번째는 거절
      const ack = (await s3.emitWithAck('room:join', {
        nickname: '3번',
      })) as Ack;
      expect(ack).toEqual({ ok: false, code: 'ROOM_FULL' });
    } finally {
      [s1, s2, s3].forEach((s) => s.disconnect());
    }
  });
});
