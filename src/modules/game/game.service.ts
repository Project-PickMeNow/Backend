import { Injectable } from '@nestjs/common';
import { randomInt, randomUUID } from 'node:crypto';
import { RedisService } from '../../infra/redis/redis.service';
import { StatsService } from '../stats/stats.service';
import { RedisKeys } from '../../common/constants/redis-keys';
import { ERROR_CODES } from '../../common/constants/error-code';
import { GAME_TYPES, GameType } from '../../common/constants/game-type';
import { Item } from '../room/room.types';
import { RoomService } from '../room/room.service';
import {
  BalloonPoppedPayload,
  BalloonStartedPayload,
  DrawPick,
  DrawShuffledPayload,
  DrawState,
  GameResult,
  LadderBuiltPayload,
  LadderResultPayload,
  LadderRevealedPayload,
  VoteResult,
  VoteTallyEntry,
} from './game.types';
import { ENGINES } from './engines';
import { VoteEngine } from './engines/vote';
import { generateLadder } from './engines/ladder';
import { LADDER } from '../../common/constants/ladder';
import { DRAW } from '../../common/constants/draw';
import { BALLOON } from '../../common/constants/balloon';
import { capacityForGame } from '../../common/constants/room-capacity';

/**
 * 도메인 규칙 위반을 나타내는 에러. code 는 ERROR_CODES 의 값이며
 * GameGateway 가 이 code 를 그대로 클라이언트 error/ack 로 전달한다.
 */
export class GameError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'GameError';
  }
}

/**
 * 풍선 게임의 서버 저장 형태 — 클라이언트로 나가는 BalloonState 에 없는 burstAt(터지는 순번)을
 * 포함한다. 이 값은 걸리기 전까지 절대 밖으로 내보내지 않는다.
 */
interface StoredBalloon {
  capacity: number; // 풍선 크기(최대 펌프 수)
  burstAt: number; // 비밀 — 누적 펌프가 이 값에 도달하면 터진다 (1..capacity)
  pumps: number; // 지금까지 누적 펌프 수
  turnOrder: string[];
  turnIndex: number;
  caughtBy: string | null;
}

/**
 * 게임 서비스 — 항목 관리, 게임 실행(결과 계산).
 * 항목은 방 해시(room:{id})의 items 필드에, 결과는 game:{id}:result 에 저장한다.
 *
 * host 인증은 소켓 레벨(socket.data.role)에서 게이트웨이가 판별하므로 여기서는 다루지 않는다.
 * 항목 변경은 host 전용(=단일 작성자)이라 읽기-수정-쓰기 경합은 실질적으로 없다.
 */
@Injectable()
export class GameService {
  /** 게임을 돌리려면 항목이 최소 몇 개 있어야 하는지 */
  private static readonly MIN_ITEMS = 2;
  /** 게임 옵션(항목) 최대 개수 — 룰렛·슬롯·풍선·투표 공통 상한 */
  private static readonly MAX_ITEMS = 12;

  private readonly voteEngine = new VoteEngine();

  constructor(
    private readonly redis: RedisService,
    private readonly stats: StatsService,
    private readonly rooms: RoomService,
  ) {}

  /** 항목 추가 → 갱신된 전체 목록 반환 */
  async addItem(roomId: string, label: string | undefined): Promise<Item[]> {
    const room = await this.loadRoomOrThrow(roomId);
    const trimmed = label?.trim();
    if (!trimmed) throw new GameError(ERROR_CODES.VALIDATION_ERROR);

    const items = this.parseItems(room.items);
    // 옵션(항목)은 최대 12개까지 — 프론트도 같은 상한을 두지만 서버에서도 안전하게 막는다.
    if (items.length >= GameService.MAX_ITEMS) {
      throw new GameError(ERROR_CODES.VALIDATION_ERROR);
    }
    items.push({ id: randomUUID(), label: trimmed });
    await this.saveItems(roomId, items);
    return items;
  }

  /** 항목 제거(id 기준) → 갱신된 전체 목록 반환 */
  async removeItem(roomId: string, itemId: string): Promise<Item[]> {
    const room = await this.loadRoomOrThrow(roomId);
    const items = this.parseItems(room.items).filter((it) => it.id !== itemId);
    await this.saveItems(roomId, items);
    return items;
  }

