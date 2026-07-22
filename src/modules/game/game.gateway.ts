import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server } from 'socket.io';
import { GameService, GameError } from './game.service';
import { ERROR_CODES } from '../../common/constants/error-code';
import { BALLOON } from '../../common/constants/balloon';
import type { AppSocket } from '../../common/types/socket';

type Ack = { ok: true } | { ok: false; code: string };

/**
 * 게임 WebSocket 게이트웨이 (RoomGateway 와 같은 /rooms 네임스페이스를 공유).
 * connection 때 RoomGateway 가 채워둔 socket.data(roomId·role)를 그대로 읽어 host 를 검증한다
 * — 이벤트마다 hostToken 을 다시 받지 않는다.
 *
 * 다루는 이벤트 (전부 host 전용, vote:cast/draw:pick 만 참가자도 가능):
 *  item:add / item:remove / item:reorder — 항목
 *  game:select / game:begin / game:start / room:return — 게임 진행
 *  vote:cast / vote:start / vote:close / vote:cancel / vote:finalize — 투표(라이프사이클)
 *  ladder:build / ladder:reveal / ladder:result / ladder:draft — 사다리
 *  draw:shuffle / draw:pick / draw:autoresolve / draw:draft — 제비뽑기
 *  roulette:draft — 원판 실시간 편집 미리보기
 */
@WebSocketGateway({ namespace: '/rooms', cors: true })
export class GameGateway implements OnGatewayDisconnect {
  @WebSocketServer() server: Server;

  constructor(private readonly gameService: GameService) {}

  /**
   * 소켓이 끊기면 그 소켓이 던진 표를 정리한다.
   * (RoomGateway 도 같은 네임스페이스에서 handleDisconnect 를 갖지만, 각 게이트웨이의
   *  disconnect 훅은 독립적으로 실행되므로 게임 도메인 정리는 여기서 한다.)
   * 표 키가 socket.id 라, 이 정리가 없으면 재접속 시 옛 표가 남아 중복 집계된다.
   */
  async handleDisconnect(client: AppSocket): Promise<void> {
    const { roomId } = client.data;
    if (!roomId) return;
    // 서버 종료 시 Redis 가 먼저 닫히는 레이스 — 정리는 best-effort.
    try {
      const tally = await this.gameService.removeVote(roomId, client.id);
      if (tally) this.server.to(roomId).emit('vote:updated', { tally });
    } catch {
      // 종료 중 커넥션이 닫힌 경우 — 무시.
    }
  }

  @SubscribeMessage('item:add')
  async handleItemAdd(
    client: AppSocket,
    payload: { label?: string },
  ): Promise<Ack> {
    return this.hostAction(client, async (roomId) => {
      const items = await this.gameService.addItem(roomId, payload?.label);
      this.server.to(roomId).emit('item:added', { items });
    });
  }

  @SubscribeMessage('item:remove')
  async handleItemRemove(
    client: AppSocket,
    payload: { itemId?: string },
  ): Promise<Ack> {
    return this.hostAction(client, async (roomId) => {
      if (!payload?.itemId) throw new GameError(ERROR_CODES.VALIDATION_ERROR);
      const items = await this.gameService.removeItem(roomId, payload.itemId);
      this.server.to(roomId).emit('item:removed', { items });
    });
  }

  @SubscribeMessage('item:reorder')
  async handleItemReorder(
    client: AppSocket,
    payload: { order?: string[] },
  ): Promise<Ack> {
    return this.hostAction(client, async (roomId) => {
      if (!Array.isArray(payload?.order)) {
        throw new GameError(ERROR_CODES.VALIDATION_ERROR);
      }
      const items = await this.gameService.reorderItems(roomId, payload.order);
      this.server.to(roomId).emit('item:reordered', { items });
    });
  }

