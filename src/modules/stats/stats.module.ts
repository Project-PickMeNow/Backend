import { Module } from '@nestjs/common';
import { StatsController } from './stats.controller';
import { StatsService } from './stats.service';

@Module({
  controllers: [StatsController],
  providers: [StatsService],
  exports: [StatsService], // room·game 모듈에서 카운터 증가 호출
})
export class StatsModule {}