  /** 항목 순서 변경(id 배열 기준) → 갱신된 전체 목록 반환 */
  async reorderItems(roomId: string, order: string[]): Promise<Item[]> {
    const room = await this.loadRoomOrThrow(roomId);
    const items = this.parseItems(room.items);
    const byId = new Map(items.map((it) => [it.id, it]));

    // order 에 명시된 순서대로 배치하되, 목록에 실제 있는 항목만 통과시킨다.
    const ordered = order
      .map((id) => byId.get(id))
      .filter((it): it is Item => it !== undefined);
    // order 에서 빠진 항목은 유실되지 않도록 뒤에 그대로 붙인다.
    const orderSet = new Set(order);
    const leftover = items.filter((it) => !orderSet.has(it.id));

    const reordered = [...ordered, ...leftover];
    await this.saveItems(roomId, reordered);
    return reordered;
  }

  /** 게임 종류 선택 → 확정된 gameType 반환. 정원도 게임별로 갱신(투표 50 / 그 외 12). */
  async selectGame(roomId: string, gameType: string): Promise<GameType> {
    await this.loadRoomOrThrow(roomId);
    if (!this.isGameType(gameType)) {
      throw new GameError(ERROR_CODES.VALIDATION_ERROR);
    }
    await this.redis.client.hset(RedisKeys.room(roomId), {
      gameType,
      maxParticipants: String(capacityForGame(gameType)),
    });
    return gameType;
  }

  /**
   * host 가 '게임 시작 ▶' 을 눌러 참가자 대기(QR) 화면을 벗어나는 순간 — 아직 결과도,
   * 항목·라벨 편집도 끝나지 않았지만, 참가자를 대기 화면 대신 실제 게임 화면으로 옮겨
   * 호스트가 목록을 채우는 과정과 게임이 진행되는 과정을 실시간으로 함께 보게 한다.
   * status 만 playing 으로 바꿀 뿐 결과 계산은 각 게임의 시작 이벤트가 따로 담당한다.
   */
  async beginGame(roomId: string): Promise<GameType> {
    const room = await this.loadRoomOrThrow(roomId);
    if (!this.isGameType(room.gameType)) {
      throw new GameError(ERROR_CODES.VALIDATION_ERROR); // 아직 game:select 로 종류를 안 골랐다.
    }
    await this.redis.client.hset(RedisKeys.room(roomId), 'status', 'playing');
    await this.rooms.touchRoom(roomId);
    return room.gameType;
  }

  /**
   * 게임 실행 — 선택된 gameType 의 엔진으로 결과를 계산·저장하고 stats +1.
   * 결과는 서버가 한 번만 계산하므로 모든 클라이언트가 같은 결과를 본다(WS4의 핵심).
   */
  async startGame(
    roomId: string,
    options?: Record<string, unknown>,
  ): Promise<{ gameType: GameType; result: GameResult; items: Item[] }> {
    const room = await this.loadRoomOrThrow(roomId);

    const gameType = room.gameType;
    if (!this.isGameType(gameType)) {
      // 아직 game:select 로 종류를 안 골랐다.
      throw new GameError(ERROR_CODES.VALIDATION_ERROR);
    }
    const engine = ENGINES[gameType];
    if (!engine) {
      // 종류는 유효하지만 game:start 로 즉시 실행하는 게임이 아니다(예: vote 는 vote:close).
      throw new GameError(ERROR_CODES.VALIDATION_ERROR);
    }

    const items = this.parseItems(room.items);
    if (items.length < GameService.MIN_ITEMS) {
      throw new GameError(ERROR_CODES.NEED_MORE_ITEMS);
    }

    // options 는 게임별로 쓰인다(예: draw/balloon 의 count = 뽑을 인원 수).
    const result = engine.run(items, options);

    await this.redis.client.hset(RedisKeys.room(roomId), 'status', 'finished');
    await this.saveResult(roomId, result);
    await this.stats.incrementPlays();

    return { gameType, result, items };
  }

