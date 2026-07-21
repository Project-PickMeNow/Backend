import { INestApplication, ValidationPipe } from '@nestjs/common';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

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
}
