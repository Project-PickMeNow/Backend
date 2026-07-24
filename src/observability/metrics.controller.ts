import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { MetricsService } from './metrics.service';

/**
 * GET /api/metrics — Prometheus 스크랩 엔드포인트.
 * 전역 prefix(/api) 때문에 실제 경로는 /api/metrics 다(Prometheus 스크랩 설정과 일치시킬 것).
 * 응답은 JSON 봉투가 아니라 Prometheus 텍스트 포맷이라 @Res 로 직접 내려준다.
 */
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  async scrape(@Res() res: Response): Promise<void> {
    res.setHeader('Content-Type', this.metrics.contentType);
    res.send(await this.metrics.metrics());
  }
}
