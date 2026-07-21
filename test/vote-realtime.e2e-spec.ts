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
 * 투표 관통 e2e — 계획서 WS7: 투표 실시간 집계 → 마감 → 최종 결과 전원 동시.
 * 실제 Redis 가 떠 있어야 한다.
 */
type Ack = { ok: true } | { ok: false; code: string };
interface Item {
  id: string;
  label: string;
}
interface TallyEntry {
  item: Item;
  count: number;
}

describe('투표 관통 (e2e)', () => {
  let app: INestApplication<App>;
  let baseUrl: string;

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
      .send({ title: '투표 테스트' })
      .expect(201);
    return (res.body as { data: { roomId: string; hostToken: string } }).data;
  };

  /** host 가 항목을 추가하고, item:added 로 갱신된 전체 목록을 돌려받는다. */
  const addItem = async (host: Socket, label: string): Promise<Item[]> => {
    const seen = once<{ items: Item[] }>(host, 'item:added');
    await host.emitWithAck('item:add', { label });
    return (await seen).items;
  };

  /**
   * 투표 준비: 방 + host + 참가자 2명(닉네임 입장) + gameType=vote + 항목 2개.
   * items 배열을 함께 돌려준다.
   */
  const setupVote = async (): Promise<{
    host: Socket;
    g1: Socket;
    g2: Socket;
    items: Item[];
  }> => {
    const { roomId, hostToken } = await createRoom();
    const host = connect(roomId, { hostToken });
    const g1 = connect(roomId);
    const g2 = connect(roomId);
    await Promise.all([
      once(host, 'room:state'),
      once(g1, 'room:state'),
      once(g2, 'room:state'),
    ]);
    await g1.emitWithAck('room:join', { nickname: '지민' });
    await g2.emitWithAck('room:join', { nickname: '수현' });
    await host.emitWithAck('game:select', { gameType: 'vote' });
    await addItem(host, '짜장');
    const items = await addItem(host, '짬뽕');
    return { host, g1, g2, items };
  };

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

  it('참가자 투표가 전원에게 실시간 집계로 broadcast 된다', async () => {
    const { host, g1, g2, items } = await setupVote();
    try {
      const hostSees = once<{ tally: TallyEntry[] }>(host, 'vote:updated');
      const ack = (await g1.emitWithAck('vote:cast', {
        itemId: items[0].id,
      })) as Ack;
      expect(ack).toEqual({ ok: true });

      const { tally } = await hostSees;
      const jjajang = tally.find((t) => t.item.id === items[0].id)!;
      expect(jjajang.count).toBe(1);
    } finally {
      [host, g1, g2].forEach((s) => s.disconnect());
    }
  });

  it('한 명이 표를 바꾸면 중복 없이 이동한다 (1인 1표)', async () => {
    const { host, g1, g2, items } = await setupVote();
    try {
      // 첫 표의 broadcast 가 g2 에 도착할 때까지 기다린 뒤(배수) 다음을 구독해야
      // once 가 첫 broadcast 를 잘못 잡는 레이스를 피한다.
      const first = once(g2, 'vote:updated');
      await g1.emitWithAck('vote:cast', { itemId: items[0].id }); // 짜장
      await first;

      const changed = once<{ tally: TallyEntry[] }>(g2, 'vote:updated');
      await g1.emitWithAck('vote:cast', { itemId: items[1].id }); // 짬뽕으로 변경

      const { tally } = await changed;
      const total = tally.reduce((s, t) => s + t.count, 0);
      expect(total).toBe(1); // 여전히 1표 (중복 아님)
      expect(tally.find((t) => t.item.id === items[1].id)!.count).toBe(1);
      expect(tally.find((t) => t.item.id === items[0].id)!.count).toBe(0);
    } finally {
      [host, g1, g2].forEach((s) => s.disconnect());
    }
  });

  it('닉네임을 바꿔 재입장해도 한 소켓은 1표만 갖는다 (중복 투표 방지)', async () => {
    const { host, g1, g2, items } = await setupVote();
    try {
      const first = once(g2, 'vote:updated');
      await g1.emitWithAck('vote:cast', { itemId: items[0].id }); // '지민'으로 투표
      await first; // 첫 broadcast 배수
      // 닉네임을 바꿔 다시 입장한 뒤 다른 항목에 또 투표 시도
      await g1.emitWithAck('room:join', { nickname: '지민2' });
      const seen = once<{ tally: TallyEntry[] }>(g2, 'vote:updated');
      await g1.emitWithAck('vote:cast', { itemId: items[1].id });

      const { tally } = await seen;
      const total = tally.reduce((s, t) => s + t.count, 0);
      expect(total).toBe(1); // 두 번 던졌지만 같은 소켓이라 1표
    } finally {
      [host, g1, g2].forEach((s) => s.disconnect());
    }
  });

  it('투표한 소켓이 끊기면 그 표가 집계에서 빠진다', async () => {
    const { host, g1, g2, items } = await setupVote();
    try {
      // 두 표의 broadcast 를 host 가 모두 받을 때까지 배수한 뒤 disconnect 를 관측한다.
      const h1 = once(host, 'vote:updated');
      await g1.emitWithAck('vote:cast', { itemId: items[0].id });
      await h1;
      const h2 = once(host, 'vote:updated');
      await g2.emitWithAck('vote:cast', { itemId: items[1].id });
      await h2;

      const hostSees = once<{ tally: TallyEntry[] }>(host, 'vote:updated');
      g1.disconnect(); // 투표자 이탈

      const { tally } = await hostSees;
      const total = tally.reduce((s, t) => s + t.count, 0);
      expect(total).toBe(1); // g1 표 빠지고 g2 표만 남음
      expect(tally.find((t) => t.item.id === items[1].id)!.count).toBe(1);
    } finally {
      [host, g1, g2].forEach((s) => s.disconnect());
    }
  });

  it('⭐ host 가 마감하면 최다 득표 결과를 전원이 동시에 본다 (WS7)', async () => {
    const { host, g1, g2, items } = await setupVote();
    try {
      // 둘 다 짬뽕(items[1])에 투표 → 짬뽕이 최다.
      await g1.emitWithAck('vote:cast', { itemId: items[1].id });
      await g2.emitWithAck('vote:cast', { itemId: items[1].id });

      const hostResult = once<{
        result: { winner: Item; tally: TallyEntry[] };
      }>(host, 'game:result');
      const g1Result = once<{ result: { winner: Item; tally: TallyEntry[] } }>(
        g1,
        'game:result',
      );

      const ack = (await host.emitWithAck('vote:close', {})) as Ack;
      expect(ack).toEqual({ ok: true });

      const [h, g] = await Promise.all([hostResult, g1Result]);
      expect(h.result.winner).toEqual(items[1]); // 짬뽕
      expect(h.result.winner).toEqual(g.result.winner); // 전원 동일
      expect(h.result.tally.find((t) => t.item.id === items[1].id)!.count).toBe(
        2,
      );
    } finally {
      [host, g1, g2].forEach((s) => s.disconnect());
    }
  });

  it('참가자는 투표를 마감할 수 없다 (NOT_HOST)', async () => {
    const { host, g1, g2 } = await setupVote();
    try {
      const ack = (await g1.emitWithAck('vote:close', {})) as Ack;
      expect(ack).toEqual({ ok: false, code: 'NOT_HOST' });
    } finally {
      [host, g1, g2].forEach((s) => s.disconnect());
    }
  });

  it('입장(닉네임) 전에는 투표할 수 없다 (VALIDATION_ERROR)', async () => {
    const { roomId, hostToken } = await createRoom();
    const host = connect(roomId, { hostToken });
    const lurker = connect(roomId); // room:join 안 함
    try {
      await Promise.all([once(host, 'room:state'), once(lurker, 'room:state')]);
      await host.emitWithAck('game:select', { gameType: 'vote' });
      await addItem(host, '짜장');
      await addItem(host, '짬뽕');

      const ack = (await lurker.emitWithAck('vote:cast', {
        itemId: 'anything',
      })) as Ack;
      expect(ack).toEqual({ ok: false, code: 'VALIDATION_ERROR' });
    } finally {
      host.disconnect();
      lurker.disconnect();
    }
  });
});
