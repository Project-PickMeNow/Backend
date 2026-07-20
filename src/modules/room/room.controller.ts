import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { RoomService } from './room.service';
import { CreateRoomDto } from './dto/create-room.dto';

/**
 * 방 REST API.
 *  - POST /api/rooms         방 생성
 *  - GET  /api/rooms/:roomId 방 조회(입장 전)
 * 실시간(입퇴장·게임)은 RoomGateway / GameGateway(WebSocket) 담당.
 */
@Controller('rooms')
export class RoomController {
  constructor(private readonly roomService: RoomService) {}

  @Post()
  async createRoom(@Body() dto: CreateRoomDto) {
    const data = await this.roomService.createRoom(dto);
    return { success: true, data };
  }

  @Get(':roomId')
  async getRoom(@Param('roomId') roomId: string) {
    const data = await this.roomService.getRoomSummary(roomId);
    return { success: true, data };
  }
}