  /** 한 판 더 — 결과·투표·사다리를 지우고 대기 상태로 되돌린다. */
  async resetGame(roomId: string): Promise<void> {
    await this.loadRoomOrThrow(roomId);
    await this.redis.client.del(
      RedisKeys.gameResult(roomId),
      RedisKeys.gameVotes(roomId),
      RedisKeys.gameLadder(roomId),
      RedisKeys.gameLadderRevealed(roomId),
      RedisKeys.gameDraw(roomId),
      RedisKeys.gameDrawPicks(roomId),
      RedisKeys.gameBalloon(roomId),
    );
    await this.redis.client.hset(RedisKeys.room(roomId), 'status', 'waiting');
  }

  // ── 사다리타기 (개수 선택형, 네이버 스타일) ─────────────────
  // 룰렛/투표와 달리 game:result 로 안 끝난다. 호스트가 칸마다 상단(이름)·하단(당첨항목)
  // 라벨을 적고 '사다리 시작'(build)을 누르면 서버가 가로줄을 무작위 생성해 전원에게 뿌린다.
  // 이후 호스트가 시작점을 하나씩 눌러 공개(reveal)하거나 '결과 보기'(result)로 한 번에 끝낸다.

  /**
   * 사다리 생성 — 호스트가 보낸 상·하단 라벨 수만큼 칸을 만들고 "구조 + 라벨 스냅샷"을 저장한다.
   *
   * 라벨을 payload 로 받는 이유: 사다리 화면은 방 items 흐름과 분리돼, 칸마다 상단(이름)·
   * 하단(당첨항목) 두 줄을 직접 편집한다. 스냅샷으로 고정 저장해 이후 재접속·늦은 입장도 복원한다.
   * 같은 라벨로 다시 build 하면 사다리를 그대로 재사용하고, 라벨이 바뀌었으면 새로 만든다(옛 공개 무효).
   */
  async buildLadder(
    roomId: string,
    topLabels: string[],
    bottomLabels: string[],
  ): Promise<LadderBuiltPayload> {
    const room = await this.loadRoomOrThrow(roomId);
    if (room.gameType !== 'ladder') {
      throw new GameError(ERROR_CODES.VALIDATION_ERROR);
    }

    const tops = this.normalizeLabels(topLabels);
    const bottoms = this.normalizeLabels(bottomLabels);
    // 상·하단 칸 수가 같아야 하고(각 칸이 위아래 한 쌍), 사다리는 2~10칸.
    if (
      tops.length !== bottoms.length ||
      tops.length < LADDER.MIN ||
      tops.length > LADDER.MAX
    ) {
      throw new GameError(ERROR_CODES.NEED_MORE_ITEMS);
    }

    const existingRaw = await this.redis.client.get(
      RedisKeys.gameLadder(roomId),
    );
    const existing = existingRaw
      ? (JSON.parse(existingRaw) as LadderBuiltPayload)
      : null;

    // 이전 사다리의 라벨과 지금 라벨이 상·하단 모두 같으면 그대로 재사용(시작하기 여러 번 눌러도 고정).
    const reuse =
      existing !== null &&
      this.sameLabels(existing.topLabels, tops) &&
      this.sameLabels(existing.bottomLabels, bottoms);

    const built: LadderBuiltPayload = reuse
      ? existing
      : {
          ladder: generateLadder(tops.length),
          topLabels: tops,
          bottomLabels: bottoms,
        };

    if (!reuse) {
      await this.redis.client.set(
        RedisKeys.gameLadder(roomId),
        JSON.stringify(built),
      );
      // 새 사다리면 옛 공개 기록은 의미 없으므로 지운다.
      await this.redis.client.del(RedisKeys.gameLadderRevealed(roomId));
      await this.redis.client.hset(RedisKeys.room(roomId), 'status', 'playing');
      await this.stats.incrementPlays();
    }
    await this.rooms.touchRoom(roomId);

    return built;
  }

  /**
   * 시작칸 하나 공개 — 저장된 스냅샷(구조+라벨)으로 도착칸과 상·하단 라벨을 돌려주고 공개 목록에 기록한다.
   */
  async revealLadder(
    roomId: string,
    topIndex: number,
  ): Promise<LadderRevealedPayload> {
    const built = await this.loadLadderOrThrow(roomId);
    if (
      !Number.isInteger(topIndex) ||
      topIndex < 0 ||
      topIndex >= built.ladder.columns
    ) {
      throw new GameError(ERROR_CODES.VALIDATION_ERROR);
    }

    await this.redis.client.sadd(
      RedisKeys.gameLadderRevealed(roomId),
      String(topIndex),
    );
    await this.rooms.touchRoom(roomId);

    return this.pairAt(built, topIndex);
  }

