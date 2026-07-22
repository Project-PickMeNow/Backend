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
import { BALLOON } from '../../common/constants/balloon';
import { DRAW } from '../../common/constants/draw';
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

      // 대기 중에만 참가자 슬롯을 비운다. 게임 진행 중(playing/finished)에는 새로고침·일시
      // 끊김으로 슬롯을 잃으면 입장 잠금(ROOM_LOCKED)에 막혀 다시 못 들어오므로, 슬롯을
      // 유지해 재접속(reclaim)을 허용한다 — 온라인 카운트만 갱신한다.
      if (nickname) {
        const status = await this.roomService.getStatus(roomId);
        if (status === 'waiting') {
          const { participants, participantCount } =
            await this.roomService.removeParticipant(roomId, nickname);
          this.server.to(roomId).emit('participant:left', {
            nickname,
            participants,
            participantCount,
          });
          await this.emitReady(roomId);
        }
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
    payload: { nickname?: string; password?: string },
  ): Promise<{ ok: true } | { ok: false; code: string }> {
    const { roomId } = client.data;
    const nickname = payload?.nickname?.trim();

    if (!roomId) return this.fail(client, ERROR_CODES.ROOM_NOT_FOUND);
    if (!nickname) return this.fail(client, ERROR_CODES.VALIDATION_ERROR);
    // '호스트'는 호스트를 나타내는 예약어(제비뽑기·풍선 턴 순서)라 참가자 닉네임으로 쓸 수 없다.
    // (풍선 턴 순서에 호스트가 '호스트'로 포함되므로 같은 이름의 참가자가 있으면 턴 판정이 꼬인다.)
    // 예약어 방어: '호스트'(턴 순서)·'미선택'(제비뽑기 자동 공개 표기)은 참가자 닉네임으로 쓸 수 없다.
    if (nickname === BALLOON.HOST_NAME || nickname === DRAW.UNSELECTED) {
      return this.fail(client, ERROR_CODES.NICKNAME_TAKEN);
    }

    // 같은 닉네임으로 다시 눌러도 성공으로 취급(멱등) — 이미 통과한 소켓이라 비밀번호 재검증 생략.
    const previous = client.data.nickname;
    if (previous === nickname) return { ok: true };

    // 비밀방이면 입장 비밀번호를 먼저 검증한다(자유방은 항상 통과). 호스트는 hostToken 으로
    // 이미 이 방의 주인임이 확인됐으므로(handleConnection) 비밀번호를 요구하지 않는다.
    if (client.data.role !== 'host') {
      const ok = await this.roomService.verifyJoinPassword(
        roomId,
        payload?.password,
      );
      if (!ok) return this.fail(client, ERROR_CODES.WRONG_PASSWORD);
    }

    // 게임 진행 중(대기 상태가 아님)에는 신규 참가자 입장을 막는다.
    // 단, 이미 이 방의 멤버였던 사람(새로고침·재접속)은 그대로 다시 들어올 수 있어야 한다.
    const status = await this.roomService.getStatus(roomId);
    if (status !== 'waiting') {
      const alreadyMember = await this.roomService.isParticipant(
        roomId,
        nickname,
      );
      if (!alreadyMember) return this.fail(client, ERROR_CODES.ROOM_LOCKED);
    }

    // 새 닉네임을 먼저 확보한다. 실패(다른 소켓이 선점)하면 옛 슬롯은 건드리지 않아야
    // 사용자가 아무 데도 못 남는 상황을 피할 수 있다 → 순서상 add 를 remove 보다 앞에 둔다.
    const add = await this.roomService.addParticipant(roomId, nickname);
    if (add.status === 'full') return this.fail(client, ERROR_CODES.ROOM_FULL);
    if (add.status === 'taken') {
      // 게임 중에는 신규 입장이 이미 막혀 있어(위 ROOM_LOCKED), 같은 닉네임 요청은
      // 그 닉네임 주인의 재접속(reclaim)으로 보고 통과시킨다. 대기 중에는 중복 선택
      // 방지를 위해 그대로 거절한다.
      if (status !== 'waiting') {
        client.data.nickname = nickname;
        this.server.to(roomId).emit('participant:joined', {
          nickname,
          participants: add.participants,
          participantCount: add.participantCount,
        });
        return { ok: true };
      }
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
    // 대기 중(로비)에 들어온 참가자는 다음 게임 준비 완료로 본다 — 게임 시작 게이트에 반영한다.
    // (게임 중 재접속(reclaim)은 위에서 따로 처리되어 여기 오지 않으므로 status 는 waiting 이다.)
    if (status === 'waiting') {
      await this.roomService.markReady(roomId, nickname);
      await this.emitReady(roomId);
    }
    return { ok: true };
  }

  /**
   * 참가자 '방으로 돌아가기' — 게임이 끝난 뒤 로비로 복귀했음을 알린다. ready Set 에 넣어
   * 호스트의 '새 게임 시작' 게이트(전원 복귀)를 통과시킨다. 돌아오지 않으면 60초 뒤 클라이언트가
   * 스스로 나가고(room:leave), 그때 참가자·ready 목록에서 함께 빠진다.
   */
  @SubscribeMessage('room:ready')
  async handleReady(client: AppSocket): Promise<{ ok: boolean }> {
    const { roomId, nickname } = client.data;
    if (roomId && nickname) {
      await this.roomService.markReady(roomId, nickname);
      await this.emitReady(roomId);
    }
    return { ok: true };
  }

  /** 다음 게임 준비 목록(로비로 돌아온 참가자)을 방 전원에게 알린다 — 호스트 UI 가 시작 버튼을 연다. */
  private async emitReady(roomId: string): Promise<void> {
    const ready = await this.roomService.getReady(roomId);
    this.server.to(roomId).emit('room:readyUpdate', { ready });
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
      // 나가면서 준비 목록도 바뀌었으니 호스트에게 갱신을 알린다(자동 퇴장 시 시작 게이트가 열릴 수 있다).
      await this.emitReady(roomId);
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
