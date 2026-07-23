import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { configureApp } from './configure-app';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  // prefix·검증·에러필터 (e2e 와 공유하는 전역 설정)
  configureApp(app);

  // 프론트(Vercel/로컬)에서 접근 허용.
  // CORS_ORIGIN 은 콤마로 여러 도메인을 줄 수 있다(예: apex 와 www 둘 다 허용).
  //   CORS_ORIGIN=https://pickmenow.co.kr,https://www.pickmenow.co.kr
  const corsOrigins = config
    .get<string>('CORS_ORIGIN', 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({
    origin: corsOrigins,
    credentials: true,
  });

  const port = config.get<number>('PORT', 3000);
  await app.listen(port);
  console.log(`🚀 Backend running on http://localhost:${port}/api`);
}
bootstrap();
