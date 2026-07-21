import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
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
export class GameGateway {
  @WebSocketServer() server: Server;

  constructor(private readonly gameService: GameService) {}

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
  async handleGameStart(client: AppSocket): Promise<Ack> {
    return this.hostAction(client, async (roomId) => {
      const { gameType, result } = await this.gameService.startGame(roomId);
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