  /**
   * '결과 보기' — 전체 시작칸을 한 번에 공개하고 상단→하단 매칭을 통째로 돌려준다.
   * 모든 시작칸을 공개 목록에 넣고 방을 finished 로 넘긴다(한 판 종료).
   */
  async resultLadder(roomId: string): Promise<LadderResultPayload> {
    const built = await this.loadLadderOrThrow(roomId);
    const { columns } = built.ladder;

    const allTops = Array.from({ length: columns }, (_, i) => String(i));
    await this.redis.client.sadd(
      RedisKeys.gameLadderRevealed(roomId),
      ...allTops,
    );
    await this.redis.client.hset(RedisKeys.room(roomId), 'status', 'finished');
    await this.rooms.touchRoom(roomId);

    const pairs = Array.from({ length: columns }, (_, i) =>
      this.pairAt(built, i),
    );
    return { pairs };
  }

  /** 저장된 사다리 스냅샷을 불러온다. 아직 build 전이면 에러. */
  private async loadLadderOrThrow(roomId: string): Promise<LadderBuiltPayload> {
    const raw = await this.redis.client.get(RedisKeys.gameLadder(roomId));
    if (!raw) throw new GameError(ERROR_CODES.VALIDATION_ERROR);
    return JSON.parse(raw) as LadderBuiltPayload;
  }

  /** 시작칸 topIndex 의 도착칸·상하단 라벨을 묶어 준다. */
  private pairAt(
    built: LadderBuiltPayload,
    topIndex: number,
  ): LadderRevealedPayload {
    const bottomIndex = built.ladder.mapping[topIndex];
    return {
      topIndex,
      bottomIndex,
      topLabel: built.topLabels[topIndex] ?? '',
      bottomLabel: built.bottomLabels[bottomIndex] ?? '',
    };
  }

  /** 라벨 배열을 문자열로 정규화(각 칸 trim, 비문자·누락은 빈 문자열). */
  private normalizeLabels(labels: unknown): string[] {
    if (!Array.isArray(labels)) return [];
    return labels.map((l) => (typeof l === 'string' ? l.trim() : ''));
  }

  /** 라벨 배열이 순서까지 같은지(사다리 재사용 판별용). */
  private sameLabels(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }

  // ── 투표(vote) ────────────────────────────────────────────
  // 룰렛처럼 즉시 끝나지 않고 "참가자가 하나씩 던지고 host 가 마감"하는 흐름이라
  // 별도 메서드로 둔다. 표는 game:{id}:votes(socket.id→itemId) 에 쌓인다.
  //
  // 투표자 키는 닉네임이 아니라 socket.id 다: 닉네임을 키로 쓰면 닉네임만 바꿔
  // 재입장해 옛 표를 남기는 식으로 중복 투표가 가능하다. socket.id 는 연결당 고정이라
  // 한 소켓은 1표만 갖고, 끊기면 removeVote 로 정리된다.

  /**
   * 참가자 1표 반영 → 갱신된 집계 반환.
   * voter(=socket.id)를 키로 HSET 하므로 한 소켓당 1표이고, 다시 던지면 표가 이동한다.
   */
  async castVote(
    roomId: string,
    voter: string,
    itemId: string | undefined,
  ): Promise<VoteTallyEntry[]> {
    const room = await this.loadRoomOrThrow(roomId);
    if (room.gameType !== 'vote') {
      throw new GameError(ERROR_CODES.VALIDATION_ERROR);
    }
    if (room.status === 'finished') {
      // 이미 마감된 투표엔 던질 수 없다.
      throw new GameError(ERROR_CODES.VALIDATION_ERROR);
    }

    const items = this.parseItems(room.items);
    if (!itemId || !items.some((it) => it.id === itemId)) {
      throw new GameError(ERROR_CODES.VALIDATION_ERROR);
    }

    await this.redis.client.hset(RedisKeys.gameVotes(roomId), voter, itemId);
    await this.rooms.touchRoom(roomId); // 활동 발생 → 방·투표 키 TTL 리셋

    return this.voteEngine.tally(items, await this.loadChoices(roomId));
  }

