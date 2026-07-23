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
  describe('비밀방 입장 규칙', () => {
    const createSecretRoom = async (password: string) => {
      const res = await request(app.getHttpServer())
        .post('/api/rooms')
        .send({
          title: '비밀방',
          gameType: 'roulette',
          isSecret: true,
          password,
        })
        .expect(201);
      return (res.body as { data: { roomId: string; hostToken: string } }).data;
    };

    it('GET /api/rooms/:id 는 isSecret 을 알리되 비밀번호는 감춘다', async () => {
      const { roomId } = await createSecretRoom('4242');
      const res = await request(app.getHttpServer())
        .get(`/api/rooms/${roomId}`)
        .expect(200);
      const body = res.body as { data: Record<string, unknown> };
      expect(body.data.isSecret).toBe(true);
      expect(JSON.stringify(body)).not.toContain('4242');
      expect(body.data).not.toHaveProperty('joinCodeHash');
    });

    it('틀린 비밀번호로는 입장할 수 없다 (WRONG_PASSWORD)', async () => {
      const { roomId } = await createSecretRoom('4242');
      const guest = connect(roomId);
      try {
        await once(guest, 'room:state');
        const ack = (await guest.emitWithAck('room:join', {
          nickname: 'A',
          password: '0000',
        })) as Ack;
        expect(ack).toEqual({ ok: false, code: 'WRONG_PASSWORD' });
      } finally {
        guest.disconnect();
      }
    });

    it('비밀번호 없이 비밀방에 입장하면 거절된다 (WRONG_PASSWORD)', async () => {
      const { roomId } = await createSecretRoom('4242');
      const guest = connect(roomId);
      try {
        await once(guest, 'room:state');
        const ack = (await guest.emitWithAck('room:join', {
          nickname: 'A',
        })) as Ack;
        expect(ack).toEqual({ ok: false, code: 'WRONG_PASSWORD' });
      } finally {
        guest.disconnect();
      }
    });

    it('올바른 비밀번호로는 입장할 수 있다', async () => {
      const { roomId } = await createSecretRoom('4242');
      const guest = connect(roomId);
      try {
        await once(guest, 'room:state');
        const ack = (await guest.emitWithAck('room:join', {
          nickname: 'A',
          password: '4242',
        })) as Ack;
        expect(ack).toEqual({ ok: true });
      } finally {
        guest.disconnect();
      }
    });

    it('자유방은 비밀번호 없이 입장된다', async () => {
      const { roomId } = await createRoom();
      const guest = connect(roomId);
      try {
        await once(guest, 'room:state');
        const ack = (await guest.emitWithAck('room:join', {
          nickname: 'A',
        })) as Ack;
        expect(ack).toEqual({ ok: true });
      } finally {
        guest.disconnect();
      }
    });
  });

  const setupGame = async (gameType: string) => {
    const { roomId, host, guest } = await setup();
    await host.emitWithAck('item:add', { label: '짜장' });
    await host.emitWithAck('item:add', { label: '짬뽕' });
    await host.emitWithAck('item:add', { label: '볶음밥' });
    await host.emitWithAck('game:select', { gameType });
    return { roomId, host, guest };
  };

  it('순서 정하기: host·참가자가 동시에 같은 순서를 본다', async () => {
    const { host, guest } = await setupGame('order');
    try {
      const hr = once<{ result: { type: string; order: Item[] } }>(
        host,
        'game:result',
      );
      const gr = once<{ result: { type: string; order: Item[] } }>(
        guest,
        'game:result',
      );
      await host.emitWithAck('game:start', {});
      const [h, g] = await Promise.all([hr, gr]);
      expect(h.result.type).toBe('order');
      expect(h.result.order).toEqual(g.result.order); // 전원 동일 순서
      expect(h.result.order).toHaveLength(3); // setupGame 이 항목 3개 추가
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

  // ── 제비뽑기(인터랙티브) 규칙: 참가자 1개·host 복수(2번째+ '미선택')·60초 자동 공개 ──
  describe('제비뽑기(인터랙티브) 규칙', () => {
    it('참가자는 제비 1개만 — 두 번째 뽑기는 거절 (ALREADY_PICKED)', async () => {
      const { roomId, host, guest } = await setupGame('draw');
      const p2 = connect(roomId);
      try {
        await guest.emitWithAck('room:join', { nickname: 'A' });
        await p2.emitWithAck('room:join', { nickname: 'B' });
        const shuffled = once<{ perPick: number }>(guest, 'draw:shuffled');
        await host.emitWithAck('draw:shuffle', { count: 2, blanks: 1 });
        expect((await shuffled).perPick).toBe(1);

        const a0 = (await guest.emitWithAck('draw:pick', { index: 0 })) as Ack;
        expect(a0).toEqual({ ok: true });
        const a1 = (await guest.emitWithAck('draw:pick', { index: 1 })) as Ack;
        expect(a1).toEqual({ ok: false, code: 'ALREADY_PICKED' });
      } finally {
        host.disconnect();
        guest.disconnect();
        p2.disconnect();
      }
    });

    it('참가자는 제비수가 사람수보다 많아도 1개만 뽑는다 (perPick 항상 1)', async () => {
      const { host, guest } = await setupGame('draw');
      try {
        // 참가자 1명 · 제비 4개여도 참가자는 1개만.
        await guest.emitWithAck('room:join', { nickname: '혼자' });
        const shuffled = once<{ perPick: number }>(guest, 'draw:shuffled');
        await host.emitWithAck('draw:shuffle', { count: 4, blanks: 1 });
        expect((await shuffled).perPick).toBe(1);

        expect(await guest.emitWithAck('draw:pick', { index: 0 })).toEqual({
          ok: true,
        });
        const second = (await guest.emitWithAck('draw:pick', {
          index: 1,
        })) as Ack;
        expect(second).toEqual({ ok: false, code: 'ALREADY_PICKED' });
      } finally {
        host.disconnect();
        guest.disconnect();
      }
    });

    it('호스트의 첫 제비는 "호스트", 2번째부터는 "미선택" 으로 공개된다', async () => {
      const { host, guest } = await setupGame('draw');
      try {
        const shuffled = once(host, 'draw:shuffled');
        await host.emitWithAck('draw:shuffle', { count: 4, blanks: 1 });
        await shuffled;

        const first = once<{ by: string }>(guest, 'draw:picked');
        expect(await host.emitWithAck('draw:pick', { index: 0 })).toEqual({
          ok: true,
        });
        expect((await first).by).toBe('호스트');

        const second = once<{ by: string }>(guest, 'draw:picked');
        expect(await host.emitWithAck('draw:pick', { index: 1 })).toEqual({
          ok: true,
        });
        expect((await second).by).toBe('미선택');
      } finally {
        host.disconnect();
        guest.disconnect();
      }
    });

    it('draw:autoresolve 는 안 뽑힌 제비를 전부 "미선택" 으로 공개한다(host 전용)', async () => {
      const { roomId, host, guest } = await setupGame('draw');
      const p2 = connect(roomId);
      try {
        await guest.emitWithAck('room:join', { nickname: 'A' });
        await p2.emitWithAck('room:join', { nickname: 'B' });
        const shuffled = once(guest, 'draw:shuffled');
        await host.emitWithAck('draw:shuffle', { count: 4, blanks: 1 });
        await shuffled;

        // A 가 1개 뽑음 → 남은 3개는 자동 공개 대상.
        await guest.emitWithAck('draw:pick', { index: 0 });

        // 참가자는 자동 공개를 부를 수 없다.
        const bad = (await guest.emitWithAck('draw:autoresolve')) as Ack;
        expect(bad).toEqual({ ok: false, code: 'NOT_HOST' });

        // 호스트가 자동 공개 → 남은 3개가 '미선택' 으로 broadcast.
        const seen: { index: number; by: string }[] = [];
        p2.on('draw:picked', (p: { index: number; by: string }) =>
          seen.push(p),
        );
        expect(await host.emitWithAck('draw:autoresolve')).toEqual({
          ok: true,
        });
        await new Promise((r) => setTimeout(r, 80));
        const auto = seen.filter((p) => p.by === '미선택');
        expect(auto).toHaveLength(3);
      } finally {
        host.disconnect();
        guest.disconnect();
        p2.disconnect();
      }
    });

    it('제비를 다 뽑기 전엔 다시 섞을 수 없다 (GAME_RUNNING)', async () => {
      const { host, guest } = await setupGame('draw');
      try {
        const shuffled = once(host, 'draw:shuffled');
        await host.emitWithAck('draw:shuffle', { count: 2, blanks: 1 });
        await shuffled;

        // 1개만 뽑은 상태 → 재섞기 거절
        await host.emitWithAck('draw:pick', { index: 0 });
        const early = (await host.emitWithAck('draw:shuffle', {
          count: 2,
          blanks: 1,
        })) as Ack;
        expect(early).toEqual({ ok: false, code: 'GAME_RUNNING' });

        // 마지막 제비까지 뽑으면 재섞기 허용
        await host.emitWithAck('draw:pick', { index: 1 });
        const shuffled2 = once(host, 'draw:shuffled');
        const okAck = (await host.emitWithAck('draw:shuffle', {
          count: 2,
          blanks: 1,
        })) as Ack;
        expect(okAck).toEqual({ ok: true });
        await shuffled2;
      } finally {
        host.disconnect();
        guest.disconnect();
      }
    });
  });

  // ── 풍선 터뜨리기(러시안 룰렛식, 턴제): 참가자 순서·한 번씩 펌프·터진 사람 걸림 ──
  describe('풍선 터뜨리기(러시안 룰렛)', () => {
    type Started = {
      capacity: number;
      turnOrder: string[];
      turn: string;
      maxPerTurn: number;
      turnDeadline: number;
    };
    type Pumped = {
      by: string;
      pumps: number;
      turnPumps: number;
      turn: string | null;
      turnDeadline: number | null;
      caughtBy: string | null;
      burst: boolean;
    };
    type Passed = { by: string; turn: string; turnDeadline: number };

    it('참가자가 없으면(호스트만) 시작할 수 없다 (NEED_MORE_PLAYERS)', async () => {
      const { host, guest } = await setupGame('balloon');
      try {
        // 아무도 room:join 하지 않음 — 호스트 혼자(턴 1명)로는 게임이 성립하지 않는다.
        const ack = (await host.emitWithAck('balloon:start', {
          total: 6,
        })) as Ack;
        expect(ack).toEqual({ ok: false, code: 'NEED_MORE_PLAYERS' });
      } finally {
        host.disconnect();
        guest.disconnect();
      }
    });

    it("'호스트' 닉네임은 예약어라 참가자가 쓸 수 없다 (NICKNAME_TAKEN)", async () => {
      const { host, guest } = await setupGame('balloon');
      try {
        // 호스트가 턴 순서에 '호스트'로 들어가므로, 같은 이름의 참가자는 막아야 턴 판정이 안 꼬인다.
        const ack = (await guest.emitWithAck('room:join', {
          nickname: '호스트',
        })) as Ack;
        expect(ack).toEqual({ ok: false, code: 'NICKNAME_TAKEN' });
      } finally {
        host.disconnect();
        guest.disconnect();
      }
    });

    it('관통 — 호스트 포함 턴 순서·3펌프 시 자동 넘김·터뜨린 사람이 걸림', async () => {
      const { roomId, host, guest } = await setupGame('balloon');
      const p1 = connect(roomId);
      const p2 = connect(roomId);
      try {
        await p1.emitWithAck('room:join', { nickname: 'A' });
        await p2.emitWithAck('room:join', { nickname: 'B' });
        const sock: Record<string, typeof p1> = { 호스트: host, A: p1, B: p2 };

        const started = once<Started>(host, 'balloon:started');
        const ack0 = (await host.emitWithAck('balloon:start', {
          total: 30,
        })) as Ack;
        expect(ack0).toEqual({ ok: true });
        const s = await started;
        // 호스트를 포함해 3명이 턴 순서에 들어가고, 순서는 무작위로 섞인다. 첫 턴은 순서의 맨 앞.
        expect([...s.turnOrder].sort()).toEqual(['A', 'B', '호스트']);
        expect(s.turn).toBe(s.turnOrder[0]);
        expect(s.maxPerTurn).toBe(3);
        // 총 펌프(풍선 크기)는 서버가 인원수 × 3 × 3 으로 정한다(호스트 포함 3명 → 27).
        expect(s.capacity).toBe(s.turnOrder.length * 3 * 3);
        // 첫 턴 제한시각(60초 뒤)이 미래로 내려온다.
        expect(s.turnDeadline).toBeGreaterThan(Date.now());

        let turn = s.turn;
        let caught: string | null = null;
        let totalPumps = 0;
        let guard = 0;
        while (!caught && guard++ < 100) {
          const other = s.turnOrder.find((n) => n !== turn) as string;
          // 내 턴이 아닌 사람은 펌프할 수 없다.
          expect(await sock[other].emitWithAck('balloon:pump', {})).toEqual({
            ok: false,
            code: 'NOT_YOUR_TURN',
          });
          // 1번도 안 펌프하고는 넘길 수 없다.
          expect(await sock[turn].emitWithAck('balloon:pass', {})).toEqual({
            ok: false,
            code: 'PUMP_FIRST',
          });

          let turnPumps = 0;
          let advanced = false;
          while (!advanced) {
            const evt = once<Pumped>(host, 'balloon:pumped');
            const ack = (await sock[turn].emitWithAck(
              'balloon:pump',
              {},
            )) as Ack;
            expect(ack).toEqual({ ok: true });
            const p = await evt;
            turnPumps += 1;
            totalPumps += 1;
            expect(p.by).toBe(turn);
            expect(p.pumps).toBe(totalPumps); // 누적 펌프 수 +1
            if (p.burst) {
              caught = p.caughtBy;
              expect(p.caughtBy).toBe(turn); // 터뜨린 사람이 걸린다
              expect(p.turn).toBeNull();
              advanced = true;
            } else if (turnPumps >= 3) {
              // 3번째 펌프 → '넘기기' 없이도 자동으로 다음 사람에게 넘어간다.
              expect(p.caughtBy).toBeNull();
              expect(p.turnPumps).toBe(0); // 다음 사람의 턴 펌프 수는 0
              expect(p.turn).not.toBe(turn);
              expect(s.turnOrder).toContain(p.turn as string);
              turn = p.turn as string;
              advanced = true;
            } else {
              // 1,2번째 펌프 → 턴은 그대로 유지(자동으로 안 넘어감).
              expect(p.caughtBy).toBeNull();
              expect(p.turnPumps).toBe(turnPumps);
              expect(p.turn).toBe(turn);
            }
          }
        }
        expect(s.turnOrder).toContain(caught); // 호스트 포함 누군가 걸렸다
        expect(totalPumps).toBeLessThanOrEqual(s.capacity); // capacity 안에서 반드시 터진다
      } finally {
        host.disconnect();
        guest.disconnect();
        p1.disconnect();
        p2.disconnect();
      }
    });

    it('넘기기 — 3번을 다 채우기 전에도 다음 사람으로 넘길 수 있다', async () => {
      const { roomId, host, guest } = await setupGame('balloon');
      const p2 = connect(roomId);
      try {
        await guest.emitWithAck('room:join', { nickname: 'A' });
        await p2.emitWithAck('room:join', { nickname: 'B' });
        const sock: Record<string, typeof host> = {
          호스트: host,
          A: guest,
          B: p2,
        };
        const started = once<Started>(host, 'balloon:started');
        await host.emitWithAck('balloon:start', { total: 30 });
        const s = await started; // 순서는 무작위 — 첫 턴은 turnOrder[0]
        const first = s.turnOrder[0];
        const second = s.turnOrder[1];
        expect(s.turn).toBe(first);

        // 첫 턴 사람이 1번만 펌프한다.
        const pumpEvt = once<Pumped>(host, 'balloon:pumped');
        expect(await sock[first].emitWithAck('balloon:pump', {})).toEqual({
          ok: true,
        });
        const p = await pumpEvt;
        if (p.burst) {
          expect(p.caughtBy).toBe(first); // 드물게 첫 펌프에 터짐 — 걸림만 확인
        } else {
          expect(p.turn).toBe(first); // 아직 턴 유지
          expect(p.turnPumps).toBe(1);
          // 3번을 다 채우기 전에 '넘기기' → 다음 사람으로 넘어간다.
          const passEvt = once<Passed>(host, 'balloon:passed');
          expect(await sock[first].emitWithAck('balloon:pass', {})).toEqual({
            ok: true,
          });
          const pd = await passEvt;
          expect(pd.by).toBe(first);
          expect(pd.turn).toBe(second);
        }
      } finally {
        host.disconnect();
        guest.disconnect();
        p2.disconnect();
      }
    });

    it('진행 중에는 다시 시작할 수 없다 (GAME_RUNNING)', async () => {
      const { roomId, host, guest } = await setupGame('balloon');
      const p2 = connect(roomId);
      try {
        await guest.emitWithAck('room:join', { nickname: 'A' });
        await p2.emitWithAck('room:join', { nickname: 'B' });
        const started = once<Started>(host, 'balloon:started');
        await host.emitWithAck('balloon:start', { total: 30 });
        await started;

        const again = (await host.emitWithAck('balloon:start', {
          total: 30,
        })) as Ack;
        expect(again).toEqual({ ok: false, code: 'GAME_RUNNING' });
      } finally {
        host.disconnect();
        guest.disconnect();
        p2.disconnect();
      }
    });

    it('참가자는 balloon:start 를 호출할 수 없다 (NOT_HOST)', async () => {
      const { host, guest } = await setupGame('balloon');
      try {
        const ack = (await guest.emitWithAck('balloon:start', {
          total: 6,
        })) as Ack;
        expect(ack).toEqual({ ok: false, code: 'NOT_HOST' });
      } finally {
        host.disconnect();
        guest.disconnect();
      }
    });

    // 회귀: 안 터진 풍선을 남긴 채(방 복귀 없이) 새 라운드를 시작하면, game:begin 이 이전 풍선을
    // 지워 다시 시작할 수 있어야 한다. 안 그러면 startBalloon 이 GAME_RUNNING 으로 거절돼
    // 호스트가 balloon:started 를 못 받고 "게임을 시작하는 중…"에 갇힌다.
    it('game:begin 이 이전 라운드의 미완료 풍선을 지워 다시 시작할 수 있다', async () => {
      const { roomId, host, guest } = await setupGame('balloon');
      const p2 = connect(roomId);
      try {
        await guest.emitWithAck('room:join', { nickname: 'A' });
        await p2.emitWithAck('room:join', { nickname: 'B' });

        // 1라운드 시작 — 아무도 안 걸린 채(caughtBy===null) 진행 중 상태로 둔다.
        const started1 = once<Started>(host, 'balloon:started');
        expect(await host.emitWithAck('balloon:start', {})).toEqual({
          ok: true,
        });
        await started1;

        // 방 복귀 없이 바로 재시작하면 진행 중이라 거절된다(기준선).
        expect(await host.emitWithAck('balloon:start', {})).toEqual({
          ok: false,
          code: 'GAME_RUNNING',
        });

        // 새 라운드 게이트 — game:begin 이 이전 풍선을 지운다.
        expect(await host.emitWithAck('game:begin')).toEqual({ ok: true });

        // 이제 새 풍선 게임이 정상 시작돼 balloon:started 가 전원에게 전달된다.
        const started2 = once<Started>(host, 'balloon:started');
        expect(await host.emitWithAck('balloon:start', {})).toEqual({
          ok: true,
        });
        const s2 = await started2;
        expect([...s2.turnOrder].sort()).toEqual(['A', 'B', '호스트']);
      } finally {
        host.disconnect();
        guest.disconnect();
        p2.disconnect();
      }
    });
  });

  // ── 새 게임 시작 게이트: 이전 게임 참가자가 전부 방으로 돌아오거나(room:ready) 나가야 시작 가능 ──
  describe('새 게임 시작 게이트(전원 복귀)', () => {
    it('안 돌아온 참가자가 있으면 새 게임을 시작할 수 없다 (PLAYERS_NOT_READY)', async () => {
      const { host, guest } = await setupGame('roulette');
      try {
        await guest.emitWithAck('room:join', { nickname: 'A' });
        // 첫 게임 시작 — A 는 입장으로 준비됨(ready). 시작하면 준비 목록이 비워진다.
        expect(await host.emitWithAck('game:begin')).toEqual({ ok: true });
        // 호스트가 방으로 돌아감(대기 전환). A 는 아직 결과 화면이라 안 돌아옴.
        await host.emitWithAck('room:return');
        // 새 게임 시작 시도 — A 미복귀로 거절.
        expect(await host.emitWithAck('game:begin')).toEqual({
          ok: false,
          code: 'PLAYERS_NOT_READY',
        });
        // A 가 '방으로 돌아가기'(room:ready) → 전원 복귀 → 시작 가능.
        await guest.emitWithAck('room:ready');
        expect(await host.emitWithAck('game:begin')).toEqual({ ok: true });
      } finally {
        host.disconnect();
        guest.disconnect();
      }
    });

    it('안 돌아온 참가자가 나가면(자동 퇴장) 남은 전원 기준으로 시작할 수 있다', async () => {
      const { roomId, host, guest } = await setupGame('roulette');
      const p2 = connect(roomId);
      try {
        await guest.emitWithAck('room:join', { nickname: 'A' });
        await p2.emitWithAck('room:join', { nickname: 'B' });
        expect(await host.emitWithAck('game:begin')).toEqual({ ok: true });
        await host.emitWithAck('room:return');
        await guest.emitWithAck('room:ready'); // A 만 복귀
        // B 미복귀 → 아직 거절.
        expect(await host.emitWithAck('game:begin')).toEqual({
          ok: false,
          code: 'PLAYERS_NOT_READY',
        });
        // B 가 나감(60초 뒤 자동 퇴장 상당) → 남은 참가자(A) 전원 복귀 → 시작 가능.
        await p2.emitWithAck('room:leave');
        expect(await host.emitWithAck('game:begin')).toEqual({ ok: true });
      } finally {
        host.disconnect();
        guest.disconnect();
        p2.disconnect();
      }
    });
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

  // ── game:begin — '게임 시작 ▶' 을 누르는 즉시 결과 전에 참가자도 게임 화면으로 ──
  describe('game:begin', () => {
    it('host 가 시작을 누르면 결과 전에도 전원이 game:begin 을 받고, 늦은 입장도 playing 을 본다', async () => {
      const { roomId, host, guest } = await setupGame('roulette');
      try {
        const hb = once<{ gameType: string }>(host, 'game:begin');
        const gb = once<{ gameType: string }>(guest, 'game:begin');

        const ack = (await host.emitWithAck('game:begin')) as Ack;
        expect(ack).toEqual({ ok: true });

        const [h, g] = await Promise.all([hb, gb]);
        expect(h.gameType).toBe('roulette');
        expect(g.gameType).toBe('roulette');

        const late = connect(roomId);
        try {
          const state = await once<{ status: string }>(late, 'room:state');
          expect(state.status).toBe('playing'); // 결과 없이도 playing 으로 복원
        } finally {
          late.disconnect();
        }
      } finally {
        host.disconnect();
        guest.disconnect();
      }
    });

    it('아직 게임 종류를 안 골랐으면 거부한다 (VALIDATION_ERROR)', async () => {
      const { host, guest } = await setup(); // game:select 이전
      try {
        const ack = (await host.emitWithAck('game:begin')) as Ack;
        expect(ack).toEqual({ ok: false, code: 'VALIDATION_ERROR' });
      } finally {
        host.disconnect();
        guest.disconnect();
      }
    });

    it('참가자는 호출할 수 없다 (NOT_HOST)', async () => {
      const { host, guest } = await setupGame('roulette');
      try {
        const ack = (await guest.emitWithAck('game:begin')) as Ack;
        expect(ack).toEqual({ ok: false, code: 'NOT_HOST' });
      } finally {
        host.disconnect();
        guest.disconnect();
      }
    });
  });

  // ── game:replay — '같은 항목으로 다시하기': game:reset 초기화 + 참가자에게만 한 판 더 확인 ──
  // ── room:return — '방으로 돌아가기': 서버 상태만 대기로 리셋(참가자 강제 이동 없음) ──
  describe('room:return', () => {
    it('호스트가 방으로 돌아가면 방이 대기(waiting) 상태로 리셋된다', async () => {
      const { roomId, host, guest } = await setupGame('roulette');
      try {
        const begun = Promise.all([
          once(host, 'game:begin'),
          once(guest, 'game:begin'),
        ]);
        await host.emitWithAck('game:begin');
        await begun;

        const ack = (await host.emitWithAck('room:return')) as Ack;
        expect(ack).toEqual({ ok: true });

        // 서버 상태가 waiting 으로 돌아가, 늦게 들어온 소켓도 대기 화면(room:state)을 받는다.
        const late = connect(roomId);
        try {
          const state = await once<{ status: string }>(late, 'room:state');
          expect(state.status).toBe('waiting');
        } finally {
          late.disconnect();
        }
      } finally {
        host.disconnect();
        guest.disconnect();
      }
    });

    it('참가자는 호출할 수 없다 (NOT_HOST)', async () => {
      const { host, guest } = await setupGame('roulette');
      try {
        const ack = (await guest.emitWithAck('room:return')) as Ack;
        expect(ack).toEqual({ ok: false, code: 'NOT_HOST' });
      } finally {
        host.disconnect();
        guest.disconnect();
      }
    });
  });

  // ── roulette:draft — 호스트가 원판 칸에 입력 중인 라벨을 참가자가 실시간으로(저장 없이) 본다 ──
  describe('roulette:draft', () => {
    it('참가자가 실시간으로 받는다(items 는 그대로 — 저장하지 않는 relay)', async () => {
      const { host, guest } = await setupGame('roulette');
      try {
        const draft = once<{ labels: string[] }>(guest, 'roulette:draft');
        const ack = (await host.emitWithAck('roulette:draft', {
          labels: ['가위', '바위', '보'],
        })) as Ack;
        expect(ack).toEqual({ ok: true });

        const { labels } = await draft;
        expect(labels).toEqual(['가위', '바위', '보']);

        // 저장되지 않는다 — 방 items 는 setupGame 이 넣은 3개 그대로.
        const { items } = await new Promise<{ items: Item[] }>((resolve) => {
          host.emit('item:add', { label: '__probe__' });
          host.once('item:added', (d: { items: Item[] }) => resolve(d));
        });
        expect(items.map((i) => i.label)).not.toContain('가위');
      } finally {
        host.disconnect();
        guest.disconnect();
      }
    });

    it('호스트 자신은 자기가 보낸 draft 를 받지 않는다(발신자 제외 relay)', async () => {
      const { host, guest } = await setupGame('roulette');
      try {
        let hostGotDraft = false;
        host.once('roulette:draft', () => {
          hostGotDraft = true;
        });
        const guestSaw = once<{ labels: string[] }>(guest, 'roulette:draft');
        await host.emitWithAck('roulette:draft', { labels: ['a'] });
        await guestSaw;

        await new Promise((r) => setTimeout(r, 100));
        expect(hostGotDraft).toBe(false);
      } finally {
        host.disconnect();
        guest.disconnect();
      }
    });

    it('참가자는 호출할 수 없다 (NOT_HOST)', async () => {
      const { host, guest } = await setupGame('roulette');
      try {
        const ack = (await guest.emitWithAck('roulette:draft', {
          labels: ['x'],
        })) as Ack;
        expect(ack).toEqual({ ok: false, code: 'NOT_HOST' });
      } finally {
        host.disconnect();
        guest.disconnect();
      }
    });
  });

  // ── 투표 라이프사이클: preparing → open → closing(카운트다운) → closed ──
  describe('투표 라이프사이클 규칙', () => {
    /** room:state 를 한 번 받아 현재 items 를 읽어온다(itemId 확보용). */
    const getItems = async (roomId: string): Promise<Item[]> => {
      const probe = connect(roomId);
      try {
        const state = await once<{ items: Item[] }>(probe, 'room:state');
        return state.items;
      } finally {
        probe.disconnect();
      }
    };

    it('준비 단계(투표 시작 전)에는 투표할 수 없다 (VOTE_NOT_OPEN)', async () => {
      const { roomId, host, guest } = await setupGame('vote');
      try {
        const items = await getItems(roomId);
        // 아직 '투표 시작' 전(preparing) — 호스트도 투표할 수 없다(닉네임 무관하게 VOTE_NOT_OPEN).
        const ack = (await host.emitWithAck('vote:cast', {
          itemId: items[0].id,
        })) as Ack;
        expect(ack).toEqual({ ok: false, code: 'VOTE_NOT_OPEN' });
      } finally {
        host.disconnect();
        guest.disconnect();
      }
    });

    it('시작→투표→마감카운트다운→취소→재마감→finalize 전 과정', async () => {
      const { roomId, host, guest } = await setupGame('vote');
      try {
        const items = await getItems(roomId);
        const itemId = items[0].id;

        // 투표 시작 → open (전원에게 vote:state)
        const opened = once<{ status: string; closeAt: number | null }>(
          guest,
          'vote:state',
        );
        expect(await host.emitWithAck('vote:start')).toEqual({ ok: true });
        expect((await opened).status).toBe('open');

        // 표가 없으면 마감 불가
        expect(await host.emitWithAck('vote:close')).toEqual({
          ok: false,
          code: 'VOTE_NO_VOTES',
        });

        // 호스트 투표 → open 상태에서 성공(호스트도 투표할 수 있다 · 닉네임 입장 없이 role 로 허용)
        expect(await host.emitWithAck('vote:cast', { itemId })).toEqual({
          ok: true,
        });

        // 마감 → closing + closeAt(약 10초 뒤)
        const closing = once<{ status: string; closeAt: number | null }>(
          guest,
          'vote:state',
        );
        expect(await host.emitWithAck('vote:close')).toEqual({ ok: true });
        const cs = await closing;
        expect(cs.status).toBe('closing');
        expect(typeof cs.closeAt).toBe('number');
        expect(cs.closeAt as number).toBeGreaterThan(Date.now());

        // 취소 → 다시 open
        const cancelled = once<{ status: string }>(guest, 'vote:state');
        expect(await host.emitWithAck('vote:cancel')).toEqual({ ok: true });
        expect((await cancelled).status).toBe('open');

        // 재마감 → closing
        expect(await host.emitWithAck('vote:close')).toEqual({ ok: true });

        // finalize(카운트다운 0초) → game:result(vote)
        const resultP = once<{ result: { type: string; winner: Item } }>(
          host,
          'game:result',
        );
        expect(await host.emitWithAck('vote:finalize')).toEqual({ ok: true });
        const { result } = await resultP;
        expect(result.type).toBe('vote');
        expect(result.winner.id).toBe(itemId);
      } finally {
        host.disconnect();
        guest.disconnect();
      }
    });

    it('참가자는 투표 시작/마감/취소/finalize 를 할 수 없다 (NOT_HOST)', async () => {
      const { host, guest } = await setupGame('vote');
      try {
        for (const ev of [
          'vote:start',
          'vote:close',
          'vote:cancel',
          'vote:finalize',
        ]) {
          expect(await guest.emitWithAck(ev)).toEqual({
            ok: false,
            code: 'NOT_HOST',
          });
        }
      } finally {
        host.disconnect();
        guest.disconnect();
      }
    });

    it('closing 이 아닐 때 finalize 는 결과를 만들지 않는다(멱등)', async () => {
      const { roomId, host, guest } = await setupGame('vote');
      try {
        const items = await getItems(roomId);
        await host.emitWithAck('vote:start');
        await host.emitWithAck('vote:cast', { itemId: items[0].id });
        // open 상태에서 finalize → no-op (ok 지만 결과 없음).
        expect(await host.emitWithAck('vote:finalize')).toEqual({ ok: true });
        // 이어서 정상 마감(close→finalize)하면 결과가 온다 — 위 no-op 이 상태를 망가뜨리지 않았음을 확인.
        const resultP = once<{ result: { type: string } }>(host, 'game:result');
        await host.emitWithAck('vote:close');
        await host.emitWithAck('vote:finalize');
        expect((await resultP).result.type).toBe('vote');
      } finally {
        host.disconnect();
        guest.disconnect();
      }
    });
  });
});
