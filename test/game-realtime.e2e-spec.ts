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
 * 게임 관통 e2e — 계획서 WS4: 호스트가 "돌리기" 하면 두 기기가 동시에 같은 결과를 본다.
 * 실제 Redis 가 떠 있어야 한다.
 */
type Ack = { ok: true } | { ok: false; code: string };
interface Item {
  id: string;
  label: string;
}

describe('GameGateway 게임 관통 (e2e)', () => {
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
      .send({ title: '게임 테스트' })
      .expect(201);
    return (res.body as { data: { roomId: string; hostToken: string } }).data;
  };

  /** host·participant 소켓을 붙이고 room:state 까지 받은 상태로 돌려준다. */
  const setup = async (): Promise<{
    roomId: string;
    host: Socket;
    guest: Socket;
  }> => {
    const { roomId, hostToken } = await createRoom();
    const host = connect(roomId, { hostToken });
    const guest = connect(roomId);
    await Promise.all([once(host, 'room:state'), once(guest, 'room:state')]);
    return { roomId, host, guest };
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

  it('host 가 항목을 추가하면 참가자 화면에 실시간 반영된다', async () => {
    const { host, guest } = await setup();
    try {
      const guestSees = once<{ items: Item[] }>(guest, 'item:added');
      const ack = (await host.emitWithAck('item:add', {
        label: '짜장',
      })) as Ack;
      expect(ack).toEqual({ ok: true });

      const { items } = await guestSees;
      expect(items).toHaveLength(1);
      expect(items[0].label).toBe('짜장');
      expect(typeof items[0].id).toBe('string');
    } finally {
      host.disconnect();
      guest.disconnect();
    }
  });

  it('참가자는 항목을 추가할 수 없다 (NOT_HOST)', async () => {
    const { host, guest } = await setup();
    try {
      const ack = (await guest.emitWithAck('item:add', {
        label: '몰래',
      })) as Ack;
      expect(ack).toEqual({ ok: false, code: 'NOT_HOST' });
    } finally {
      host.disconnect();
      guest.disconnect();
    }
  });

  it('⭐ host 가 돌리면 host·참가자가 동시에 같은 당첨 결과를 본다 (WS4)', async () => {
    const { host, guest } = await setup();
    try {
      await host.emitWithAck('item:add', { label: '짜장' });
      await host.emitWithAck('item:add', { label: '짬뽕' });
      await host.emitWithAck('item:add', { label: '볶음밥' });
      await host.emitWithAck('game:select', { gameType: 'roulette' });

      const hostResult = once<{ result: { winner: Item; type: string } }>(
        host,
        'game:result',
      );
      const guestResult = once<{ result: { winner: Item; type: string } }>(
        guest,
        'game:result',
      );

      const ack = (await host.emitWithAck('game:start', {})) as Ack;
      expect(ack).toEqual({ ok: true });

      const [h, g] = await Promise.all([hostResult, guestResult]);
      // 두 기기가 받은 당첨자가 정확히 같아야 한다(서버가 한 번 계산 → 전원 broadcast).
      expect(h.result.type).toBe('roulette');
      expect(h.result.winner).toEqual(g.result.winner);
      expect(['짜장', '짬뽕', '볶음밥']).toContain(h.result.winner.label);
    } finally {
      host.disconnect();
      guest.disconnect();
    }
  });

  it('항목이 2개 미만이면 게임을 시작할 수 없다 (NEED_MORE_ITEMS)', async () => {
    const { host, guest } = await setup();
    try {
      await host.emitWithAck('item:add', { label: '하나뿐' });
      await host.emitWithAck('game:select', { gameType: 'roulette' });
      const ack = (await host.emitWithAck('game:start', {})) as Ack;
      expect(ack).toEqual({ ok: false, code: 'NEED_MORE_ITEMS' });
    } finally {
      host.disconnect();
      guest.disconnect();
    }
  });

  it('항목 제거가 참가자에게도 반영된다', async () => {
    const { host, guest } = await setup();
    try {
      const added = (await host.emitWithAck('item:add', {
        label: '지울것',
      })) as Ack;
      expect(added).toEqual({ ok: true });
      // 방금 추가된 항목의 id 를 room:state 재조회 없이 item:added 로 알아내기 위해 한 번 더 구독
      const guestSees = once<{ items: Item[] }>(guest, 'item:removed');

      // item id 는 item:added 이벤트에서 얻는다.
      const addedItems = await new Promise<Item[]>((resolve) => {
        host.emit('item:add', { label: '남길것' });
        host.once('item:added', (d: { items: Item[] }) => resolve(d.items));
      });
      const target = addedItems.find((it) => it.label === '지울것')!;

      await host.emitWithAck('item:remove', { itemId: target.id });
      const { items } = await guestSees;
      expect(items.map((it) => it.label)).toEqual(['남길것']);
    } finally {
      host.disconnect();
      guest.disconnect();
    }
  });

  /** 항목 3개 추가 + gameType 선택까지 끝낸 뒤 host·guest 를 돌려주는 헬퍼 */
  const setupGame = async (gameType: string) => {
    const { host, guest } = await setup();
    await host.emitWithAck('item:add', { label: '짜장' });
    await host.emitWithAck('item:add', { label: '짬뽕' });
    await host.emitWithAck('item:add', { label: '볶음밥' });
    await host.emitWithAck('game:select', { gameType });
    return { host, guest };
  };

  it('슬롯: host·참가자가 동시에 같은 당첨을 본다', async () => {
    const { host, guest } = await setupGame('slot');
    try {
      const hr = once<{ result: { type: string; winner: Item } }>(
        host,
        'game:result',
      );
      const gr = once<{ result: { type: string; winner: Item } }>(
        guest,
        'game:result',
      );
      await host.emitWithAck('game:start', {});
      const [h, g] = await Promise.all([hr, gr]);
      expect(h.result.type).toBe('slot');
      expect(h.result.winner).toEqual(g.result.winner);
    } finally {
      host.disconnect();
      guest.disconnect();
    }
  });

  it('제비뽑기: count 만큼 N명을 뽑고 전원이 같은 결과를 본다', async () => {
    const { host, guest } = await setupGame('draw');
    try {
      const hr = once<{ result: { type: string; winners: Item[] } }>(
        host,
        'game:result',
      );
      const gr = once<{ result: { type: string; winners: Item[] } }>(
        guest,
        'game:result',
      );
      await host.emitWithAck('game:start', { options: { count: 2 } });
      const [h, g] = await Promise.all([hr, gr]);
      expect(h.result.type).toBe('draw');
      expect(h.result.winners).toHaveLength(2);
      expect(h.result.winners).toEqual(g.result.winners); // 전원 동일
    } finally {
      host.disconnect();
      guest.disconnect();
    }
  });

  it('사다리: 시작→도착 매핑을 전원이 같게 본다', async () => {
    const { host, guest } = await setupGame('ladder');
    try {
      const hr = once<{ result: { type: string; matching: unknown[] } }>(
        host,
        'game:result',
      );
      const gr = once<{ result: { type: string; matching: unknown[] } }>(
        guest,
        'game:result',
      );
      await host.emitWithAck('game:start', {});
      const [h, g] = await Promise.all([hr, gr]);
      expect(h.result.type).toBe('ladder');
      expect(h.result.matching).toHaveLength(3);
      expect(h.result.matching).toEqual(g.result.matching); // 전원 동일
    } finally {
      host.disconnect();
      guest.disconnect();
    }
  });
});
