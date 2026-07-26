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
 * 방장(host) 연결 끊김 → 방 닫힘 e2e.
 * host 가 튕기면(어떤 이유로든) 유예 후 방을 닫아 참가자 전원이 room:closed(홈으로 + '방 삭제' 안내)를
 * 받아야 한다. 유예 안에 host 가 재접속하면 방을 닫지 않는다. 참가자 끊김은 방을 닫지 않는다.
 */
describe('방장 끊김 시 방 닫힘 (e2e)', () => {
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

  const expectNoEvent = (
    socket: Socket,
    event: string,
    ms: number,
  ): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      const onEvent = () => resolve(false);
      socket.once(event, onEvent);
      setTimeout(() => {
        socket.off(event, onEvent);
        resolve(true);
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
      .send({ title: '방장 끊김 테스트' })
      .expect(201);
    return (res.body as { data: { roomId: string; hostToken: string } }).data;
  };

  beforeAll(async () => {
    // 유예를 짧게 둬 테스트가 빨리 돌게 한다(scheduleHostLeave 가 이 env 를 읽는다).
    process.env.HOST_GONE_GRACE_MS = '400';
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
    delete process.env.HOST_GONE_GRACE_MS;
    await app.close();
  });

  it('방장이 끊기면 유예 후 참가자가 room:closed 를 받는다', async () => {
    const { roomId, hostToken } = await createRoom();
    const host = connect(roomId, { hostToken });
    const p = connect(roomId);
    try {
      await Promise.all([once(host, 'room:state'), once(p, 'room:state')]);
      await p.emitWithAck('room:join', { nickname: '참가자' });

      const closed = once(p, 'room:closed');
      host.disconnect(); // 방장 튕김
      await expect(closed).resolves.toBeDefined(); // 유예(400ms) 후 도착
    } finally {
      host.disconnect();
      p.disconnect();
    }
  });

  it('방장이 유예 안에 재접속하면 방을 닫지 않는다', async () => {
    const { roomId, hostToken } = await createRoom();
    const host = connect(roomId, { hostToken });
    const p = connect(roomId);
    let host2: Socket | undefined;
    try {
      await Promise.all([once(host, 'room:state'), once(p, 'room:state')]);
      await p.emitWithAck('room:join', { nickname: '참가자' });

      host.disconnect(); // 방장 잠깐 튕김
      host2 = connect(roomId, { hostToken }); // 유예 안에 곧바로 재접속
      await once(host2, 'room:state');

      // 유예(400ms)를 넘겨도 room:closed 가 오지 않아야 한다.
      const notClosed = await expectNoEvent(p, 'room:closed', 900);
      expect(notClosed).toBe(true);
    } finally {
      host.disconnect();
      host2?.disconnect();
      p.disconnect();
    }
  });

  it('참가자가 끊겨도 방은 닫히지 않는다', async () => {
    const { roomId, hostToken } = await createRoom();
    const host = connect(roomId, { hostToken });
    const p = connect(roomId);
    try {
      await Promise.all([once(host, 'room:state'), once(p, 'room:state')]);
      await p.emitWithAck('room:join', { nickname: '참가자' });

      p.disconnect(); // 참가자(호스트 아님) 튕김
      const notClosed = await expectNoEvent(host, 'room:closed', 900);
      expect(notClosed).toBe(true);
    } finally {
      host.disconnect();
      p.disconnect();
    }
  });
});