  @SubscribeMessage('game:select')
  async handleGameSelect(
    client: AppSocket,
    payload: { gameType?: string },
  ): Promise<Ack> {
    return this.hostAction(client, async (roomId) => {
      const gameType = await this.gameService.selectGame(
        roomId,
        payload?.gameType ?? '',
      );
      this.server.to(roomId).emit('game:selected', { gameType });
    });
  }

  /**
   * host '게임 시작 ▶' — 아직 결과는 없지만 참가자를 대기(QR) 화면에서 실제 게임 화면으로
   * 옮겨, 이후 호스트가 항목·라벨을 채우는 과정과 게임이 진행되는 과정을 실시간으로 보게 한다.
   */
  @SubscribeMessage('game:begin')
  async handleGameBegin(client: AppSocket): Promise<Ack> {
    return this.hostAction(client, async (roomId) => {
      const gameType = await this.gameService.beginGame(roomId);
      this.server.to(roomId).emit('game:begin', { gameType });
      // 새 라운드 — 서버가 준비 목록을 비웠음을 전원에 반영(다음 게임 종료 후의 복귀를 새로 센다).
      this.server.to(roomId).emit('room:readyUpdate', { ready: [] });
    });
  }

  @SubscribeMessage('game:start')
  async handleGameStart(
    client: AppSocket,
    payload?: { options?: Record<string, unknown> },
  ): Promise<Ack> {
    return this.hostAction(client, async (roomId) => {
      const { gameType, result } = await this.gameService.startGame(
        roomId,
        payload?.options,
      );
      // 계산이 끝났음을 먼저 알리고(애니메이션 시작 신호), 이어서 결과를 전원 동시 전달.
      this.server.to(roomId).emit('game:started', { gameType });
      this.server.to(roomId).emit('game:result', { result });
    });
  }

  /**
   * host '방으로 돌아가기' / 게임 설정 단계 뒤로가기 — 라운드를 접어(결과·투표·사다리·제비 데이터
   * 삭제) 방을 다시 대기 상태로 되돌린다.
   *  - notify=true (설정 단계에서 좌측 화살표로 게임 취소): game:cancelled 로 참가자 전원을 로비로
   *    함께 끌어온다(참가자는 안내를 띄우고 room:ready 로 복귀 표시). 참가자가 게임에 갇히는 걸 막는다.
   *  - notify 없음 (결과 후 '방으로 돌아가기'): 참가자를 강제 이동시키지 않는다 — 각자 결과창의
   *    '방으로 돌아가기'로 로비에 온다(1분 내 안 오면 클라이언트가 강퇴 안내).
   * room 이벤트지만 GameService.resetGame 재사용을 위해 여기 둔다(RoomModule↔GameModule 순환 의존 회피).
   */
  @SubscribeMessage('room:return')
  async handleRoomReturn(
    client: AppSocket,
    payload?: { notify?: boolean },
  ): Promise<Ack> {
    return this.hostAction(client, async (roomId) => {
      await this.gameService.resetGame(roomId);
      // 게임 취소(설정 단계 뒤로가기)일 때만 참가자 전원을 로비로 끌어온다. 발신자(호스트)는
      // 스스로 이미 로비로 돌아가므로 제외하고 참가자에게만 알린다.
      if (payload?.notify) client.broadcast.to(roomId).emit('game:cancelled');
    });
  }

  /**
   * host 원판 실시간 편집 미리보기 — 저장하지 않는 일회성 relay. 호스트가 원판 칸에
   * 타이핑하는 동안 참가자도 같은 라벨을 실시간으로 보게 한다('돌리기'를 눌러야 items 로 확정된다).
   */
  @SubscribeMessage('roulette:draft')
  async handleRouletteDraft(
    client: AppSocket,
    payload: { labels?: string[] },
  ): Promise<Ack> {
    return this.hostAction(client, (roomId) => {
      const labels = Array.isArray(payload?.labels)
        ? payload.labels.filter((l): l is string => typeof l === 'string')
        : [];
      client.broadcast.to(roomId).emit('roulette:draft', { labels });
      return Promise.resolve();
    });
  }

