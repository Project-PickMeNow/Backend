import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { join } from 'node:path';
import pino from 'pino';
import { LoggerModule } from 'nestjs-pino';
import { AppController } from './app.controller';
import { PrismaModule } from './infra/prisma/prisma.module';
import { RedisModule } from './infra/redis/redis.module';
import { RoomModule } from './modules/room/room.module';
import { GameModule } from './modules/game/game.module';
import { StatsModule } from './modules/stats/stats.module';
import { ObservabilityModule } from './observability/observability.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }), // .env 전역 로드
    // 구조화(JSON) 로깅 — 표준출력 + logs/app.log 두 곳에 남긴다.
    // Promtail 이 logs/app.log 를 tail 해서 Loki 로 보낸다(Grafana 에서 조회).
    LoggerModule.forRoot({
      pinoHttp: [
        {
          level: process.env.LOG_LEVEL ?? 'info',
          // 요청/응답 자동 로깅(method·url·status·응답시간). 스크랩·헬스 소음은 제외.
          autoLogging: {
            ignore: (req) =>
              req.url === '/api/metrics' || req.url === '/api/health',
          },
          // 민감 헤더는 로그에서 가린다
          redact: ['req.headers.authorization', 'req.headers.cookie'],
        },
        pino.multistream([
          { stream: process.stdout },
          {
            stream: pino.destination({
              dest: join(process.cwd(), 'logs', 'app.log'),
              mkdir: true,
              sync: false,
            }),
          },
        ]),
      ],
    }),
    ObservabilityModule, // Prometheus 지표(/api/metrics)
    PrismaModule, // PostgreSQL (stats)
    RedisModule, // Redis (게임 데이터)
    RoomModule, // 방 (REST + WS)
    GameModule, // 게임 (WS)
    StatsModule, // 통계 (REST)
  ],
  controllers: [AppController], // health
})
export class AppModule {}
