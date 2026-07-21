import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server } from 'socket.io';
import { RoomService } from './room.service';
import { ERROR_CODES } from '../../common/constants/error-code';
import type { AppSocket } from '../../common/types/socket';

/**
 * 방 WebSocket 게이트웨이.
 * 게임 방(roomId)을 Socket.io room 으로 매핑 → io.to(roomId).emit(...) 한 줄로 전원 broadcast.
 *
 * 접속 규약: 클라이언트는 handshake.auth 에 { roomId, hostToken? } 를 실어 접속한다.
 *  - roomId 없거나 없는 방 → error(ROOM_NOT_FOUND) 후 즉시 연결 종료
 *  - hostToken 이 방의 것과 일치 → role=host, 아니면 role=participant
 *  이 판별 결과(socket.data)를 GameGateway 가 host 검증에 그대로 재사용한다.
 */
@WebSocketGateway({ namespace: '/rooms', cors: true })
export class RoomGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;

  constructor(private readonly roomService: RoomService) {}

  /** 연결 수립 시 자동 실행 — 인증 → socket.data 세팅 → room:state 전송 → 접속자 수 broadcast */
  async handleConnection(client: AppSocket): Promise<void> {
    const roomId = this.readAuth(client, 'roomId');
    const hostToken = this.readAuth(client, 'hostToken');

    if (!roomId || !(await this.roomService.roomExists(roomId))) {
      client.emit('error', {
        code: ERROR_CODES.ROOM_NOT_FOUND,
        message: '존재하지 않거나 만료된 방입니다.',
      });
      client.disconnect(true);
      return;
    }

    const role = (await this.roomService.isHost(roomId, hostToken))
      ? 'host'
      : 'participant';

    client.data.roomId = roomId;
    client.data.role = role;
    await client.join(roomId);

    const onlineCount = await this.roomService.addOnline(roomId, client.id);

    // 접속자에게는 방 전체 스냅샷을, 방 전원에게는 갱신된 접속자 수를 알린다.
    client.emit('room:state', await this.roomService.getRoomState(roomId));
    this.server.to(roomId).emit('online:count', { onlineCount });
  }

  /** 연결 종료(탭 닫힘 등) 시 자동 실행 — 접속 해제 + 입장했던 참가자였다면 퇴장 처리 */
  async handleDisconnect(client: AppSocket): Promise<void> {
    const { roomId, nickname } = client.data;
    if (!roomId) return; // 인증 실패로 끊긴 소켓은 정리할 게 없다.

    // 서버 종료 시엔 Redis 가 먼저 닫힌 뒤 이 핸들러가 도는 순서가 될 수 있다.
    // 그때의 정리는 best-effort — 방 키는 어차피 TTL 로 사라지므로 오류를 삼킨다.
    try {
      const onlineCount = await this.roomService.removeOnline(
        roomId,
        client.id,
      );

      if (nickname) {
        const { participants, participantCount } =
          await this.roomService.removeParticipant(roomId, nickname);
        this.server.to(roomId).emit('participant:left', {
          nickname,
          participants,
          participantCount,
        });
      }

      this.server.to(roomId).emit('online:count', { onlineCount });
    } catch {
      // 종료 중 커넥션이 닫힌 경우 — 무시한다.
    }
  }

  /** 참가자 입장 — 닉네임 확정 후 players 에 추가하고 전원에게 알린다. */
  @SubscribeMessage('room:join')
  async handleJoin(
    client: AppSocket,
    payload: { nickname?: string },
  ): Promise<{ ok: true } | { ok: false; code: string }> {
    const { roomId } = client.data;
    const nickname = payload?.nickname?.trim();

    if (!roomId) return this.fail(client, ERROR_CODES.ROOM_NOT_FOUND);
    if (!nickname) return this.fail(client, ERROR_CODES.VALIDATION_ERROR);

    // 같은 닉네임으로 다시 눌러도 성공으로 취급(멱등).
    const previous = client.data.nickname;
    if (previous === nickname) return { ok: true };

    // 새 닉네임을 먼저 확보한다. 실패(다른 소켓이 선점)하면 옛 슬롯은 건드리지 않아야
    // 사용자가 아무 데도 못 남는 상황을 피할 수 있다 → 순서상 add 를 remove 보다 앞에 둔다.
    const add = await this.roomService.addParticipant(roomId, nickname);
    if (add.status === 'full') return this.fail(client, ERROR_CODES.ROOM_FULL);
    if (add.status === 'taken') {
      return this.fail(client, ERROR_CODES.NICKNAME_TAKEN);
    }

    // 이 소켓이 이미 다른 닉네임으로 입장해 있었다면 옛 슬롯을 비워 유령 참가자를 막는다.
    // 최종(옛 닉네임 제거 후) 목록으로 broadcast 해야 카운트가 정확하다.
    let { participants, participantCount } = add;
    if (previous && previous !== nickname) {
      const after = await this.roomService.removeParticipant(roomId, previous);
      participants = after.participants;
      participantCount = after.participantCount;
      this.server.to(roomId).emit('participant:left', {
        nickname: previous,
        participants,
        participantCount,
      });
    }

    client.data.nickname = nickname;
    this.server
      .to(roomId)
      .emit('participant:joined', { nickname, participants, participantCount });
    return { ok: true };
  }

  /** 명시적 나가기 — disconnect 와 달리 소켓은 살아있지만 참가자 목록에서만 뺀다. */
  @SubscribeMessage('room:leave')
  async handleLeave(client: AppSocket): Promise<{ ok: true }> {
    const { roomId, nickname } = client.data;
    if (roomId && nickname) {
      const { participants, participantCount } =
        await this.roomService.removeParticipant(roomId, nickname);
      client.data.nickname = undefined;
      this.server
        .to(roomId)
        .emit('participant:left', { nickname, participants, participantCount });
    }
    return { ok: true };
  }

  /** host 방 종료 — Redis 방 키 삭제 후 전원에게 알리고 모두 연결 해제. */
  @SubscribeMessage('room:close')
  async handleClose(
    client: AppSocket,
  ): Promise<{ ok: true } | { ok: false; code: string }> {
    const { roomId, role } = client.data;
    if (!roomId) return this.fail(client, ERROR_CODES.ROOM_NOT_FOUND);
    if (role !== 'host') return this.fail(client, ERROR_CODES.NOT_HOST);

    await this.roomService.closeRoom(roomId);
    this.server.to(roomId).emit('room:closed', { roomId });
    this.server.in(roomId).disconnectSockets(true);
    return { ok: true };
  }

  /** handshake.auth 우선, 없으면 query 에서 문자열 값을 읽는다. */
  private readAuth(client: AppSocket, key: string): string | undefined {
    const fromAuth = (client.handshake.auth as Record<string, unknown>)?.[key];
    const fromQuery = client.handshake.query?.[key];
    const value = fromAuth ?? fromQuery;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  /** error 이벤트를 쏘고, ack 로도 실패 코드를 돌려준다(요청/응답 짝을 맞추기 위해). */
  private fail(client: AppSocket, code: string): { ok: false; code: string } {
    client.emit('error', { code });
    return { ok: false, code };
  }
}
