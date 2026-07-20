import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { PrismaModule } from './infra/prisma/prisma.module';
import { RedisModule } from './infra/redis/redis.module';
import { RoomModule } from './modules/room/room.module';
import { GameModule } from './modules/game/game.module';
import { StatsModule } from './modules/stats/stats.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }), // .env 전역 로드
    PrismaModule, // PostgreSQL (stats)
    RedisModule, // Redis (게임 데이터)
    RoomModule, // 방 (REST + WS)
    GameModule, // 게임 (WS)
    StatsModule, // 통계 (REST)
  ],
  controllers: [AppController], // health
})
export class AppModule {}
