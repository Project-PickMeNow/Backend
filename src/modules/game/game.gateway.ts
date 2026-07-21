import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server } from 'socket.io';
import { GameService, GameError } from './game.service';
import { ERROR_CODES } from '../../common/constants/error-code';
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
 *  vote:cast / vote:close — 투표
 *  ladder:build / ladder:reveal / ladder:result — 사다리
 *  draw:shuffle / draw:pick — 제비뽑기
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
   * host '방으로 돌아가기' — 라운드를 접어(결과·투표·사다리·제비 데이터 삭제) 방을 다시
   * 대기 상태로 되돌린다. 이때 참가자를 강제로 이동시키지 않는다 — 참가자는 각자 결과창의
   * '방으로 돌아가기'를 눌러 로비로 오고(1분 내 안 오면 클라이언트가 강퇴 안내), 서버는
   * 상태만 waiting 으로 바꿔 이후 게임종류 재선택·재시작·신규 입장이 다시 열리게 한다.
   * room 이벤트지만 GameService.resetGame 재사용을 위해 여기 둔다(RoomModule↔GameModule 순환 의존 회피).
   */
  @SubscribeMessage('room:return')
  async handleRoomReturn(client: AppSocket): Promise<Ack> {
    return this.hostAction(client, async (roomId) => {
      await this.gameService.resetGame(roomId);
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
   * 참가자 투표 — host 전용이 아니라 입장한 참가자면 누구나 던진다.
   * 입장(닉네임 확정) 여부는 검사하되, 표 키는 socket.id 를 쓴다.
   * 닉네임을 키로 쓰면 닉네임을 바꿔 재입장해 옛 표를 남기는 식으로 중복 투표가 가능하다.
   * socket.id 는 한 연결 내내 고정이라 같은 소켓은 무슨 짓을 해도 1표만 갖는다.
   */
  @SubscribeMessage('vote:cast')
  async handleVoteCast(
    client: AppSocket,
    payload: { itemId?: string },
  ): Promise<Ack> {
    const { roomId, nickname } = client.data;
    if (!roomId) return this.fail(client, ERROR_CODES.ROOM_NOT_FOUND);
    // 닉네임 없이(=아직 입장 안 함) 투표할 수 없다.
    if (!nickname) return this.fail(client, ERROR_CODES.VALIDATION_ERROR);

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

  /** host 투표 마감 — 집계 확정 후 최다 득표 결과를 전원에게 broadcast. */
  @SubscribeMessage('vote:close')
  async handleVoteClose(client: AppSocket): Promise<Ack> {
    return this.hostAction(client, async (roomId) => {
      const result = await this.gameService.closeVote(roomId);
      this.server.to(roomId).emit('game:result', { result });
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
   * host 풍선 게임 시작 — 참가자 순서를 스냅샷하고 폭탄을 무작위로 정한다.
   * 전원에게 balloon:started(총 개수·턴 순서·첫 턴)를 알린다(폭탄 위치는 비밀).
   */
  @SubscribeMessage('balloon:start')
  async handleBalloonStart(
    client: AppSocket,
    payload: { total?: number },
  ): Promise<Ack> {
    return this.hostAction(client, async (roomId) => {
      const res = await this.gameService.startBalloon(
        roomId,
        payload?.total ?? 0,
      );
      this.server.to(roomId).emit('balloon:started', res);
    });
  }

  /**
   * 가운데 풍선 펌프 — 현재 턴 참가자만. 한 번 펌프하면 곧바로 다음 사람 차례가 되고,
   * 누적 펌프가 비밀 순번에 도달하면 그 사람이 걸리고 게임 종료.
   * host 는 턴 순서에 없으므로(닉네임 없음) 펌프할 수 없다. 결과는 balloon:popped 로 전원 broadcast.
   */
  @SubscribeMessage('balloon:pop')
  async handleBalloonPop(client: AppSocket): Promise<Ack> {
    const { roomId, nickname } = client.data;
    if (!roomId) return this.fail(client, ERROR_CODES.ROOM_NOT_FOUND);
    if (!nickname) return this.fail(client, ERROR_CODES.NOT_YOUR_TURN); // host·미입장은 턴 없음

    try {
      const popped = await this.gameService.popBalloon(roomId, nickname);
      this.server.to(roomId).emit('balloon:popped', popped);
      return { ok: true };
    } catch (err) {
      if (err instanceof GameError) return this.fail(client, err.code);
      throw err;
    }
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
