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

    // ioredis 클라이언트는 연결 오류를 'error' 이벤트로 낸다. 리스너가 없으면
    // EventEmitter 규칙상 그대로 던져져 프로세스가 죽을 수 있다(특히 종료 중 "Connection is closed").
    // 여기서 받아 로깅만 하고 삼킨다 — ioredis 가 재연결은 알아서 시도한다.
    this._client.on('error', (err: Error) => {
      console.error(`[redis] ${err.message}`);
    });
  }

  async onModuleDestroy() {
    // 종료는 best-effort. 이미 연결이 닫히는 중이면 quit() 이 "Connection is closed" 로
    // reject 될 수 있는데, 여기서 던지면 앱 종료(테스트의 app.close 포함)가 통째로 실패한다.
    // 실패해도 강제로 소켓만 끊고 넘어간다.
    try {
      await this._client?.quit();
    } catch {
      this._client?.disconnect();
    }
  }

  /** 원시 Redis 클라이언트 (서비스에서 직접 명령 실행) */
  get client(): Redis {
    return this._client;
  }
}
