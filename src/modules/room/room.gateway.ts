import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { OnModuleDestroy } from '@nestjs/common';
import { Server } from 'socket.io';
import { RoomService } from './room.service';
import { ERROR_CODES } from '../../common/constants/error-code';
import { BALLOON } from '../../common/constants/balloon';
import { DRAW } from '../../common/constants/draw';
import { ROOM } from '../../common/constants/room';
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
export class RoomGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  @WebSocketServer() server: Server;

  // 대기 중 끊긴 참가자의 '유예 후 제거' 타이머. key=`${roomId}:${nickname}`.
  // 같은 닉네임이 유예 안에 재접속하면 취소한다(재접속 판단은 handleJoin 이 담당).
  private readonly pendingLeaves = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  // 호스트(방장)가 끊긴 뒤 '유예 후 방 닫기' 타이머. key=roomId.
  // 유예 안에 host 가 재접속(handleConnection)하면 취소한다.
  private readonly hostLeaves = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  constructor(private readonly roomService: RoomService) {}

  /** 종료 시 걸려 있던 유예 타이머를 모두 정리한다(테스트·정상 종료에 잔여 타이머가 남지 않게). */
  onModuleDestroy(): void {
    for (const timer of this.pendingLeaves.values()) clearTimeout(timer);
    this.pendingLeaves.clear();
    for (const timer of this.hostLeaves.values()) clearTimeout(timer);
    this.hostLeaves.clear();
  }

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

    // 방장이 (재)접속했으면, 걸려 있던 '방 닫기' 유예를 취소한다 — 새로고침·짧은 끊김으로 방이 닫히지 않게.
    if (role === 'host') this.clearHostLeave(roomId);

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

      // 대기 중이라도 슬롯을 곧바로 비우지 않는다. 게임 진행 중(playing/finished)은 원래부터
      // 슬롯을 유지해 재접속(reclaim)을 허용하는데, 대기 중에는 즉시 제거해서 서버 재시작·
      // ping timeout·탭 백그라운드로 잠깐 끊긴 참가자까지 튕겨 나갔다. 이제 대기 중에도
      // 유예를 두고, 유예 안에 같은 닉네임이 재접속하면 제거를 취소한다 — 온라인 카운트만 즉시 갱신한다.
      if (nickname) {
        const status = await this.roomService.getStatus(roomId);
        if (status === 'waiting') this.scheduleLeave(roomId, nickname);
      }

      // 방장(host)이 끊기면 유예 후 방을 닫는다 — 유예 안에 재접속하면 handleConnection 이 취소한다.
      // 방이 닫히면 참가자 전원이 room:closed 로 홈으로 나가며 '방 삭제' 안내를 받는다.
      if (client.data.role === 'host') this.scheduleHostLeave(roomId);

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

    // 강퇴된 참가자는 소켓이 자동 재연결하며 다시 room:join 을 보내도 재입장을 막는다.
    // (host 는 강퇴 대상이 아니므로 검사에서 제외.) 이 검사가 없으면 disconnect 후 곧바로 되살아난다.
    if (
      client.data.role !== 'host' &&
      (await this.roomService.isKicked(roomId, nickname))
    ) {
      return this.fail(client, ERROR_CODES.KICKED);
    }

    // 이 닉네임으로 들어오려는 시도 자체가 '아직 방에 있음'의 신호다 — 대기 중 끊김으로
    // 잡혀 있던 유예 제거 타이머가 있으면 취소한다(재접속으로 튕겨 나가지 않게).
    this.clearPendingLeave(roomId, nickname);

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

    // 방 유효기간 시작 전에는 신규 참가자 입장을 막는다(호스트는 미리 준비할 수 있어 예외).
    // 이미 이 방의 멤버(재접속)도 통과. startAt=0(레거시·즉시 시작)이면 항상 통과.
    if (client.data.role !== 'host') {
      const startAtMs = await this.roomService.getStartAtMs(roomId);
      if (startAtMs > Date.now()) {
        const alreadyMember = await this.roomService.isParticipant(
          roomId,
          nickname,
        );
        if (!alreadyMember) {
          return this.fail(client, ERROR_CODES.ROOM_NOT_STARTED);
        }
      }
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
      // 이미 players 에 있는 닉네임 요청. 진짜 중복(다른 '살아있는' 소켓이 지금 그 닉네임을 쥐고 있음)
      // 일 때만 거절한다. 그 외(게임 중 새로고침, 대기 중 끊김 후 재접속, 서버 재시작 후 재접속)는
      // 슬롯을 그대로 이어받는(reclaim) 정상 흐름이다 — 특히 서버 재시작은 인메모리 유예 맵이 비므로
      // '살아있는 소켓 유무'로 판정해야 재접속이 튕기지 않는다.
      const liveDuplicate =
        status === 'waiting' &&
        (await this.isNicknameHeldByLiveSocket(roomId, nickname, client.id));
      if (liveDuplicate) return this.fail(client, ERROR_CODES.NICKNAME_TAKEN);

      client.data.nickname = nickname;
      this.server.to(roomId).emit('participant:joined', {
        nickname,
        participants: add.participants,
        participantCount: add.participantCount,
      });
      // 대기 중 재접속이면 준비 목록(로비 복귀)도 유지되도록 다시 표시한다(멱등).
      if (status === 'waiting') {
        await this.roomService.markReady(roomId, nickname);
        await this.emitReady(roomId);
      }
      return { ok: true };
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
      // 명시적 나가기는 즉시 제거다 — 혹시 걸려 있던 유예 타이머가 나중에 또 돌지 않게 지운다.
      this.clearPendingLeave(roomId, nickname);
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

  /**
   * host 참가자 강퇴 — 대기(waiting)로 멈춰 게임 시작을 막는 참가자 등을 호스트가 직접 내보낸다.
   * 참가자·ready 목록에서 즉시 빼고(유예 타이머도 정리), 대상 소켓엔 room:kicked 를 보내 홈으로
   * 돌려보낸 뒤 연결을 끊는다. 호스트만 호출할 수 있다.
   */
  @SubscribeMessage('room:kick')
  async handleKick(
    client: AppSocket,
    payload: { nickname?: string },
  ): Promise<{ ok: true } | { ok: false; code: string }> {
    const { roomId, role } = client.data;
    if (!roomId) return this.fail(client, ERROR_CODES.ROOM_NOT_FOUND);
    if (role !== 'host') return this.fail(client, ERROR_CODES.NOT_HOST);
    const nickname = payload?.nickname?.trim();
    if (!nickname) return this.fail(client, ERROR_CODES.VALIDATION_ERROR);

    // 걸려 있던 유예 제거 타이머 정리 후 즉시 제거하고, 바뀐 명단·준비 목록을 방 전원에게 알린다.
    this.clearPendingLeave(roomId, nickname);
    // 강퇴 명단에 올린다 — 소켓을 끊어도 클라이언트가 자동 재연결하며 room:join 으로 되살아나므로,
    // 서버가 이 닉네임의 재입장을 막아야 강퇴가 실제로 유지된다(handleJoin 에서 검사).
    await this.roomService.banKicked(roomId, nickname);
    const { participants, participantCount } =
      await this.roomService.removeParticipant(roomId, nickname);
    this.server
      .to(roomId)
      .emit('participant:left', { nickname, participants, participantCount });
    await this.emitReady(roomId);

    // 강퇴된 참가자의 살아있는 소켓들에 알리고 내보낸다(닉네임으로 찾는다).
    const sockets = await this.server.in(roomId).fetchSockets();
    for (const s of sockets) {
      if ((s.data as AppSocket['data'])?.nickname === nickname) {
        (s.data as AppSocket['data']).nickname = undefined;
        s.emit('room:kicked', { roomId });
        s.disconnect(true);
      }
    }
    return { ok: true };
  }

  /**
   * 대기 중 끊긴 참가자를 유예 시간 뒤에 제거하도록 예약한다.
   * 같은 (방·닉네임) 예약이 이미 있으면 새로 건다. 유예 안에 재접속하면 handleJoin 이 취소한다.
   * 서버 재시작 시 타이머는 사라지지만, 그땐 클라이언트가 재접속하며 재-join 하므로 슬롯은 유지된다.
   */
  private scheduleLeave(roomId: string, nickname: string): void {
    const key = `${roomId}:${nickname}`;
    const existing = this.pendingLeaves.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.pendingLeaves.delete(key);
      void this.finalizeLeave(roomId, nickname);
    }, ROOM.WAITING_LEAVE_GRACE_MS);
    // 이 타이머 하나 때문에 프로세스가 종료를 못 미루도록 한다(테스트·정상 종료에 영향 없게).
    timer.unref?.();
    this.pendingLeaves.set(key, timer);
  }

  /**
   * 지금 이 방에 '살아있는' 다른 소켓이 그 닉네임을 쥐고 있는지 본다.
   * 대기 중 중복 닉네임을 판정할 때, players Set 에 남아 있다는 사실만으로는 재접속·서버 재시작 후
   * 복귀와 진짜 중복을 구분할 수 없어(둘 다 Set 에 있음), 현재 연결된 소켓들의 nickname 으로 판정한다.
   */
  private async isNicknameHeldByLiveSocket(
    roomId: string,
    nickname: string,
    excludeSocketId: string,
  ): Promise<boolean> {
    const sockets = await this.server.in(roomId).fetchSockets();
    return sockets.some(
      (s) =>
        s.id !== excludeSocketId &&
        (s.data as AppSocket['data'])?.nickname === nickname,
    );
  }

  /** 방 종료 시 그 방에 걸린 모든 유예 제거 타이머를 정리한다. */
  private clearRoomLeaves(roomId: string): void {
    const prefix = `${roomId}:`;
    for (const [key, timer] of this.pendingLeaves) {
      if (key.startsWith(prefix)) {
        clearTimeout(timer);
        this.pendingLeaves.delete(key);
      }
    }
  }

  /**
   * 방장(host)이 끊긴 뒤 유예 시간이 지나도 재접속이 없으면 방을 닫도록 예약한다.
   * 유예 안에 host 가 재접속하면 handleConnection 이 clearHostLeave 로 취소한다.
   */
  private scheduleHostLeave(roomId: string): void {
    const existing = this.hostLeaves.get(roomId);
    if (existing) clearTimeout(existing);
    // 유예 시간은 상수(30초)를 기본으로 하되, HOST_GONE_GRACE_MS 환경변수로 재정의할 수 있다(테스트·튜닝용).
    const graceMs =
      Number(process.env.HOST_GONE_GRACE_MS) || ROOM.HOST_GONE_GRACE_MS;
    const timer = setTimeout(() => {
      this.hostLeaves.delete(roomId);
      void this.finalizeHostLeave(roomId);
    }, graceMs);
    timer.unref?.();
    this.hostLeaves.set(roomId, timer);
  }

  /** 걸려 있던 '방 닫기' 유예를 취소한다(host 재접속·명시적 방 종료 시). */
  private clearHostLeave(roomId: string): void {
    const timer = this.hostLeaves.get(roomId);
    if (timer) {
      clearTimeout(timer);
      this.hostLeaves.delete(roomId);
    }
  }

  /**
   * 유예가 다 지나도 방장이 안 돌아왔으면 방을 닫는다 — 참가자 전원이 room:closed 로 홈으로 나가며
   * '방 삭제' 안내를 받는다. 유예 사이 host 가 재접속(살아있는 host 소켓이 있음)했으면 닫지 않는다.
   */
  private async finalizeHostLeave(roomId: string): Promise<void> {
    try {
      const sockets = await this.server.in(roomId).fetchSockets();
      const hostPresent = sockets.some(
        (s) => (s.data as AppSocket['data'])?.role === 'host',
      );
      if (hostPresent) return; // 방장이 유예 안에 돌아왔다 — 방 유지.

      this.clearRoomLeaves(roomId); // 방이 사라지므로 남은 참가자 유예 타이머도 정리한다.
      await this.roomService.closeRoom(roomId);
      this.server.to(roomId).emit('room:closed', { roomId });
      this.server.in(roomId).disconnectSockets(true);
    } catch {
      // 방이 이미 사라졌거나 종료 중이면 무시한다.
    }
  }

  /** 걸려 있던 유예 제거 타이머를 취소한다(재접속·명시적 나가기·방 종료 시). */
  private clearPendingLeave(roomId: string, nickname: string): void {
    const key = `${roomId}:${nickname}`;
    const timer = this.pendingLeaves.get(key);
    if (timer) {
      clearTimeout(timer);
      this.pendingLeaves.delete(key);
    }
  }

  /** 유예가 다 지나도 재접속이 없었을 때 실제로 참가자를 제거한다(여전히 대기 상태일 때만). */
  private async finalizeLeave(roomId: string, nickname: string): Promise<void> {
    try {
      // 유예 사이 게임이 시작됐다면 슬롯을 유지한다(playing/finished 는 reclaim 대상).
      const status = await this.roomService.getStatus(roomId);
      if (status !== 'waiting') return;
      const { participants, participantCount } =
        await this.roomService.removeParticipant(roomId, nickname);
      this.server
        .to(roomId)
        .emit('participant:left', { nickname, participants, participantCount });
      await this.emitReady(roomId);
    } catch {
      // 방이 이미 사라졌거나 종료 중이면 무시한다.
    }
  }

  /** host 방 종료 — Redis 방 키 삭제 후 전원에게 알리고 모두 연결 해제. */
  @SubscribeMessage('room:close')
  async handleClose(
    client: AppSocket,
  ): Promise<{ ok: true } | { ok: false; code: string }> {
    const { roomId, role } = client.data;
    if (!roomId) return this.fail(client, ERROR_CODES.ROOM_NOT_FOUND);
    if (role !== 'host') return this.fail(client, ERROR_CODES.NOT_HOST);

    this.clearRoomLeaves(roomId); // 방이 사라지므로 남은 유예 타이머도 정리한다.
    this.clearHostLeave(roomId); // 명시적 종료 — '방장 끊김' 유예도 정리한다.
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