  /**
   * host 순서 정하기 항목 실시간 미리보기 — 저장하지 않는 relay. 호스트가 항목을 입력하는 동안
   * 참가자도 '입력 중' 항목을 실시간으로 본다(Enter/＋ 로 커밋하면 item:add 로 확정 공유).
   * roulette:draft 와 같은 패턴 — 발신자(호스트) 제외하고 방 전원에게 relay.
   */
  @SubscribeMessage('order:draft')
  async handleOrderDraft(
    client: AppSocket,
    payload: { label?: string },
  ): Promise<Ack> {
    return this.hostAction(client, (roomId) => {
      const label = typeof payload?.label === 'string' ? payload.label : '';
      client.broadcast.to(roomId).emit('order:draft', { label });
      return Promise.resolve();
    });
  }

  /**
   * 사다리 편집 실시간 미리보기 — 저장하지 않는 relay. 호스트가 목록(상단 이름·하단 당첨항목)을
   * 정하는 동안 참가자도 같은 목록을 실시간으로 본다('사다리 시작'을 눌러야 ladder:build 로 확정).
   * roulette:draft 와 같은 패턴 — 발신자(호스트) 제외하고 방 전원에게 relay.
   */
  @SubscribeMessage('ladder:draft')
  async handleLadderDraft(
    client: AppSocket,
    payload: { topLabels?: string[]; bottomLabels?: string[] },
  ): Promise<Ack> {
    return this.hostAction(client, (roomId) => {
      const clean = (a: unknown): string[] =>
        Array.isArray(a)
          ? a.filter((l): l is string => typeof l === 'string')
          : [];
      client.broadcast.to(roomId).emit('ladder:draft', {
        topLabels: clean(payload?.topLabels),
        bottomLabels: clean(payload?.bottomLabels),
      });
      return Promise.resolve();
    });
  }

  /**
   * 투표 — 입장한 참가자와 호스트가 던질 수 있다(호스트도 한 표 참여).
   * 표 키는 socket.id 를 쓴다. 닉네임을 키로 쓰면 닉네임을 바꿔 재입장해 옛 표를 남기는 식으로
   * 중복 투표가 가능하다. socket.id 는 한 연결 내내 고정이라 같은 소켓은 무슨 짓을 해도 1표만 갖는다.
   * 호스트는 닉네임이 없으므로 role 로 통과시킨다(표 키는 마찬가지로 호스트 소켓의 id).
   */
  @SubscribeMessage('vote:cast')
  async handleVoteCast(
    client: AppSocket,
    payload: { itemId?: string },
  ): Promise<Ack> {
    const { roomId, nickname, role } = client.data;
    if (!roomId) return this.fail(client, ERROR_CODES.ROOM_NOT_FOUND);
    // 아직 입장 안 한(닉네임 없는) 참가자만 막는다 — 호스트는 role 로 허용.
    if (!nickname && role !== 'host') {
      return this.fail(client, ERROR_CODES.VALIDATION_ERROR);
    }

    try {
      const tally = await this.gameService.castVote(
        roomId,
        client.id,
        payload?.itemId,
      );
      this.server.to(roomId).emit('vote:updated', { tally });
      return { ok: true };
    } catch (err) {
      if (err instanceof GameError) return this.fail(client, err.code);
      throw err;
    }
  }

  /** host '투표 시작' — 준비 단계에서 투표를 연다(open). 이후 참가자·호스트가 투표할 수 있다. */
  @SubscribeMessage('vote:start')
  async handleVoteStart(client: AppSocket): Promise<Ack> {
    return this.hostAction(client, async (roomId) => {
      const state = await this.gameService.openVote(roomId);
      this.server.to(roomId).emit('vote:state', state);
    });
  }