  /**
   * host 투표 마감 → 집계 확정 + 최다 득표 결과 저장, stats +1.
   * 결과는 서버가 한 번만 계산해 game:result 로 전원에게 broadcast 된다(모두 같은 결과).
   */
  async closeVote(roomId: string): Promise<VoteResult> {
    const room = await this.loadRoomOrThrow(roomId);
    if (room.gameType !== 'vote') {
      throw new GameError(ERROR_CODES.VALIDATION_ERROR);
    }

    const items = this.parseItems(room.items);
    if (items.length < GameService.MIN_ITEMS) {
      throw new GameError(ERROR_CODES.NEED_MORE_ITEMS);
    }

    const result = this.voteEngine.close(items, await this.loadChoices(roomId));

    await this.redis.client.hset(RedisKeys.room(roomId), 'status', 'finished');
    await this.saveResult(roomId, result);
    // host 가 "마감" 을 두 번 눌러도 한 판은 한 판 — finished 로 처음 넘어갈 때만 집계한다.
    if (room.status !== 'finished') {
      await this.stats.incrementPlays();
    }

    return result;
  }

  /**
   * 소켓이 끊길 때 그 소켓의 표를 지운다 → 표가 실제로 지워졌고 투표 진행 중이면
   * 갱신된 집계를 반환(게이트웨이가 broadcast), 아니면 null.
   */
  async removeVote(
    roomId: string,
    voter: string,
  ): Promise<VoteTallyEntry[] | null> {
    const removed = await this.redis.client.hdel(
      RedisKeys.gameVotes(roomId),
      voter,
    );
    if (removed === 0) return null; // 이 소켓은 투표한 적 없음

    const room = await this.redis.client.hgetall(RedisKeys.room(roomId));
    // 방이 사라졌거나 이미 마감됐으면 굳이 갱신을 쏘지 않는다.
    if (room.gameType !== 'vote' || room.status === 'finished') return null;

    const items = this.parseItems(room.items);
    return this.voteEngine.tally(items, await this.loadChoices(roomId));
  }

  /** votes 해시의 값(각 투표자가 고른 itemId)만 뽑아온다. */
  private async loadChoices(roomId: string): Promise<string[]> {
    return this.redis.client.hvals(RedisKeys.gameVotes(roomId));
  }

  // ── 제비뽑기 (인터랙티브, 잠금형) ─────────────────────────────
  // 호스트가 인원수(제비 개수 N)·꽝 개수 K 를 정하고 "제비 섞기"(shuffle)를 누르면
  // 서버가 K개의 꽝 위치를 무작위 배치한다. 방장·참가자가 각자 제비를 뽑고(pick),
  // 먼저 뽑힌 제비는 HSETNX 로 잠긴다(중복 불가). 뽑는 순간 그 제비의 꽝 여부가 공개된다.

