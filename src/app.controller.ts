import { Controller, Get } from '@nestjs/common';

/**
 * GET /api/health — 헬스체크 (모니터링·배포·로드밸런서용).
 */
@Controller('health')
export class AppController {
  @Get()
  getHealth() {
    return {
      status: 'ok',
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }
}
