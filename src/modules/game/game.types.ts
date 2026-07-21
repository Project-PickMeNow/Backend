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

/** 투표 집계 한 줄 — 항목 하나와 그 득표 수 */
export interface VoteTallyEntry {
  item: Item;
  count: number;
}

/** 투표: 집계 + 최다 득표 항목 */
export interface VoteResult {
  type: 'vote';
  tally: VoteTallyEntry[]; // 항목 순서대로, 득표 0 인 항목도 포함
  winner: Item; // 최다 득표(동점이면 항목 순서상 먼저)
}

/** 앞으로 draw/balloon/ladder 결과 타입이 여기에 추가된다. */
export type GameResult = SingleWinnerResult | VoteResult;
