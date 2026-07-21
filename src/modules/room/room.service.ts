import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, randomInt } from 'node:crypto';
import { RedisService } from '../../infra/redis/redis.service';
import { StatsService } from '../stats/stats.service';
import { CreateRoomDto, CreateRoomResponse } from './dto/create-room.dto';
import { RedisKeys } from '../../common/constants/redis-keys';
import { ERROR_CODES } from '../../common/constants/error-code';

/**
 * 방 서비스 — 방 생성/조회.
 * 방 데이터는 전부 Redis(key: room:{id}), TTL 3일.
 *
 * TTL "활동 시마다 리셋" 은 계획서상 Phase 3 항목이라 아직 넣지 않았다.
 * 지금은 생성 시점에만 TTL 을 건다.
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
    };
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
