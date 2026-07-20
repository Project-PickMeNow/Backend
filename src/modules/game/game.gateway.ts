import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { GameService } from './game.service';

/**
 * 게임 WebSocket 게이트웨이.
 * 다루는 이벤트 (API 명세 2️⃣):
 *  item:add / item:remove / item:reorder — 항목 (host)
 *  game:select / game:start / game:reset  — 게임 진행 (host)
 *  vote:cast / vote:close                 — 투표
 */
@WebSocketGateway({ namespace: '/rooms', cors: true })
export class GameGateway {
  @WebSocketServer() server: Server;

  constructor(private readonly gameService: GameService) {}

  @SubscribeMessage('item:add')
  handleItemAdd(client: Socket, payload: { label: string }) {
    // TODO: host 검증, 항목 추가, item:added broadcast
  }

  @SubscribeMessage('item:remove')
  handleItemRemove(client: Socket, payload: { itemId: string }) {
    // TODO
  }

  @SubscribeMessage('item:reorder')
  handleItemReorder(client: Socket, payload: { order: string[] }) {
    // TODO
  }

  @SubscribeMessage('game:select')
  handleGameSelect(client: Socket, payload: { gameType: string }) {
    // TODO
  }

  @SubscribeMessage('game:start')
  handleGameStart(client: Socket, payload: { options?: Record<string, unknown> }) {
    // TODO: 결과 계산, game:started + game:result broadcast
  }

  @SubscribeMessage('game:reset')
  handleGameReset(client: Socket) {
    // TODO
  }

  @SubscribeMessage('vote:cast')
  handleVoteCast(client: Socket, payload: { optionId: string }) {
    // TODO: 집계 +1, vote:updated broadcast
  }

  @SubscribeMessage('vote:close')
  handleVoteClose(client: Socket) {
    // TODO: host 검증, 집계 확정, game:result broadcast
  }
}
