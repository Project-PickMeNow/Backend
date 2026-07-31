import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { RoomService } from './room.service';
import { CreateRoomDto } from './dto/create-room.dto';

/**
 * 방 REST API.
 *  - POST /api/rooms         방 생성
 *  - GET  /api/rooms/:roomId 방 조회(입장 전)
 * 실시간(입퇴장·게임)은 RoomGateway / GameGateway(WebSocket) 담당.
 */
@ApiTags('rooms')
@Controller('rooms')
export class RoomController {
  constructor(private readonly roomService: RoomService) {}

  @Post()
  @ApiOperation({
    summary: '방 생성',
    description:
      '호스트가 방을 만든다. 응답의 joinUrl(QR)·참여 코드로 참가자가 각자 폰에서 입장한다. hostToken 은 호스트 인증용.',
  })
  @ApiCreatedResponse({
    description: '방 생성 성공',
    schema: {
      example: {
        success: true,
        data: {
          roomId: 'ROOM12',
          joinUrl: 'https://pickmenow.co.kr/join/ROOM12',
          hostToken: 'Qxb95WeruH1MD3rR8eaC_rBx4Qwt6pMR',
        },
      },
    },
  })
  async createRoom(@Body() dto: CreateRoomDto) {
    const data = await this.roomService.createRoom(dto);
    return { success: true, data };
  }

  @Get(':roomId')
  @ApiOperation({
    summary: '방 조회(입장 전)',
    description: '참여 코드로 방의 기본 정보(게임 종류·정원·비밀방 여부 등)를 조회한다.',
  })
  @ApiParam({ name: 'roomId', description: '참여 코드', example: 'ROOM12' })
  @ApiOkResponse({ description: '방 조회 성공' })
  async getRoom(@Param('roomId') roomId: string) {
    const data = await this.roomService.getRoomSummary(roomId);
    return { success: true, data };
  }
}
