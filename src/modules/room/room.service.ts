import { Injectable } from '@nestjs/common';
import { RedisService } from '../../infra/redis/redis.service';
import { StatsService } from '../stats/stats.service';
import { CreateRoomDto, CreateRoomResponse } from './dto/create-room.dto';

/**
 * 방 서비스 — 방 생성/조회, 참가자 입퇴장.
 * 방 데이터는 전부 Redis(key: room:{id}), TTL 3일. 활동 시마다 TTL 리셋.
 * TODO: roomId 생성, hostToken 발급, Redis 저장, TTL 관리 구현
 */
@Injectable()
export class RoomService {
  constructor(
    private readonly redis: RedisService,
    private readonly stats: StatsService,
  ) {}

  /** 방 생성 (POST /api/rooms) → Redis 저장 + stats.total_rooms +1 */
  async createRoom(dto: CreateRoomDto): Promise<CreateRoomResponse> {
    // TODO: roomId(예: A1B2C3) 생성, hostToken 발급, room:{id} 저장(TTL 3일)
    await this.stats.incrementRooms();
    return {
      roomId: 'TODO',
      joinUrl: 'TODO',
      hostToken: 'TODO',
    };
  }

  /** 방 조회 (GET /api/rooms/:roomId) — 입장 전 유효성 확인 */
  async getRoomSummary(roomId: string) {
    // TODO: Redis 조회, 없으면 ROOM_NOT_FOUND / 만료면 ROOM_EXPIRED
    return {
      roomId,
      title: 'TODO',
      status: 'waiting',
      gameType: null,
      participantCount: 0,
    };
  }
}
