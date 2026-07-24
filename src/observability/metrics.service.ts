import { Injectable } from '@nestjs/common';
import {
  Counter,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

/**
 * Prometheus 지표 레지스트리 — 앱 전역에서 하나만 쓴다(싱글턴 provider).
 *
 * 담는 지표:
 *  - 기본 프로세스 지표(collectDefaultMetrics): CPU·메모리·이벤트루프 지연·GC·핸들 수 등
 *  - http_requests_total          : method·route·status 별 요청 수(Counter)
 *  - http_request_duration_seconds: 요청 처리 시간 히스토그램(latency·에러율 계산용)
 *
 * `/api/metrics` 에서 이 레지스트리를 텍스트로 노출하고, Prometheus 가 스크랩한다.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();
  readonly httpRequests: Counter<string>;
  readonly httpDuration: Histogram<string>;

  constructor() {
    // 모든 지표에 공통 라벨(어떤 앱인지) — Grafana 에서 서비스 구분에 쓴다.
    this.registry.setDefaultLabels({ app: 'pickmenow-backend' });
    collectDefaultMetrics({ register: this.registry });

    this.httpRequests = new Counter({
      name: 'http_requests_total',
      help: 'HTTP 요청 총 개수 (method·route·status 별)',
      labelNames: ['method', 'route', 'status'],
      registers: [this.registry],
    });

    this.httpDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP 요청 처리 시간(초)',
      labelNames: ['method', 'route', 'status'],
      // 웹 API 응답시간 분포에 맞춘 버킷(10ms ~ 5s)
      buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5],
      registers: [this.registry],
    });
  }

  /** Prometheus 텍스트 노출 포맷 */
  metrics(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}
