import { GameType } from '../../../common/constants/game-type';

/** 게임 결과 계산 공통 인터페이스 */
export interface GameEngine {
  /** items(항목 목록) → 결과 payload */
  run(items: string[], options?: Record<string, unknown>): unknown;
}

// TODO: 각 엔진 구현
//  roulette.ts / slot.ts  → 1개 당첨   { type, winner }
//  draw.ts / balloon.ts   → N개 당첨   { type, winners, winnerCount }
//  ladder.ts              → 매핑       { type, matching }
//  vote.ts                → 집계+최다   { type, tally, winner }

/** gameType → 엔진 매핑 (구현되면 채움) */
export const ENGINES: Partial<Record<GameType, GameEngine>> = {};
