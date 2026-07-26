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
 * 게임 중 참가자 이탈 → 게임 중단 e2e.
 * 게임 진행 중 참가자가 튕기면(유예 후 재접속 없음) 그 참가자를 내보내고(participant:left)
 * 게임을 중단(game:aborted)해 남은 전원(참가자·호스트)이 로비로 돌아온다.
 * 유예 안에 재접속하면 게임을 유지한다.
 */
describe('게임 중 참가자 이탈 시 중단 (e2e)', () => {
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
      .send({ title: '게임 중 이탈 테스트' })
      .expect(201);
    return (res.body as { data: { roomId: string; hostToken: string } }).data;
  };

  /** 방 + host + 참가자 2명 입장 후 게임 시작(status=playing)까지 만든다. */
  const setupPlaying = async () => {
    const { roomId, hostToken } = await createRoom();
    const host = connect(roomId, { hostToken });
    const p1 = connect(roomId);
    const p2 = connect(roomId);
    await Promise.all([
      once(host, 'room:state'),
      once(p1, 'room:state'),
      once(p2, 'room:state'),
    ]);
    await p1.emitWithAck('room:join', { nickname: '지민' });
    await p2.emitWithAck('room:join', { nickname: '수현' });
    await host.emitWithAck('game:select', { gameType: 'roulette' });
    await host.emitWithAck('game:begin', { force: false }); // → status: playing
    return { roomId, hostToken, host, p1, p2 };
  };

  beforeAll(async () => {
    process.env.PLAYER_DROP_GRACE_MS = '400'; // 유예를 짧게 둬 테스트가 빨리 돈다.
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
    delete process.env.PLAYER_DROP_GRACE_MS;
    await app.close();
  });

  it('게임 중 참가자가 튕기면 남은 전원이 game:aborted 를 받고 그 참가자는 목록에서 빠진다', async () => {
    const { host, p1, p2 } = await setupPlaying();
    try {
      const hostAborted = once<{ nickname: string }>(host, 'game:aborted');
      const p2Aborted = once<{ nickname: string }>(p2, 'game:aborted');
      const hostLeft = once<{ nickname: string; participants: string[] }>(
        host,
        'participant:left',
      );

      p1.disconnect(); // 게임 중 참가자 이탈

      const [h, g, left] = await Promise.all([
        hostAborted,
        p2Aborted,
        hostLeft,
      ]);
      expect(h.nickname).toBe('지민');
      expect(g.nickname).toBe('지민');
      expect(left.nickname).toBe('지민');
      expect(left.participants).toEqual(['수현']); // 지민 빠지고 수현만 남음
    } finally {
      host.disconnect();
      p1.disconnect();
      p2.disconnect();
    }
  });

  it('유예 안에 참가자가 재접속하면 게임을 중단하지 않는다', async () => {
    const { roomId, host, p1, p2 } = await setupPlaying();
    let p1b: Socket | undefined;
    try {
      p1.disconnect(); // 잠깐 튕김
      p1b = connect(roomId); // 유예 안에 재접속
      await once(p1b, 'room:state');
      await p1b.emitWithAck('room:join', { nickname: '지민' }); // 슬롯 reclaim

      const notAborted = await expectNoEvent(host, 'game:aborted', 900);
      expect(notAborted).toBe(true);
    } finally {
      host.disconnect();
      p1.disconnect();
      p1b?.disconnect();
      p2.disconnect();
    }
  });

  it('이전 게임에서 걸린 스테일 중단 타이머가 다음 게임을 중단시키지 않는다', async () => {
    const { host, p1, p2 } = await setupPlaying(); // 게임1 playing
    try {
      p1.disconnect(); // 게임1 중 이탈 → 중단 타이머 예약(유예 400ms)
      // 유예 안에 호스트가 로비로 돌아갔다가 게임2를 시작한다(p1 은 prune 으로 명단에서 빠진다).
      await host.emitWithAck('room:return', { notify: true }); // resetGame → waiting
      await p2.emitWithAck('room:ready'); // 참가자 복귀(FE 대역)
      const ack = (await host.emitWithAck('game:begin', { force: false })) as {
        ok: boolean;
      };
      expect(ack.ok).toBe(true); // 게임2 시작(status playing)

      // 게임1의 스테일 타이머가 발화해도(400ms) 게임2를 중단시키면 안 된다.
      const notAborted = await expectNoEvent(host, 'game:aborted', 700);
      expect(notAborted).toBe(true);
    } finally {
      host.disconnect();
      p1.disconnect();
      p2.disconnect();
    }
  });
});