  /** host '투표 마감' — 10초 카운트다운을 시작한다(closing). 전원이 같은 카운트다운(closeAt)을 본다. */
  @SubscribeMessage('vote:close')
  async handleVoteClose(client: AppSocket): Promise<Ack> {
    return this.hostAction(client, async (roomId) => {
      const state = await this.gameService.startVoteClose(roomId);
      this.server.to(roomId).emit('vote:state', state);
    });
  }

  /** host '취소' — 마감 카운트다운을 멈추고 다시 투표를 연다(open). */
  @SubscribeMessage('vote:cancel')
  async handleVoteCancel(client: AppSocket): Promise<Ack> {
    return this.hostAction(client, async (roomId) => {
      const state = await this.gameService.cancelVoteClose(roomId);
      this.server.to(roomId).emit('vote:state', state);
    });
  }

  /**
   * 카운트다운 종료 → 실제 마감(host 클라이언트가 0초에 호출). closing 상태일 때만 집계를 확정하고
   * game:result 를 전원에게 broadcast 한다(취소·중복 호출은 무시 — 멱등).
   */
  @SubscribeMessage('vote:finalize')
  async handleVoteFinalize(client: AppSocket): Promise<Ack> {
    return this.hostAction(client, async (roomId) => {
      const result = await this.gameService.finalizeVote(roomId);
      if (result) this.server.to(roomId).emit('game:result', { result });
    });
  }

  /**
   * host 사다리 생성('사다리 시작') — 칸마다의 상단(이름)·하단(당첨항목) 라벨을 받아
   * 서버가 가로줄을 무작위 생성하고 구조를 전원에게 broadcast(같은 사다리를 그린다).
   */
  @SubscribeMessage('ladder:build')
  async handleLadderBuild(
    client: AppSocket,
    payload: { topLabels?: string[]; bottomLabels?: string[] },
  ): Promise<Ack> {
    return this.hostAction(client, async (roomId) => {
      const built = await this.gameService.buildLadder(
        roomId,
        payload?.topLabels ?? [],
        payload?.bottomLabels ?? [],
      );
      this.server.to(roomId).emit('ladder:built', built);
    });
  }

  /** host 시작칸 공개 — 도착 결과를 전원에게 broadcast(참가자도 같은 경로 애니메이션). */
  @SubscribeMessage('ladder:reveal')
  async handleLadderReveal(
    client: AppSocket,
    payload: { topIndex?: number },
  ): Promise<Ack> {
    return this.hostAction(client, async (roomId) => {
      const revealed = await this.gameService.revealLadder(
        roomId,
        payload?.topIndex ?? -1,
      );
      this.server.to(roomId).emit('ladder:revealed', revealed);
    });
  }

  /** host '결과 보기' — 전체 매칭을 계산해 전원에게 broadcast(모달을 동시에 연다). */
  @SubscribeMessage('ladder:result')
  async handleLadderResult(client: AppSocket): Promise<Ack> {
    return this.hostAction(client, async (roomId) => {
      const result = await this.gameService.resultLadder(roomId);
      this.server.to(roomId).emit('ladder:result', result);
    });
  }

  /**
   * host 제비 섞기 — 인원수(count)·꽝개수(blanks)로 꽝 위치를 무작위 배치하고 새 라운드를 연다.
   * 전원에게 draw:shuffled(개수·꽝수만) 를 알려 섞기 애니메이션을 함께 보게 한다.
   */
  @SubscribeMessage('draw:shuffle')
  async handleDrawShuffle(
    client: AppSocket,
    payload: { count?: number; blanks?: number },
  ): Promise<Ack> {
    return this.hostAction(client, async (roomId) => {
      const res = await this.gameService.shuffleDraw(
        roomId,
        payload?.count ?? 0,
        payload?.blanks ?? 0,
      );
      this.server.to(roomId).emit('draw:shuffled', res);
    });
  }

