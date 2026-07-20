import { Module } from '@nestjs/common';
import { GameService } from './game.service';
import { GameGateway } from './game.gateway';
import { StatsModule } from '../stats/stats.module';

@Module({
  imports: [StatsModule], // 게임 실행 시 stats.total_plays 증가
  providers: [GameService, GameGateway],
  exports: [GameService],
})
export class GameModule {}
