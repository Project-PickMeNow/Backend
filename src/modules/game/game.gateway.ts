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
 * 다루는 이벤트 (전부 host 전용):
 *  item:add / item:remove / item:reorder — 항목
 *  game:select / game:start / game:reset  — 게임 진행
 *  (vote:cast / vote:close 는 참가자용이라 이후 단계에서 구현)
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

  @SubscribeMessage('game:reset')
  async handleGameReset(client: AppSocket): Promise<Ack> {
    return this.hostAction(client, async (roomId) => {
      await this.gameService.resetGame(roomId);
      this.server.to(roomId).emit('game:reset', {});
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

  /** host 사다리 생성('시작하기') — 구조를 만들어 전원에게 broadcast(같은 사다리를 그린다). */
  @SubscribeMessage('ladder:build')
  async handleLadderBuild(client: AppSocket): Promise<Ack> {
    return this.hostAction(client, async (roomId) => {
      const payload = await this.gameService.buildLadder(roomId);
      this.server.to(roomId).emit('ladder:built', payload);
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