  /**
   * 제비 뽑기 — host·참가자 누구나. index 제비를 먼저 뽑은 사람이 잠근다(HSETNX, 중복 불가).
   * 뽑는 순간 그 제비의 꽝 여부가 공개돼 전원에게 draw:picked 로 broadcast 된다.
   * host 는 닉네임이 없으므로 '호스트' 로 표기한다.
   */
  @SubscribeMessage('draw:pick')
  async handleDrawPick(
    client: AppSocket,
    payload: { index?: number },
  ): Promise<Ack> {
    const { roomId, nickname, role } = client.data;
    if (!roomId) return this.fail(client, ERROR_CODES.ROOM_NOT_FOUND);
    const by = nickname ?? (role === 'host' ? '호스트' : undefined);
    if (!by) return this.fail(client, ERROR_CODES.VALIDATION_ERROR);

    try {
      const picked = await this.gameService.pickDraw(
        roomId,
        by,
        payload?.index ?? -1,
        role === 'host',
      );
      this.server.to(roomId).emit('draw:picked', picked);
      return { ok: true };
    } catch (err) {
      if (err instanceof GameError) return this.fail(client, err.code);
      throw err;
    }
  }

  /**
   * 제비뽑기 60초 자동 공개(host 전용) — 라운드 시작 60초 뒤 호스트 클라이언트가 호출한다.
   * 아직 안 뽑힌 제비를 전부 '미선택' 으로 공개하고, 새로 공개된 제비마다 draw:picked 로 broadcast 한다
   * (기존 뽑기와 같은 이벤트를 재사용 — 클라이언트는 추가 처리 없이 그대로 반영). 멱등이라 중복 호출도 안전.
   */
  @SubscribeMessage('draw:autoresolve')
  async handleDrawAutoResolve(client: AppSocket): Promise<Ack> {
    return this.hostAction(client, async (roomId) => {
      const picks = await this.gameService.autoResolveDraw(roomId);
      for (const p of picks) {
        this.server.to(roomId).emit('draw:picked', p);
      }
    });
  }

  /**
   * 제비뽑기 설정 실시간 미리보기 — 저장하지 않는 relay. 호스트가 제비 수·꽝 개수를 정하는 동안
   * 참가자도 같은 설정(제비 판 미리보기)을 실시간으로 본다('제비 섞기'를 눌러야 draw:shuffle 로 확정).
   * roulette:draft / ladder:draft 와 같은 패턴 — 발신자(호스트) 제외하고 방 전원에게 relay.
   */
  @SubscribeMessage('draw:draft')
  async handleDrawDraft(
    client: AppSocket,
    payload: { count?: number; blanks?: number },
  ): Promise<Ack> {
    return this.hostAction(client, (roomId) => {
      const count = Number.isFinite(payload?.count)
        ? Number(payload?.count)
        : 0;
      const blanks = Number.isFinite(payload?.blanks)
        ? Number(payload?.blanks)
        : 0;
      client.broadcast.to(roomId).emit('draw:draft', { count, blanks });
      return Promise.resolve();
    });
  }

  /**
   * host 풍선 게임 시작 — 참가자 순서를 스냅샷하고 폭탄을 무작위로 정한다.
   * 전원에게 balloon:started(총 개수·턴 순서·첫 턴·턴 제한시각)를 알린다(폭탄 위치는 비밀).
   * 총 펌프 수(풍선 크기)는 서버가 인원수로 자동 계산하므로 payload 는 받지 않는다.
   */
  @SubscribeMessage('balloon:start')
  async handleBalloonStart(client: AppSocket): Promise<Ack> {
    return this.hostAction(client, async (roomId) => {
      const res = await this.gameService.startBalloon(roomId);
      this.server.to(roomId).emit('balloon:started', res);
    });
  }

