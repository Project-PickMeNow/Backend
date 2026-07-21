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

  /** 항목 3개 추가 + gameType 선택까지 끝낸 뒤 roomId·host·guest 를 돌려주는 헬퍼 */
  const setupGame = async (gameType: string) => {
    const { roomId, host, guest } = await setup();
    await host.emitWithAck('item:add', { label: '짜장' });
    await host.emitWithAck('item:add', { label: '짬뽕' });
    await host.emitWithAck('item:add', { label: '볶음밥' });
    await host.emitWithAck('game:select', { gameType });
    return { roomId, host, guest };
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

  // 사다리 화면은 방 items 흐름과 분리돼, 호스트가 build 때 칸마다 상단(이름)·하단(당첨항목)을 보낸다.
  const TOP = ['가위', '바위', '보'];
  const BOTTOM = ['꽝', '당첨', '한번더'];
  const buildPayload = { topLabels: TOP, bottomLabels: BOTTOM };

  type BuiltPayload = {
    ladder: { columns: number; mapping: number[]; rungs: unknown[] };
    topLabels: string[];
    bottomLabels: string[];
  };
  type RevealedPayload = {
    topIndex: number;
    bottomIndex: number;
    topLabel: string;
    bottomLabel: string;
  };

  it('사다리: 시작하기(build) 시 전원이 같은 사다리·상하단 라벨을 받는다', async () => {
    const { host, guest } = await setupGame('ladder');
    try {
      const hb = once<BuiltPayload>(host, 'ladder:built');
      const gb = once<BuiltPayload>(guest, 'ladder:built');

      const ack = (await host.emitWithAck('ladder:build', buildPayload)) as Ack;
      expect(ack).toEqual({ ok: true });

      const [h, g] = await Promise.all([hb, gb]);
      expect(h.ladder.columns).toBe(3); // 칸 3개
      expect(h.topLabels).toEqual(TOP);
      expect(h.bottomLabels).toEqual(BOTTOM);
      // 서버가 한 번 만든 동일한 사다리(구조·매핑)를 전원이 받는다.
      expect(h.ladder.mapping).toEqual(g.ladder.mapping);
      expect(h.ladder.rungs).toEqual(g.ladder.rungs);
    } finally {
      host.disconnect();
      guest.disconnect();
    }
  });

  it('사다리: 늦게 들어온 참가자도 room:state 로 현재 사다리·라벨을 복원받는다', async () => {
    const { roomId, host, guest } = await setupGame('ladder');
    try {
      const built = once<BuiltPayload>(host, 'ladder:built');
      await host.emitWithAck('ladder:build', buildPayload);
      const { ladder } = await built;

      // 사다리가 만들어진 뒤 접속하는 '늦은' 참가자 — room:state 에 사다리·라벨이 실려야 한다.
      const late = connect(roomId);
      try {
        const state = await once<{
          ladder: { mapping: number[]; columns: number } | null;
          ladderTopLabels: string[];
          ladderBottomLabels: string[];
        }>(late, 'room:state');
        expect(state.ladder).not.toBeNull();
        expect(state.ladder!.mapping).toEqual(ladder.mapping);
        expect(state.ladder!.columns).toBe(ladder.columns);
        expect(state.ladderTopLabels).toEqual(TOP);
        expect(state.ladderBottomLabels).toEqual(BOTTOM);
      } finally {
        late.disconnect();
      }
    } finally {
      host.disconnect();
      guest.disconnect();
    }
  });

  it('사다리: 시작칸 공개(reveal)를 전원이 같은 도착·라벨로 본다', async () => {
    const { host, guest } = await setupGame('ladder');
    try {
      const built = once<BuiltPayload>(host, 'ladder:built');
      await host.emitWithAck('ladder:build', buildPayload);
      const { ladder } = await built;

      const hr = once<RevealedPayload>(host, 'ladder:revealed');
      const gr = once<RevealedPayload>(guest, 'ladder:revealed');
      await host.emitWithAck('ladder:reveal', { topIndex: 0 });

      const [h, g] = await Promise.all([hr, gr]);
      expect(h.topIndex).toBe(0);
      expect(h.bottomIndex).toBe(ladder.mapping[0]); // 서버 매핑과 일치
      expect(h.topLabel).toBe(TOP[0]);
      expect(h.bottomLabel).toBe(BOTTOM[ladder.mapping[0]]);
      expect(h).toEqual(g); // 전원 동일
    } finally {
      host.disconnect();
      guest.disconnect();
    }
  });

  it('사다리: 결과 보기(result)로 전체 매칭을 전원이 동시에 받는다', async () => {
    const { host, guest } = await setupGame('ladder');
    try {
      const built = once<BuiltPayload>(host, 'ladder:built');
      await host.emitWithAck('ladder:build', buildPayload);
      const { ladder } = await built;

      const hr = once<{ pairs: RevealedPayload[] }>(host, 'ladder:result');
      const gr = once<{ pairs: RevealedPayload[] }>(guest, 'ladder:result');
      const ack = (await host.emitWithAck('ladder:result')) as Ack;
      expect(ack).toEqual({ ok: true });

      const [h, g] = await Promise.all([hr, gr]);
      expect(h.pairs).toHaveLength(3); // 칸마다 한 쌍
      // 시작칸 순서대로, 서버 매핑과 라벨이 일치.
      h.pairs.forEach((p, i) => {
        expect(p.topIndex).toBe(i);
        expect(p.bottomIndex).toBe(ladder.mapping[i]);
        expect(p.topLabel).toBe(TOP[i]);
        expect(p.bottomLabel).toBe(BOTTOM[ladder.mapping[i]]);
      });
      expect(h.pairs).toEqual(g.pairs); // 전원 동일
    } finally {
      host.disconnect();
      guest.disconnect();
    }
  });

  it('사다리: 라벨을 바꾸고 다시 build 하면 칸 수·라벨이 새로 반영된다', async () => {
    const { host, guest } = await setupGame('ladder');
    try {
      const first = once<BuiltPayload>(host, 'ladder:built');
      await host.emitWithAck('ladder:build', buildPayload);
      const built1 = await first;
      expect(built1.ladder.columns).toBe(3);
      expect(built1.topLabels).toHaveLength(3);

      // 칸 하나 늘려(4칸) 다시 build → 새 사다리(4칸)로 재생성, 상·하단 라벨도 4개.
      const second = once<BuiltPayload>(host, 'ladder:built');
      await host.emitWithAck('ladder:build', {
        topLabels: [...TOP, '주먹'],
        bottomLabels: [...BOTTOM, '꽝'],
      });
      const built2 = await second;
      expect(built2.ladder.columns).toBe(4);
      expect(built2.topLabels).toHaveLength(4);
      expect(built2.bottomLabels).toHaveLength(4); // 칸 수 == 라벨 수 (어긋남 없음)
    } finally {
      host.disconnect();
      guest.disconnect();
    }
  });

  it('사다리: 상·하단 칸 수가 다르면 거부한다 (NEED_MORE_ITEMS)', async () => {
    const { host, guest } = await setupGame('ladder');
    try {
      const ack = (await host.emitWithAck('ladder:build', {
        topLabels: ['가위', '바위', '보'],
        bottomLabels: ['꽝', '당첨'], // 2개뿐 — 칸 수 불일치
      })) as Ack;
      expect(ack).toEqual({ ok: false, code: 'NEED_MORE_ITEMS' });
    } finally {
      host.disconnect();
      guest.disconnect();
    }
  });

  it('사다리: 참가자는 build·reveal 할 수 없다 (NOT_HOST)', async () => {
    const { host, guest } = await setupGame('ladder');
    try {
      const ack = (await guest.emitWithAck(
        'ladder:build',
        buildPayload,
      )) as Ack;
      expect(ack).toEqual({ ok: false, code: 'NOT_HOST' });
    } finally {
      host.disconnect();
      guest.disconnect();
    }
  });
});
