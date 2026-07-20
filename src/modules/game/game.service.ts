import { Injectable } from '@nestjs/common';
import { RedisService } from '../../infra/redis/redis.service';
import { StatsService } from '../stats/stats.service';
import { GameType } from '../../common/constants/game-type';

/**
 * 게임 서비스 — 항목 관리, 게임 실행(결과 계산), 투표 집계.
 * 항목·결과는 전부 Redis. 게임 실행 시 stats.total_plays +1.
 * TODO: engines 연결, Redis 항목/결과 저장, 투표 집계
 */
@Injectable()
export class GameService {
  constructor(
    private readonly redis: RedisService,
    private readonly stats: StatsService,
  ) {}

  /** 게임 실행 → 결과 계산·저장, stats +1 */
  async startGame(roomId: string, gameType: GameType) {
    // TODO: items 로드 → ENGINES[gameType].run(items) → game:{id}:result 저장
    await this.stats.incrementPlays();
    return { type: gameType };
  }
}
