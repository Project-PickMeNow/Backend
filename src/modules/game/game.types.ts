import { GameType } from '../../common/constants/game-type';
import { Item } from '../room/room.types';

/**
 * 게임 결과 payload. gameType 별로 형태가 달라 판별 유니온으로 둔다.
 * game:{roomId}:result 에 JSON 으로 저장되고 game:result 이벤트로 broadcast 된다.
 */

/** 룰렛·슬롯: 1명(개) 당첨 */
export interface SingleWinnerResult {
  type: Extract<GameType, 'roulette' | 'slot'>;
  winner: Item;
}

/** 앞으로 draw/ballon/ladder/vote 결과 타입이 여기에 추가된다. */
export type GameResult = SingleWinnerResult;
