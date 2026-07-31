import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { StatsService } from './stats.service';

/**
 * GET /api/stats — 누적 통계 (대시보드).
 * 전역 prefix 'api'는 main.ts 에서 설정.
 */
@ApiTags('stats')
@Controller('stats')
export class StatsController {
  constructor(private readonly statsService: StatsService) {}

  @Get()
  @ApiOperation({
    summary: '누적 통계 조회',
    description: '생성된 방 수·플레이된 게임 수 등 누적 통계(PostgreSQL 영구 저장분)를 조회한다.',
  })
  @ApiOkResponse({ description: '통계 조회 성공' })
  async getStats() {
    const data = await this.statsService.getStats();
    return { success: true, data };
  }
}
