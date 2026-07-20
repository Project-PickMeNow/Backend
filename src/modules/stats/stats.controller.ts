import { Controller, Get } from '@nestjs/common';
import { StatsService } from './stats.service';

/**
 * GET /api/stats — 누적 통계 (대시보드).
 * 전역 prefix 'api'는 main.ts 에서 설정.
 */
@Controller('stats')
export class StatsController {
  constructor(private readonly statsService: StatsService) {}

  @Get()
  async getStats() {
    const data = await this.statsService.getStats();
    return { success: true, data };
  }
}
