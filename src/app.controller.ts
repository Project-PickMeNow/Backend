import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

/**
 * GET /api/health — 헬스체크 (모니터링·배포·로드밸런서용).
 */
@ApiTags('health')
@Controller('health')
export class AppController {
  @Get()
  @ApiOperation({
    summary: '헬스체크',
    description: '서버 상태·업타임을 반환한다(모니터링·배포·로드밸런서용).',
  })
  @ApiOkResponse({
    description: '정상',
    schema: {
      example: { status: 'ok', uptime: 3600, timestamp: '2026-07-31T00:00:00.000Z' },
    },
  })
  getHealth() {
    return {
      status: 'ok',
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }
}
