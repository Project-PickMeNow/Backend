import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { RoomService } from './room.service';

/**
 * 방 WebSocket 게이트웨이.
 * 게임 방(roomId)을 Socket.io room으로 매핑 → io.to(roomId).emit(...) 한 줄로 전원 broadcast.
 *
 * 다루는 이벤트 (API 명세 2️⃣):
 *  connection(자동)  — 인증·client.join·room:state
 *  disconnect(자동)  — 탭 닫힘 시 참가자 제거
 *  room:join         — 참가자 입장
 *  room:leave        — 명시적 나가기
 *  room:close        — host 방 종료
 */
@WebSocketGateway({ namespace: '/rooms', cors: true })
export class RoomGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;

  constructor(private readonly roomService: RoomService) {}

  // 연결 수립 시 자동 실행 — TODO: role·token 인증, client.join(roomId), room:state 전송
  handleConnection(_client: Socket) {
    // TODO
  }

  // 연결 종료(탭 닫힘 등) 시 자동 실행 — TODO: players에서 제거, participant:left broadcast
  handleDisconnect(_client: Socket) {
    // TODO
  }

  @SubscribeMessage('room:join')
  handleJoin(_client: Socket, _payload: { nickname: string }) {
    // TODO: players Set 추가, stats +1, participant:joined broadcast
  }

  @SubscribeMessage('room:leave')
  handleLeave(_client: Socket) {
    // TODO
  }

  @SubscribeMessage('room:close')
  handleClose(_client: Socket) {
    // TODO: host 검증, Redis 방 키 삭제, room:closed broadcast
  }
}
