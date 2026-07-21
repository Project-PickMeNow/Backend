import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, randomInt } from 'node:crypto';
import { RedisService } from '../../infra/redis/redis.service';
import { StatsService } from '../stats/stats.service';
import { CreateRoomDto, CreateRoomResponse } from './dto/create-room.dto';
import { RedisKeys } from '../../common/constants/redis-keys';
import { ERROR_CODES } from '../../common/constants/error-code';
import { ROOM_CAPACITY } from '../../common/constants/room-capacity';
import { Item, RoomStatePayload } from './room.types';

/**
 * 방 서비스 — 방 생성/조회/참가자.
 * 방 데이터는 전부 Redis(key: room:{id}), TTL 3일.
 * 활동(입장·항목변경·게임실행) 시 touchRoom 으로 TTL 을 다시 리셋한다(활발한 방은 안 사라지게).
 */
@Injectable()
export class RoomService {
  /**
   * roomId 문자셋: 사람이 화면·QR 을 보고 따라 칠 수 있어야 하므로
   * 헷갈리는 글자(0/O, 1/I/L)를 뺀 31자만 쓴다.
   */
  private static readonly ID_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  private static readonly ID_LENGTH = 6;
  /** roomId 충돌 시 재시도 횟수 (31^6 ≈ 8.9억이라 실제로 재시도까지 갈 일은 거의 없다) */
  private static readonly ID_MAX_ATTEMPTS = 5;

  private readonly ttlSeconds: number;
  private readonly frontendBaseUrl: string;

  constructor(
    private readonly redis: RedisService,
    private readonly stats: StatsService,
    private readonly config: ConfigService,
  ) {
    this.ttlSeconds = Number(
      this.config.get<string>('ROOM_TTL_SECONDS', '259200'),
    );
    this.frontendBaseUrl = this.config.get<string>(
      'FRONTEND_BASE_URL',
      'http://localhost:5173',
    );
  }

  /** 요청 정원을 정책 범위[MIN, MAX]로 자르고, 없으면 기본값. */
  private clampCapacity(requested: number | undefined): number {
    if (requested === undefined || Number.isNaN(requested)) {
      return ROOM_CAPACITY.DEFAULT;
    }
    return Math.min(ROOM_CAPACITY.MAX, Math.max(ROOM_CAPACITY.MIN, requested));
  }

  /** 방에 저장된 정원. 필드가 없거나 깨졌으면(구버전 방 등) 기본값으로 안전하게 처리. */
  private async getRoomCapacity(roomId: string): Promise<number> {
    const raw = await this.redis.client.hget(
      RedisKeys.room(roomId),
      'maxParticipants',
    );
    const parsed = raw === null ? NaN : Number(raw);
    return Number.isNaN(parsed) ? ROOM_CAPACITY.DEFAULT : parsed;
  }

  /** 방 생성 (POST /api/rooms) → Redis 저장 + stats.total_rooms +1 */
  async createRoom(dto: CreateRoomDto): Promise<CreateRoomResponse> {
    const roomId = await this.generateUniqueRoomId();
    // host 임을 증명하는 비밀값. 방 종료·항목 변경 등 host 전용 액션에서 검증한다.
    const hostToken = randomBytes(24).toString('base64url');
    const key = RedisKeys.room(roomId);

    // hset 과 expire 를 한 번에 보내, TTL 이 안 걸린 방이 남는 창을 없앤다.
    await this.redis.client
      .multi()
      .hset(key, {
        title: dto.title ?? '',
        hostToken,
        status: 'waiting',
        gameType: dto.gameType ?? '', // Redis Hash 에 null 을 넣을 수 없어 빈 문자열로 둔다
        items: '[]',
        maxParticipants: String(this.clampCapacity(dto.maxParticipants)),
        createdAt: new Date().toISOString(),
      })
      .expire(key, this.ttlSeconds)
      .exec();

    await this.stats.incrementRooms();

    return {
      roomId,
      joinUrl: `${this.frontendBaseUrl}/join/${roomId}`,
      hostToken,
    };
  }

