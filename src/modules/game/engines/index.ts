import { GameType } from '../../../common/constants/game-type';
import { Item } from '../../room/room.types';
import { GameResult } from '../game.types';
import { RouletteEngine } from './roulette';
import { SlotEngine } from './slot';
import { MultiWinnerEngine } from './multi-winner';
import { LadderEngine } from './ladder';

/** 게임 결과 계산 공통 인터페이스 — items(항목 목록) → 결과 payload */
export interface GameEngine {
  run(items: Item[], options?: Record<string, unknown>): GameResult;
}

// 게임별 엔진:
//  roulette / slot  → 1개 당첨   { winner }
//  draw / balloon   → N개 당첨   { winners }
//  ladder           → 매핑       { matching }
//  vote             → 집계+최다  (즉시 계산이 아니라 vote:close 로 마감 → GameService 가 직접 처리)

/** gameType → 엔진 매핑. vote 는 흐름이 달라 여기 없다(GameService.closeVote 담당). */
export const ENGINES: Partial<Record<GameType, GameEngine>> = {
  roulette: new RouletteEngine(),
  slot: new SlotEngine(),
  draw: new MultiWinnerEngine('draw'),
  balloon: new MultiWinnerEngine('balloon'),
  ladder: new LadderEngine(),
};
