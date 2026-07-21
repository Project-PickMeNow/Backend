import { Module } from '@nestjs/common';
import { GameService } from './game.service';
import { GameGateway } from './game.gateway';
import { StatsModule } from '../stats/stats.module';
import { RoomModule } from '../room/room.module';

@Module({
  imports: [
    StatsModule, // 게임 실행 시 stats.total_plays 증가
    RoomModule, // 활동 시 방 TTL 리셋(RoomService.touchRoom) 재사용
  ],
  providers: [GameService, GameGateway],
  exports: [GameService],
})
export class GameModule {}
