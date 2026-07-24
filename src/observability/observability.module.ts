import { Global, Module } from '@nestjs/common';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

/**
 * 관측성(Observability) 모듈 — Prometheus 지표 수집·노출.
 * MetricsService 는 다른 곳(요청 기록 미들웨어 등)에서도 쓰므로 @Global 로 열어둔다.
 * HTTP 요청 기록 미들웨어는 configure-app.ts 에서 app.use 로 등록한다
 * (Express 5 라우팅 와일드카드 이슈를 피하고, e2e 와 설정을 공유하기 위함).
 */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class ObservabilityModule {}
