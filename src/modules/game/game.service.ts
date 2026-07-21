import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { RedisService } from '../../infra/redis/redis.service';
import { StatsService } from '../stats/stats.service';
import { RedisKeys } from '../../common/constants/redis-keys';
import { ERROR_CODES } from '../../common/constants/error-code';
import { GAME_TYPES, GameType } from '../../common/constants/game-type';
import { Item } from '../room/room.types';
import { GameResult, VoteResult, VoteTallyEntry } from './game.types';
import { ENGINES } from './engines';
import { VoteEngine } from './engines/vote';

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
  ): Promise<{ gameType: GameType; result: GameResult; items: Item[] }> {
    const room = await this.loadRoomOrThrow(roomId);

    const gameType = room.gameType;
    if (!this.isGameType(gameType)) {
      // 아직 game:select 로 종류를 안 골랐다.
      throw new GameError(ERROR_CODES.VALIDATION_ERROR);
    }
    const engine = ENGINES[gameType];
    if (!engine) {
      // 종류는 유효하지만 아직 엔진 미구현(Phase 2 이후).
      throw new GameError(ERROR_CODES.VALIDATION_ERROR);
    }

    const items = this.parseItems(room.items);
    if (items.length < GameService.MIN_ITEMS) {
      throw new GameError(ERROR_CODES.NEED_MORE_ITEMS);
    }

    const result = engine.run(items);

    await this.redis.client.hset(RedisKeys.room(roomId), 'status', 'finished');
    await this.saveResult(roomId, result);
    await this.stats.incrementPlays();

    return { gameType, result, items };
  }

  /** 한 판 더 — 결과·투표를 지우고 대기 상태로 되돌린다. */
  async resetGame(roomId: string): Promise<void> {
    await this.loadRoomOrThrow(roomId);
    await this.redis.client.del(
      RedisKeys.gameResult(roomId),
      RedisKeys.gameVotes(roomId),
    );
    await this.redis.client.hset(RedisKeys.room(roomId), 'status', 'waiting');
  }

  // ── 투표(vote) ────────────────────────────────────────────
  // 룰렛처럼 즉시 끝나지 않고 "참가자가 하나씩 던지고 host 가 마감"하는 흐름이라
  // 별도 메서드로 둔다. 표는 game:{id}:votes(닉네임→itemId) 에 쌓인다.

  /**
   * 참가자 1표 반영 → 갱신된 집계 반환.
   * 닉네임을 키로 HSET 하므로 한 명당 1표이고, 다시 던지면 표가 이동한다(중복 없음).
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

    const key = RedisKeys.gameVotes(roomId);
    await this.redis.client.hset(key, voter, itemId);
    const ttl = await this.redis.client.ttl(RedisKeys.room(roomId));
    if (ttl > 0) await this.redis.client.expire(key, ttl);

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
    await this.stats.incrementPlays();

    return result;
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

  /** items 를 저장한다. hset 은 기존 키의 TTL 을 건드리지 않아 방 수명이 유지된다. */
  private async saveItems(roomId: string, items: Item[]): Promise<void> {
    await this.redis.client.hset(
      RedisKeys.room(roomId),
      'items',
      JSON.stringify(items),
    );
  }

  /** 결과를 저장하고, 방이 사라질 때 함께 없어지도록 방과 같은 잔여 TTL 을 준다. */
  private async saveResult(roomId: string, result: GameResult): Promise<void> {
    const key = RedisKeys.gameResult(roomId);
    await this.redis.client.set(key, JSON.stringify(result));
    const ttl = await this.redis.client.ttl(RedisKeys.room(roomId));
    if (ttl > 0) await this.redis.client.expire(key, ttl);
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