  /**
   * 가운데 풍선 펌프 — 현재 턴 참가자만(호스트도 참가하므로 host 도 자기 턴엔 펌프 가능).
   * 한 턴에 최대 MAX_PER_TURN 번 펌프할 수 있고, 펌프해도 턴은 유지된다(자동으로 안 넘어감).
   * 누적 펌프가 비밀 순번에 도달하면 그 사람이 걸리고 게임 종료. 결과는 balloon:pumped 로 전원 broadcast.
   */
  @SubscribeMessage('balloon:pump')
  async handleBalloonPump(client: AppSocket): Promise<Ack> {
    const { roomId, nickname, role } = client.data;
    if (!roomId) return this.fail(client, ERROR_CODES.ROOM_NOT_FOUND);
    const by = nickname ?? (role === 'host' ? BALLOON.HOST_NAME : undefined);
    if (!by) return this.fail(client, ERROR_CODES.NOT_YOUR_TURN); // 미입장(닉네임 없는 비호스트)은 턴 없음

    try {
      const pumped = await this.gameService.pumpBalloon(roomId, by);
      this.server.to(roomId).emit('balloon:pumped', pumped);
      return { ok: true };
    } catch (err) {
      if (err instanceof GameError) return this.fail(client, err.code);
      throw err;
    }
  }

  /**
   * '넘기기' — 현재 턴 참가자(호스트 포함)가 1번 이상 펌프한 뒤 다음 사람에게 턴을 넘긴다.
   * 결과는 balloon:passed 로 전원 broadcast 된다.
   */
  @SubscribeMessage('balloon:pass')
  async handleBalloonPass(client: AppSocket): Promise<Ack> {
    const { roomId, nickname, role } = client.data;
    if (!roomId) return this.fail(client, ERROR_CODES.ROOM_NOT_FOUND);
    const by = nickname ?? (role === 'host' ? BALLOON.HOST_NAME : undefined);
    if (!by) return this.fail(client, ERROR_CODES.NOT_YOUR_TURN);

    try {
      const passed = await this.gameService.passBalloon(roomId, by);
      this.server.to(roomId).emit('balloon:passed', passed);
      return { ok: true };
    } catch (err) {
      if (err instanceof GameError) return this.fail(client, err.code);
      throw err;
    }
  }

  /**
   * 턴 60초 만료(host 전용) — 호스트 클라이언트가 카운트다운이 0이 되면 호출한다.
   * 서버가 자동 펌프(미펌프 시) 후 다음 사람으로 넘기거나, 이미 펌프했으면 그냥 넘긴다.
   * 결과는 재사용 이벤트(balloon:pumped / balloon:passed)로 전원에게 broadcast 한다. 멱등이라 중복 호출도 안전.
   */
  @SubscribeMessage('balloon:timeout')
  async handleBalloonTimeout(
    client: AppSocket,
    payload: { deadline?: number },
  ): Promise<Ack> {
    return this.hostAction(client, async (roomId) => {
      // deadline 은 이 턴의 고유 토큰 — 서버 현재 턴과 일치할 때만 처리한다(이미 넘어간 턴이면 무시).
      const res = await this.gameService.timeoutBalloon(
        roomId,
        payload?.deadline ?? 0,
      );
      if (res) this.server.to(roomId).emit(res.event, res.payload);
    });
  }

  /**
   * host 전용 액션 공통 래퍼.
   * roomId 유무·host 여부를 검증하고, 서비스가 던지는 GameError(code)를
   * error 이벤트 + ack 로 변환한다. 예상 못 한 오류는 그대로 던져 상위에서 로깅되게 둔다.
   */
  private async hostAction(
    client: AppSocket,
    action: (roomId: string) => Promise<void>,
  ): Promise<Ack> {
    const { roomId, role } = client.data;
    if (!roomId) return this.fail(client, ERROR_CODES.ROOM_NOT_FOUND);
    if (role !== 'host') return this.fail(client, ERROR_CODES.NOT_HOST);

    try {
      await action(roomId);
      return { ok: true };
    } catch (err) {
      if (err instanceof GameError) return this.fail(client, err.code);
      throw err;
    }
  }

  private fail(client: AppSocket, code: string): { ok: false; code: string } {
    client.emit('error', { code });
    return { ok: false, code };
  }
}
