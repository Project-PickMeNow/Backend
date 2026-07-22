import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AddressInfo } from 'node:net';
import { Server } from 'node:http';
import request from 'supertest';
import { App } from 'supertest/types';
import { io, Socket } from 'socket.io-client';
import { AppModule } from './../src/app.module';
import { configureApp } from './../src/configure-app';

/** room:join / room:close 등 ack 응답의 공통 형태 */
type Ack = { ok: true } | { ok: false; code: string };

/**
 * 실시간 입장 관통 e2e (계획서 WS2: 두 탭 입장 시 "N명" 동기화).
 * 실제 Redis 가 떠 있어야 한다. socket.io-client 로 진짜 소켓을 붙여 검증한다.
 */
describe('RoomGateway 실시간 입장 (e2e)', () => {
  let app: INestApplication<App>;
  let baseUrl: string;

  /** 특정 이벤트 1회를 기다리는 헬퍼 (타임아웃 시 실패) */
  const once = <T = unknown>(
    socket: Socket,
    event: string,
    ms = 3000,
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`'${event}' 이벤트 타임아웃`)),
        ms,
      );
      socket.once(event, (data: T) => {
        clearTimeout(timer);
        resolve(data);
      });
    });

  /** 지정 시간 안에 이벤트가 '오지 않아야' 통과(true). 오면 false. */
  const expectNoEvent = (
    socket: Socket,
    event: string,
    ms = 500,
  ): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      const onEvent = () => resolve(false); // 이벤트가 오면 실패로 판정(once 라 자동 해제)
      socket.once(event, onEvent);
      setTimeout(() => {
        socket.off(event, onEvent);
        resolve(true); // 시간이 다 지나도록 안 왔으면 통과(Promise 는 한 번만 resolve)
      }, ms);
    });

  const connect = (roomId: string, auth: Record<string, string> = {}): Socket =>
    io(`${baseUrl}/rooms`, {
      auth: { roomId, ...auth },
      transports: ['websocket'],
      forceNew: true,
    });

  const createRoom = async (): Promise<{
    roomId: string;
    hostToken: string;
  }> => {
    const res = await request(app.getHttpServer())
      .post('/api/rooms')
      .send({ title: '실시간 테스트' })
      .expect(201);
    return (res.body as { data: { roomId: string; hostToken: string } }).data;
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    // socket.io-client 가 붙으려면 실제 포트를 열어야 한다(app.init 만으로는 리스너가 없다).
    await app.listen(0);
    const server = app.getHttpServer() as Server;
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://localhost:${port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('두 소켓이 입장하면 participantCount 가 서로 동기화된다', async () => {
    const { roomId } = await createRoom();

    const a = connect(roomId);
    const b = connect(roomId);
    try {
      // 접속하면 각자 방 스냅샷을 받는다.
      await Promise.all([once(a, 'room:state'), once(b, 'room:state')]);

      // A 가 입장 → 양쪽 모두 participant:joined(count=1) 를 받아야 한다.
      const bSeesA = once<{ participantCount: number; nickname: string }>(
        b,
        'participant:joined',
      );
      const ack = (await a.emitWithAck('room:join', {
        nickname: '앨리스',
      })) as Ack;
      expect(ack).toEqual({ ok: true });

      const joined = await bSeesA;
      expect(joined.nickname).toBe('앨리스');
      expect(joined.participantCount).toBe(1);

      // B 가 입장 → count=2, participants 에 둘 다 있어야 한다.
      const aSeesB = once<{ participantCount: number; participants: string[] }>(
        a,
        'participant:joined',
      );
      await b.emitWithAck('room:join', { nickname: '밥' });

      const joined2 = await aSeesB;
      expect(joined2.participantCount).toBe(2);
      expect(joined2.participants.sort()).toEqual(['밥', '앨리스']);
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });

  it('중복 닉네임은 NICKNAME_TAKEN 으로 거절한다', async () => {
    const { roomId } = await createRoom();
    const a = connect(roomId);
    const b = connect(roomId);
    try {
      await Promise.all([once(a, 'room:state'), once(b, 'room:state')]);

      await a.emitWithAck('room:join', { nickname: '중복' });
      const ack = (await b.emitWithAck('room:join', {
        nickname: '중복',
      })) as Ack;

      expect(ack).toEqual({ ok: false, code: 'NICKNAME_TAKEN' });
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });

  it('대기 중 소켓이 잠깐 끊겨도 곧바로 참가자에서 빠지지 않는다(재접속 유예)', async () => {
    const { roomId } = await createRoom();
    const a = connect(roomId);
    const b = connect(roomId);
    try {
      await Promise.all([once(a, 'room:state'), once(b, 'room:state')]);
      await a.emitWithAck('room:join', { nickname: '떠날뻔한사람' });
      await b.emitWithAck('room:join', { nickname: '남을사람' });

      // 서버 재시작·ping timeout 처럼 잠깐 끊긴 것으로 본다 — 유예 동안 participant:left 가 오면 안 된다.
      const noLeft = expectNoEvent(b, 'participant:left', 600);
      a.disconnect();
      expect(await noLeft).toBe(true);
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });

  it('대기 중 끊겼다가 같은 닉네임으로 재접속하면 튕기지 않고 그대로 복귀한다', async () => {
    const { roomId } = await createRoom();
    const a = connect(roomId);
    const b = connect(roomId);
    try {
      await Promise.all([once(a, 'room:state'), once(b, 'room:state')]);
      await a.emitWithAck('room:join', { nickname: '재접속러' });
      await b.emitWithAck('room:join', { nickname: '지켜보는사람' });

      // a 끊김 → b 가 online:count 감소를 보면 서버가 유예를 걸어둔 시점이다(동기화 지점).
      const bSeesDrop = once<{ onlineCount: number }>(b, 'online:count');
      a.disconnect();
      await bSeesDrop;

      // 같은 닉네임으로 재접속 → 중복(NICKNAME_TAKEN)이 아니라 복귀(ok)로 통과해야 한다.
      const a2 = connect(roomId);
      try {
        await once(a2, 'room:state');
        const bSeesRejoin = once<{
          participantCount: number;
          participants: string[];
        }>(b, 'participant:joined');
        const ack = (await a2.emitWithAck('room:join', {
          nickname: '재접속러',
        })) as Ack;
        expect(ack).toEqual({ ok: true });

        // 방에는 여전히 두 명이 그대로 있어야 한다(재접속러 유지, 유령 없음).
        const rejoined = await bSeesRejoin;
        expect(rejoined.participantCount).toBe(2);
        expect(rejoined.participants.sort()).toEqual(
          ['재접속러', '지켜보는사람'].sort(),
        );
      } finally {
        a2.disconnect();
      }
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });

  it('한 소켓이 닉네임을 바꿔 재입장해도 유령 참가자가 남지 않는다', async () => {
    const { roomId } = await createRoom();
    const a = connect(roomId);
    const b = connect(roomId);
    try {
      await Promise.all([once(a, 'room:state'), once(b, 'room:state')]);

      await a.emitWithAck('room:join', { nickname: '옛이름' });

      // A 가 다른 닉네임으로 다시 입장 → B 는 옛이름의 left 를 보고, 최종 count 는 1 이어야 한다.
      const bSeesLeft = once<{ nickname: string; participantCount: number }>(
        b,
        'participant:left',
      );
      const ack = (await a.emitWithAck('room:join', {
        nickname: '새이름',
      })) as Ack;
      expect(ack).toEqual({ ok: true });

      const left = await bSeesLeft;
      expect(left.nickname).toBe('옛이름');
      expect(left.participantCount).toBe(1); // 새이름만 남아야 함(유령 없음)
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });

  it('없는 방으로 접속하면 error 후 연결이 끊긴다', async () => {
    const bad = connect('ZZZZZZ');
    try {
      const err = await once<{ code: string }>(bad, 'error');
      expect(err.code).toBe('ROOM_NOT_FOUND');
    } finally {
      bad.disconnect();
    }
  });
});
