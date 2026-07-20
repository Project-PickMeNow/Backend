import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Redis 연결 (ioredis).
 * 게임 데이터 전부(방 상태·참가자·결과·접속자)를 여기 저장. TTL 3일.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private _client: Redis;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    this._client = new Redis({
      host: this.config.get<string>('REDIS_HOST', 'localhost'),
      port: this.config.get<number>('REDIS_PORT', 6379),
    });
  }

  async onModuleDestroy() {
    await this._client?.quit();
  }

  /** 원시 Redis 클라이언트 (서비스에서 직접 명령 실행) */
  get client(): Redis {
    return this._client;
  }
}
