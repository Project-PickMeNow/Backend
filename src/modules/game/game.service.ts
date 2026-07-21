import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { RedisService } from '../../infra/redis/redis.service';
import { StatsService } from '../stats/stats.service';
import { RedisKeys } from '../../common/constants/redis-keys';
import { ERROR_CODES } from '../../common/constants/error-code';
import { GAME_TYPES, GameType } from '../../common/constants/game-type';
import { Item } from '../room/room.types';
import { RoomService } from '../room/room.service';
import {
  GameResult,
  LadderBuiltPayload,
  LadderRevealedPayload,
  VoteResult,
  VoteTallyEntry,
} from './game.types';
import { ENGINES } from './engines';
import { VoteEngine } from './engines/vote';
import { generateLadder } from './engines/ladder';
import { LADDER } from '../../common/constants/ladder';

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

  /** 게임 종류 선택 → 확정된 gameType 반환 */
  async selectGame(roomId: string, gameType: string): Promise<GameType> {
    await this.loadRoomOrThrow(roomId);
    if (!this.isGameType(gameType)) {
      throw new GameError(ERROR_CODES.VALIDATION_ERROR);
    }
    await this.redis.client.hset(RedisKeys.room(roomId), 'gameType', gameType);
    return gameType;
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
    );
    await this.redis.client.hset(RedisKeys.room(roomId), 'status', 'waiting');
  }

  // ── 사다리타기 (개수 선택형) ──────────────────────────────
  // 룰렛/투표와 달리 game:result 로 안 끝난다. 호스트가 사다리를 만들고(build)
  // 시작점을 하나씩 눌러 공개(reveal)하며, 참가자도 실시간으로 함께 본다.
  // 하단 라벨은 방 items(호스트가 개수만큼 입력한 결과)를 그대로 쓴다.

  /**
   * 사다리 생성 — items(=하단 라벨) 수만큼 칸을 만들고 구조를 생성·저장한다.
   * 이미 만들어져 있으면 그대로 반환(중복 build 시 사다리가 안 바뀌도록).
   */
  async buildLadder(roomId: string): Promise<LadderBuiltPayload> {
    const room = await this.loadRoomOrThrow(roomId);
    if (room.gameType !== 'ladder') {
      throw new GameError(ERROR_CODES.VALIDATION_ERROR);
    }

    const labels = this.parseItems(room.items).map((it) => it.label);
    if (labels.length < LADDER.MIN || labels.length > LADDER.MAX) {
      // 사다리는 2~10칸. 벗어나면 항목 수 문제로 본다.
      throw new GameError(ERROR_CODES.NEED_MORE_ITEMS);
    }

    // 이미 만든 사다리가 있으면 재사용(시작하기 여러 번 눌러도 사다리는 고정).
    const existing = await this.redis.client.get(RedisKeys.gameLadder(roomId));
    const ladder = existing
      ? (JSON.parse(existing) as LadderBuiltPayload['ladder'])
      : generateLadder(labels.length);

    if (!existing) {
      await this.redis.client.set(
        RedisKeys.gameLadder(roomId),
        JSON.stringify(ladder),
      );
      await this.redis.client.hset(RedisKeys.room(roomId), 'status', 'playing');
      await this.stats.incrementPlays();
    }
    await this.rooms.touchRoom(roomId);

    return { ladder, labels };
  }

  /**
   * 시작칸 하나 공개 — 도착칸과 라벨을 돌려주고 공개 목록에 기록한다.
   * (경로 애니메이션은 프론트가 공유된 사다리 구조로 그린다)
   */
  async revealLadder(
    roomId: string,
    topIndex: number,
  ): Promise<LadderRevealedPayload> {
    const raw = await this.redis.client.get(RedisKeys.gameLadder(roomId));
    if (!raw) throw new GameError(ERROR_CODES.VALIDATION_ERROR); // 아직 안 만듦

    const ladder = JSON.parse(raw) as LadderBuiltPayload['ladder'];
    if (
      !Number.isInteger(topIndex) ||
      topIndex < 0 ||
      topIndex >= ladder.columns
    ) {
      throw new GameError(ERROR_CODES.VALIDATION_ERROR);
    }

    const bottomIndex = ladder.mapping[topIndex];
    const room = await this.loadRoomOrThrow(roomId);
    const labels = this.parseItems(room.items).map((it) => it.label);

    await this.redis.client.sadd(
      RedisKeys.gameLadderRevealed(roomId),
      String(topIndex),
    );
    await this.rooms.touchRoom(roomId);

    return { topIndex, bottomIndex, label: labels[bottomIndex] ?? '' };
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
