import { GameType } from '../../../common/constants/game-type';
import { Item } from '../../room/room.types';
import { GameResult } from '../game.types';
import { RouletteEngine } from './roulette';

/** 게임 결과 계산 공통 인터페이스 — items(항목 목록) → 결과 payload */
export interface GameEngine {
  run(items: Item[], options?: Record<string, unknown>): GameResult;
}

// 각 엔진 (구현되는 대로 채운다)
//  roulette / slot  → 1개 당첨   { winner }
//  draw / balloon   → N개 당첨   { winners }
//  ladder           → 매핑       { matching }
//  vote             → 집계+최다   { tally, winner }

/** gameType → 엔진 매핑. 없는 gameType 은 아직 미구현. */
export const ENGINES: Partial<Record<GameType, GameEngine>> = {
  roulette: new RouletteEngine(),
};