  /**
   * 방 조회 (GET /api/rooms/:roomId) — 입장 전 유효성 확인.
   *
   * 주의: TTL 로 만료된 방은 Redis 에서 키가 통째로 사라져 "없는 방" 과 구분할 수 없다.
   * ROOM_EXPIRED 를 따로 주려면 만료 사실을 남기는 별도 기록이 필요하므로,
   * 지금은 둘 다 ROOM_NOT_FOUND 로 합친다.
   */
  async getRoomSummary(roomId: string) {
    const room = await this.redis.client.hgetall(RedisKeys.room(roomId));

    // hgetall 은 키가 없어도 예외 대신 빈 객체를 돌려준다.
    if (Object.keys(room).length === 0) {
      throw new NotFoundException({
        code: ERROR_CODES.ROOM_NOT_FOUND,
        message: '존재하지 않거나 만료된 방입니다.',
      });
    }

    const participantCount = await this.redis.client.scard(
      RedisKeys.roomPlayers(roomId),
    );

    // hostToken 은 절대 내보내지 않는다 — 이 응답은 참가자도 받는다.
    return {
      roomId,
      title: room.title,
      status: room.status,
      gameType: room.gameType || null,
      participantCount,
      maxParticipants: this.parseCapacity(room.maxParticipants),
    };
  }

  /** hgetall 로 읽은 문자열 정원을 숫자로(없거나 깨지면 기본값). */
  private parseCapacity(raw: string | undefined): number {
    const parsed = raw === undefined ? NaN : Number(raw);
    return Number.isNaN(parsed) ? ROOM_CAPACITY.DEFAULT : parsed;
  }

  // ─────────────────────────────────────────────────────────────
  // 실시간(WebSocket) 지원 — RoomGateway 가 호출. Redis 조작만 담당하고,
  // socket.join·broadcast 같은 소켓 기계장치는 게이트웨이가 맡는다.
  // ─────────────────────────────────────────────────────────────

  /** 방 존재 여부 (connection 검증용) */
  async roomExists(roomId: string): Promise<boolean> {
    return (await this.redis.client.exists(RedisKeys.room(roomId))) === 1;
  }

  /** 방 진행 상태 (waiting|playing|finished). 없으면 'waiting'. */
  async getStatus(roomId: string): Promise<string> {
    const status = await this.redis.client.hget(
      RedisKeys.room(roomId),
      'status',
    );
    return status ?? 'waiting';
  }

  /** 이 닉네임이 이미 이 방의 참가자인지 (게임 중 재접속 허용 판별용) */
  async isParticipant(roomId: string, nickname: string): Promise<boolean> {
    return (
      (await this.redis.client.sismember(
        RedisKeys.roomPlayers(roomId),
        nickname,
      )) === 1
    );
  }

  /** hostToken 이 이 방의 것과 일치하는지 (host 역할 판별) */
  async isHost(
    roomId: string,
    hostToken: string | undefined,
  ): Promise<boolean> {
    if (!hostToken) return false;
    const stored = await this.redis.client.hget(
      RedisKeys.room(roomId),
      'hostToken',
    );
    return stored !== null && stored === hostToken;
  }

  /** connection 직후 접속자에게 보낼 방 전체 스냅샷 (진행 중 사다리 포함 — 재접속·늦은 입장 복원) */
  async getRoomState(roomId: string): Promise<RoomStatePayload> {
    const [
      room,
      participants,
      onlineCount,
      ladderRaw,
      revealedRaw,
      drawRaw,
      drawPicks,
    ] = await Promise.all([
      this.redis.client.hgetall(RedisKeys.room(roomId)),
      this.redis.client.smembers(RedisKeys.roomPlayers(roomId)),
      this.redis.client.scard(RedisKeys.onlineRoom(roomId)),
      this.redis.client.get(RedisKeys.gameLadder(roomId)),
      this.redis.client.smembers(RedisKeys.gameLadderRevealed(roomId)),
      this.redis.client.get(RedisKeys.gameDraw(roomId)),
      this.redis.client.hgetall(RedisKeys.gameDrawPicks(roomId)),
    ]);

    const ladderSnapshot = this.parseLadder(ladderRaw);
    return {
      roomId,
      title: room.title ?? '',
      status: room.status ?? 'waiting',
      gameType: room.gameType || null,
      items: this.parseItems(room.items),
      participants,
      participantCount: participants.length,
      onlineCount,
      maxParticipants: this.parseCapacity(room.maxParticipants),
      ladder: ladderSnapshot.ladder,
      ladderTopLabels: ladderSnapshot.topLabels,
      ladderBottomLabels: ladderSnapshot.bottomLabels,
      ladderRevealed: revealedRaw
        .map((s) => Number(s))
        .filter((n) => Number.isInteger(n)),
      draw: this.parseDraw(drawRaw, drawPicks),
    };
  }

