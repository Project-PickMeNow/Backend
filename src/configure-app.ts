import { INestApplication, ValidationPipe } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { MetricsService } from './observability/metrics.service';

/**
 * main.ts(프로덕션)와 e2e 테스트가 공유하는 전역 설정.
 * 여기에 모아두면 "테스트에선 통했는데 배포에선 다르게 동작"하는 어긋남을 막는다.
 * (CORS·포트 리스닝은 프로덕션 전용이라 main.ts 에만 둔다)
 */
export function configureApp(app: INestApplication): void {
  // 모든 REST 경로에 /api prefix
  app.setGlobalPrefix('api');

  // 입력 검증
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // DTO 에 없는 프로퍼티 제거
      forbidNonWhitelisted: true, // 모르는 프로퍼티가 오면 거부
      transform: true, // 페이로드를 DTO 인스턴스로 변환
    }),
  );

  // 에러 응답 봉투 통일: { success: false, error: { code, message } }
  app.useGlobalFilters(new AllExceptionsFilter());

  // HTTP 요청 지표 기록 미들웨어 — 응답이 끝나면(res 'finish') 최종 status·처리시간을
  // Prometheus 지표에 반영한다. Nest 인터셉터 대신 Express 미들웨어로 두어 Express5 라우팅
  // 와일드카드 이슈를 피하고, 예외필터가 상태코드를 확정한 뒤의 최종 status 를 잡는다.
  // route 라벨은 매칭된 라우트 패턴(req.route.path)만 써서 카디널리티 폭증을 막는다(경로의 id 등 미포함).
  try {
    const metrics = app.get(MetricsService, { strict: false });
    app.use((req: Request, res: Response, next: NextFunction) => {
      const stop = metrics.httpDuration.startTimer();
      res.on('finish', () => {
        // req.route 는 Express 타입상 any 라, path 만 안전하게 뽑아 string 으로 확정한다.
        const route =
          (req.route as { path?: string } | undefined)?.path ?? 'unmatched';
        const labels = {
          method: req.method,
          route,
          status: String(res.statusCode),
        };
        stop(labels);
        metrics.httpRequests.inc(labels);
      });
      next();
    });
  } catch {
    // ObservabilityModule 이 없는 최소 테스트 모듈 등에서는 지표 기록을 건너뛴다.
  }
}
