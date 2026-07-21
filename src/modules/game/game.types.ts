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

/** 제비뽑기·풍선터뜨리기: N명(개) 당첨 */
export interface MultiWinnerResult {
  type: Extract<GameType, 'draw' | 'balloon'>;
  winners: Item[]; // 뽑힌 항목들(무작위 순서)
  winnerCount: number; // winners.length 과 같음(프론트 편의용 명시)
}

/** 사다리 매칭 한 줄 — 시작 항목 → 도착 항목 */
export interface LadderMatch {
  from: Item;
  to: Item;
}

/** 사다리타기: 항목들을 무작위로 재배치한 매핑 */
export interface LadderResult {
  type: 'ladder';
  matching: LadderMatch[];
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

/** gameType 별 결과 판별 유니온(type 필드로 구분). */
export type GameResult =
  SingleWinnerResult | MultiWinnerResult | LadderResult | VoteResult;