  /**
   * 저장된 제비뽑기 라운드(개수·꽝수·꽝위치) + 뽑힌 제비 해시를 room:state.draw 로 조립한다.
   * 섞기 전이거나 깨져 있으면 null. 꽝 위치(blankSet)는 뽑힌 제비의 blank 판정에만 쓰고 그대로 내보내지 않는다.
   */
  private parseDraw(
    raw: string | null,
    picksHash: Record<string, string>,
  ): RoomStatePayload['draw'] {
    if (!raw) return null;
    try {
      const round = JSON.parse(raw) as {
        count: number;
        blanks: number;
        blankSet: number[];
      };
      const picks = Object.entries(picksHash).map(([i, by]) => ({
        index: Number(i),
        by,
        blank: round.blankSet.includes(Number(i)),
      }));
      return { count: round.count, blanks: round.blanks, picks };
    } catch {
      return null;
    }
  }

  /**
   * 저장된 사다리 스냅샷(구조 + 상·하단 라벨)을 안전하게 파싱한다. 없거나 깨지면 빈 값.
   * game:{id}:ladder 에는 LadderBuiltPayload({ ladder, topLabels, bottomLabels }) 가 통째로 들어있다.
   */
  private parseLadder(raw: string | null): {
    ladder: RoomStatePayload['ladder'];
    topLabels: string[];
    bottomLabels: string[];
  } {
    const empty = { ladder: null, topLabels: [], bottomLabels: [] };
    if (!raw) return empty;
    try {
      const built = JSON.parse(raw) as {
        ladder: RoomStatePayload['ladder'];
        topLabels?: string[];
        bottomLabels?: string[];
      };
      return {
        ladder: built.ladder ?? null,
        topLabels: built.topLabels ?? [],
        bottomLabels: built.bottomLabels ?? [],
      };
    } catch {
      return empty;
    }
  }

  /**
   * 참가자 입장 — 닉네임을 players Set 에 추가.
   * 결과 status 로 게이트웨이가 응답을 정한다:
   *  - 'added' : 입장 성공
   *  - 'taken' : 닉네임 중복(SADD 가 0 반환) → NICKNAME_TAKEN
   *  - 'full'  : 정원 초과 → ROOM_FULL
   */
  async addParticipant(
    roomId: string,
    nickname: string,
  ): Promise<{
    status: 'added' | 'taken' | 'full';
    participants: string[];
    participantCount: number;
  }> {
    const key = RedisKeys.roomPlayers(roomId);

    // 이미 들어와 있는 닉네임의 재요청은 정원과 무관하게 통과시켜야 한다(정원 체크는 신규만).
    const alreadyIn = (await this.redis.client.sismember(key, nickname)) === 1;
    if (!alreadyIn) {
      const [count, cap] = await Promise.all([
        this.redis.client.scard(key),
        this.getRoomCapacity(roomId),
      ]);
      if (count >= cap) {
        return { status: 'full', participants: [], participantCount: count };
      }
    }

    const added = (await this.redis.client.sadd(key, nickname)) === 1;
    if (!added) {
      const participants = await this.redis.client.smembers(key);
      return {
        status: 'taken',
        participants,
        participantCount: participants.length,
      };
    }

    await this.stats.incrementParticipants();
    await this.touchRoom(roomId); // 활동 발생 → TTL 리셋

    const participants = await this.redis.client.smembers(key);
    return {
      status: 'added',
      participants,
      participantCount: participants.length,
    };
  }

  /** 방 TTL(초). 다른 서비스가 결과 키 등에 같은 수명을 줄 때 참조한다. */
  get ttl(): number {
    return this.ttlSeconds;
  }

