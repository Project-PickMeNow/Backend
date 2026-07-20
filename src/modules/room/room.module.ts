import { Module } from '@nestjs/common';
import { RoomController } from './room.controller';
import { RoomService } from './room.service';
import { RoomGateway } from './room.gateway';
import { StatsModule } from '../stats/stats.module';

@Module({
  imports: [StatsModule], // 참가자 입장 시 stats 카운터 증가
  controllers: [RoomController],
  providers: [RoomService, RoomGateway],
  exports: [RoomService],
})
export class RoomModule {}