  /**
   * 제비 섞기 — N개 제비 중 K개를 꽝으로 무작위 배치하고 새 라운드를 연다(옛 뽑기 기록 삭제).
   * 꽝 위치(blankSet)는 서버에만 저장하고 클라이언트엔 개수만 알린다(뽑기 전 스포일러 방지).
   */
  async shuffleDraw(
    roomId: string,
    count: number,
    blanks: number,
  ): Promise<DrawShuffledPayload> {
    const room = await this.loadRoomOrThrow(roomId);
    if (room.gameType !== 'draw') {
      throw new GameError(ERROR_CODES.VALIDATION_ERROR);
    }

    // 이미 라운드가 있으면, 제비를 다 뽑기 전엔 다시 섞을 수 없다(진행 중 리셋 방지).
    const existingRaw = await this.redis.client.get(RedisKeys.gameDraw(roomId));
    if (existingRaw) {
      const prev = JSON.parse(existingRaw) as { count: number };
      const picked = await this.redis.client.hlen(
        RedisKeys.gameDrawPicks(roomId),
      );
      if (picked < prev.count) throw new GameError(ERROR_CODES.GAME_RUNNING);
    }

    const c = Math.min(DRAW.MAX, Math.max(DRAW.MIN, Math.floor(count)));
    // 꽝은 최소 1개, 최대 c-1개(전부 꽝이면 뽑을 이유가 없다).
    const b = Math.min(c - 1, Math.max(1, Math.floor(blanks)));

    // 1인당 뽑기 상한 — 제비수(c)가 참가자수(people)보다 많으면 참가자도 복수개를 뽑을 수 있게
    // 상한을 올린다. perPick = ceil(제비수 / 사람수). 제비수 ≤ 사람수면 1(1인 1제비)로 수렴한다.
    // 사람수는 섞는 시점의 참가자 수로 고정한다(이후 입퇴장에도 라운드 규칙이 흔들리지 않게).
    // 호스트는 이 상한과 무관하게 여러 개 뽑을 수 있다.
    const people = await this.redis.client.scard(RedisKeys.roomPlayers(roomId));
    const perPick = Math.max(1, Math.ceil(c / Math.max(1, people)));

    // [0..c-1] 을 섞어 앞의 b개를 꽝 위치로.
    const order = Array.from({ length: c }, (_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [order[i], order[j]] = [order[j], order[i]];
    }
    const blankSet = order.slice(0, b).sort((x, y) => x - y);

    await this.redis.client.set(
      RedisKeys.gameDraw(roomId),
      JSON.stringify({ count: c, blanks: b, blankSet, perPick }),
    );
    // 새 라운드 — 옛 뽑기 기록을 지운다.
    await this.redis.client.del(RedisKeys.gameDrawPicks(roomId));
    await this.redis.client.hset(RedisKeys.room(roomId), 'status', 'playing');
    await this.stats.incrementPlays();
    await this.rooms.touchRoom(roomId);

    return { count: c, blanks: b, perPick };
  }

  /**
   * 제비 뽑기 — index 제비를 by(닉네임/'호스트')가 잠근다.
   * HSETNX 로 원자적 선점: 이미 뽑힌 제비면 0 → GAME_RUNNING(이미 뽑힘)으로 거절.
   * 성공하면 그 제비의 꽝 여부를 공개해 broadcast 하게 반환한다.
   */
  /**
   * 제비 하나 뽑기.
   * - 제비 잠금: HSETNX(index→by) 로 먼저 누른 사람이 선점(중복 뽑기 불가).
   * - 인원 제한: 참가자(비 host)는 한 라운드에 perPick 개까지(섞을 때 정한 1인당 상한).
   *   보통 1(1인 1제비)이지만 제비수 > 사람수면 여러 개 뽑을 수 있다. host 는 제한 없음.
   *   상한에 도달한 닉네임이 더 뽑으면 거절. 빠른 더블클릭 레이스를 막으려고 잠금 뒤 재확인해
   *   상한을 넘긴 제비가 걸리면 방금 잠근 제비를 되돌린다(그 제비는 다시 뽑을 수 있게).
   */
  async pickDraw(
    roomId: string,
    by: string,
    index: number,
    isHost: boolean,
  ): Promise<DrawPick> {
    const raw = await this.redis.client.get(RedisKeys.gameDraw(roomId));
    if (!raw) throw new GameError(ERROR_CODES.VALIDATION_ERROR); // 아직 섞기 전
    const round = JSON.parse(raw) as {
      count: number;
      blanks: number;
      blankSet: number[];
      perPick?: number;
    };
    // 옛 라운드(perPick 저장 전)는 1인 1제비로 안전하게 취급한다.
    const perPick = round.perPick ?? 1;

    if (!Number.isInteger(index) || index < 0 || index >= round.count) {
      throw new GameError(ERROR_CODES.VALIDATION_ERROR);
    }

    const picksKey = RedisKeys.gameDrawPicks(roomId);

    // 참가자는 1인 perPick 제비 — 잠그기 전에 먼저 확인(정상 경로 차단).
    if (!isHost) {
      const already = await this.redis.client.hvals(picksKey);
      if (already.filter((v) => v === by).length >= perPick) {
        throw new GameError(ERROR_CODES.ALREADY_PICKED);
      }
    }

    // 먼저 뽑은 사람이 잠근다(원자적). 이미 있으면 0.
    const locked = await this.redis.client.hsetnx(picksKey, String(index), by);
    if (locked === 0) throw new GameError(ERROR_CODES.GAME_RUNNING); // 이미 뽑힌 제비

    // 잠근 뒤 재확인 — 동시 뽑기 레이스로 상한을 넘겼으면 방금 것을 되돌린다.
    if (!isHost) {
      const vals = await this.redis.client.hvals(picksKey);
      if (vals.filter((v) => v === by).length > perPick) {
        await this.redis.client.hdel(picksKey, String(index));
        throw new GameError(ERROR_CODES.ALREADY_PICKED);
      }
    }

    await this.rooms.touchRoom(roomId);
    return { index, by, blank: round.blankSet.includes(index) };
  }

  /** room:state 복원용 — 섞기 전이면 null, 진행 중이면 개수·꽝수·이미 뽑힌 제비들. */
  async getDrawState(roomId: string): Promise<DrawState | null> {
    const raw = await this.redis.client.get(RedisKeys.gameDraw(roomId));
    if (!raw) return null;
    const round = JSON.parse(raw) as {
      count: number;
      blanks: number;
      blankSet: number[];
      perPick?: number;
    };
    const picksHash = await this.redis.client.hgetall(
      RedisKeys.gameDrawPicks(roomId),
    );
    const picks: DrawPick[] = Object.entries(picksHash).map(([i, by]) => ({
      index: Number(i),
      by,
      blank: round.blankSet.includes(Number(i)),
    }));
    return {
      count: round.count,
      blanks: round.blanks,
      perPick: round.perPick ?? 1,
      picks,
    };
  }

  // ── 풍선 터뜨리기 (러시안 룰렛식, 턴제) ─────────────────────
  // 룰렛/투표와 달리 game:result 로 안 끝난다. 호스트가 풍선 크기(최대 펌프 수)를 정해 시작하면
  // 서버가 1..크기 사이의 비밀 '터지는 순번'을 정한다. 참가자들이 순서대로 가운데 풍선을 한 번씩
  // 펌프하고, 누적 펌프가 그 순번에 도달하는 순간 펌프한 사람이 걸리며(caughtBy) 게임이 끝난다.

  /**
   * 풍선 게임 시작 — 참가자 순서를 스냅샷하고 터지는 순번을 무작위로 정한다.
   * 진행 중(아직 안 걸림)인 게임이 있으면 새로 시작할 수 없다.
   */
  async startBalloon(
    roomId: string,
    total: number,
  ): Promise<BalloonStartedPayload> {
    const room = await this.loadRoomOrThrow(roomId);
    if (room.gameType !== 'balloon') {
      throw new GameError(ERROR_CODES.VALIDATION_ERROR);
    }

    const existing = await this.loadBalloon(roomId);
    if (existing && existing.caughtBy === null) {
      throw new GameError(ERROR_CODES.GAME_RUNNING); // 진행 중엔 재시작 불가
    }

    const turnOrder = await this.redis.client.smembers(
      RedisKeys.roomPlayers(roomId),
    );
    if (turnOrder.length < BALLOON.MIN_PLAYERS) {
      throw new GameError(ERROR_CODES.NEED_MORE_PLAYERS);
    }

    const capacity = Math.min(
      BALLOON.MAX_TOTAL,
      Math.max(BALLOON.MIN_TOTAL, Math.floor(total) || BALLOON.DEFAULT_TOTAL),
    );
    const stored: StoredBalloon = {
      capacity,
      burstAt: randomInt(capacity) + 1, // 비밀 — 1..capacity 째 펌프에 터진다
      pumps: 0,
      turnOrder,
      turnIndex: 0,
      caughtBy: null,
    };
    await this.saveBalloon(roomId, stored);
    await this.redis.client.hset(RedisKeys.room(roomId), 'status', 'playing');
    await this.stats.incrementPlays();
    await this.rooms.touchRoom(roomId);

    return {
      capacity,
      turnOrder,
      turn: turnOrder[0],
    };
  }

  /**
   * 가운데 풍선 한 번 펌프. 현재 턴 참가자만 가능하다(한 턴에 한 번, 곧바로 다음 사람으로 넘어간다).
   * 누적 펌프가 비밀 순번(burstAt)에 도달하면 풍선이 터져 그 사람이 걸리고 게임이 끝난다.
   */
  async popBalloon(
    roomId: string,
    by: string,
  ): Promise<BalloonPoppedPayload> {
    const s = await this.loadBalloon(roomId);
    if (!s) throw new GameError(ERROR_CODES.VALIDATION_ERROR); // 아직 시작 전
    if (s.caughtBy !== null) throw new GameError(ERROR_CODES.VALIDATION_ERROR); // 이미 끝남

    if (s.turnOrder[s.turnIndex] !== by) {
      throw new GameError(ERROR_CODES.NOT_YOUR_TURN);
    }

    s.pumps += 1;

    if (s.pumps >= s.burstAt) {
      // 펑! — 걸림, 게임 종료.
      s.caughtBy = by;
      await this.saveBalloon(roomId, s);
      await this.redis.client.hset(
        RedisKeys.room(roomId),
        'status',
        'finished',
      );
      await this.rooms.touchRoom(roomId);
      return { by, pumps: s.pumps, turn: null, caughtBy: by, burst: true };
    }

    // 안 터짐 — 곧바로 다음(자리에 있는) 참가자로 턴을 넘긴다.
    s.turnIndex = await this.nextTurnIndex(roomId, s);
    await this.saveBalloon(roomId, s);
    await this.rooms.touchRoom(roomId);
    return {
      by,
      pumps: s.pumps,
      turn: s.turnOrder[s.turnIndex],
      caughtBy: null,
      burst: false,
    };
  }

  /** 다음 턴 인덱스 — 방을 떠난 참가자는 건너뛴다(모두 떠났으면 제자리). */
  private async nextTurnIndex(
    roomId: string,
    s: StoredBalloon,
  ): Promise<number> {
    const members = new Set(
      await this.redis.client.smembers(RedisKeys.roomPlayers(roomId)),
    );
    let next = s.turnIndex;
    for (let i = 0; i < s.turnOrder.length; i++) {
      next = (next + 1) % s.turnOrder.length;
      if (members.has(s.turnOrder[next])) return next;
    }
    return next;
  }

  /** 저장된 풍선 상태를 읽는다(없거나 깨지면 null). */
  private async loadBalloon(roomId: string): Promise<StoredBalloon | null> {
    const raw = await this.redis.client.get(RedisKeys.gameBalloon(roomId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as StoredBalloon;
    } catch {
      return null;
    }
  }

  private async saveBalloon(roomId: string, s: StoredBalloon): Promise<void> {
    await this.redis.client.set(
      RedisKeys.gameBalloon(roomId),
      JSON.stringify(s),
    );
  }

  // ── 내부 헬퍼 ─────────────────────────────────────────────

  private async loadRoomOrThrow(
    roomId: string,
  ): Promise<Record<string, string>> {
    const room = await this.redis.client.hgetall(RedisKeys.room(roomId));
    if (Object.keys(room).length === 0) {
      throw new GameError(ERROR_CODES.ROOM_NOT_FOUND);
    }
    return room;
  }

  /** items 를 저장한다(항목 add/remove/reorder 공통). 활동이므로 방 TTL 도 리셋한다. */
  private async saveItems(roomId: string, items: Item[]): Promise<void> {
    await this.redis.client.hset(
      RedisKeys.room(roomId),
      'items',
      JSON.stringify(items),
    );
    await this.rooms.touchRoom(roomId);
  }

  /**
   * 결과를 저장한다(게임 실행·투표 마감 공통). 활동이므로 방 TTL 을 리셋하고,
   * 결과 키도 방과 같은 수명을 줘 방이 사라질 때 함께 없어지게 한다.
   */
  private async saveResult(roomId: string, result: GameResult): Promise<void> {
    await this.redis.client.set(
      RedisKeys.gameResult(roomId),
      JSON.stringify(result),
    );
    await this.rooms.touchRoom(roomId);
    await this.redis.client.expire(
      RedisKeys.gameResult(roomId),
      this.rooms.ttl,
    );
  }

  private parseItems(raw: string | undefined): Item[] {
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (it): it is Item =>
          typeof it === 'object' &&
          it !== null &&
          typeof (it as Item).id === 'string' &&
          typeof (it as Item).label === 'string',
      );
    } catch {
      return [];
    }
  }

  private isGameType(value: string | undefined): value is GameType {
    return !!value && (GAME_TYPES as readonly string[]).includes(value);
  }
}