  /**
   * 활동 발생 시 방 관련 키들의 TTL 을 다시 3일로 리셋한다(활발한 방은 안 사라지게).
   * players·onlineRoom·votes 는 room 이 살아있는 동안만 의미가 있어 같은 수명을 준다.
   */
  async touchRoom(roomId: string): Promise<void> {
    await this.redis.client
      .multi()
      .expire(RedisKeys.room(roomId), this.ttlSeconds)
      .expire(RedisKeys.roomPlayers(roomId), this.ttlSeconds)
      .expire(RedisKeys.onlineRoom(roomId), this.ttlSeconds)
      .expire(RedisKeys.gameVotes(roomId), this.ttlSeconds)
      .expire(RedisKeys.gameLadder(roomId), this.ttlSeconds)
      .expire(RedisKeys.gameLadderRevealed(roomId), this.ttlSeconds)
      .expire(RedisKeys.gameDraw(roomId), this.ttlSeconds)
      .expire(RedisKeys.gameDrawPicks(roomId), this.ttlSeconds)
      .exec();
  }

  /** 참가자 퇴장 — players Set 에서 제거 */
  async removeParticipant(
    roomId: string,
    nickname: string,
  ): Promise<{ participants: string[]; participantCount: number }> {
    await this.redis.client.srem(RedisKeys.roomPlayers(roomId), nickname);
    const participants = await this.redis.client.smembers(
      RedisKeys.roomPlayers(roomId),
    );
    return { participants, participantCount: participants.length };
  }

  /** 소켓 접속 등록 → 이 방의 현재 접속 소켓 수 반환 */
  async addOnline(roomId: string, socketId: string): Promise<number> {
    const key = RedisKeys.onlineRoom(roomId);
    await this.redis.client.sadd(key, socketId);
    // 방이 사라지면 이 Set 도 같이 정리되도록 방 TTL 과 같은 수명을 준다.
    await this.redis.client.expire(key, this.ttlSeconds);
    await this.redis.client.incr(RedisKeys.onlineCount()); // 서비스 전체 접속자(대시보드용)
    return this.redis.client.scard(key);
  }

  /** 소켓 접속 해제 → 이 방의 남은 접속 소켓 수 반환 */
  async removeOnline(roomId: string, socketId: string): Promise<number> {
    await this.redis.client.srem(RedisKeys.onlineRoom(roomId), socketId);
    // 전체 카운터가 음수로 내려가지 않도록 0 에서 멈춘다.
    const total = await this.redis.client.decr(RedisKeys.onlineCount());
    if (total < 0) await this.redis.client.set(RedisKeys.onlineCount(), '0');
    return this.redis.client.scard(RedisKeys.onlineRoom(roomId));
  }

  /** host 방 종료 — 이 방과 관련된 Redis 키를 모두 삭제 */
  async closeRoom(roomId: string): Promise<void> {
    await this.redis.client.del(
      RedisKeys.room(roomId),
      RedisKeys.roomPlayers(roomId),
      RedisKeys.onlineRoom(roomId),
      RedisKeys.gameResult(roomId),
      RedisKeys.gameVotes(roomId),
      RedisKeys.gameLadder(roomId),
      RedisKeys.gameLadderRevealed(roomId),
    );
  }

  /** items 필드(JSON 문자열)를 안전하게 Item 배열로 파싱한다. 깨져 있으면 빈 배열. */
  private parseItems(raw: string | undefined): Item[] {
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      // {id, label} 형태만 통과시킨다(구버전·깨진 항목 방어).
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

  /** 아직 쓰이지 않는 roomId 를 뽑는다. */
  private async generateUniqueRoomId(): Promise<string> {
    for (let attempt = 0; attempt < RoomService.ID_MAX_ATTEMPTS; attempt++) {
      const candidate = this.randomRoomId();
      const exists = await this.redis.client.exists(RedisKeys.room(candidate));
      if (!exists) return candidate;
    }
    throw new Error(
      `roomId 생성 실패: ${RoomService.ID_MAX_ATTEMPTS}회 연속 충돌`,
    );
  }

  private randomRoomId(): string {
    let id = '';
    for (let i = 0; i < RoomService.ID_LENGTH; i++) {
      // Math.random 이 아니라 randomInt — 균등 분포가 보장되고 예측이 어렵다.
      id += RoomService.ID_ALPHABET[randomInt(RoomService.ID_ALPHABET.length)];
    }
    return id;
  }
}
