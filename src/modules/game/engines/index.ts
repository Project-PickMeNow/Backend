import { GameType } from '../../../common/constants/game-type';
import { Item } from '../../room/room.types';
import { GameResult } from '../game.types';
import { RouletteEngine } from './roulette';
import { OrderEngine } from './order';
import { MultiWinnerEngine } from './multi-winner';

/** 게임 결과 계산 공통 인터페이스 — items(항목 목록) → 결과 payload (game:result 로 나감) */
export interface GameEngine {
  run(items: Item[], options?: Record<string, unknown>): GameResult;
}

// 게임별 엔진(game:start → game:result):
//  roulette → 1개 당첨      { winner }
//  order    → 무작위 순서    { order }
//  draw     → N개 당첨      { winners }
//
// 아래는 game:start 흐름이 아니라 별도 이벤트로 진행하므로 ENGINES 에 없다:
//  vote   → vote:close 로 마감(GameService.closeVote)
//  ladder → ladder:build/reveal 로 진행(GameService.buildLadder/revealLadder, engines/ladder.ts)
//  balloon→ balloon:start/pop 인터랙티브(GameService)

/** gameType → 엔진 매핑. vote·ladder·balloon 은 흐름이 달라 여기 없다. */
export const ENGINES: Partial<Record<GameType, GameEngine>> = {
  roulette: new RouletteEngine(),
  order: new OrderEngine(),
  draw: new MultiWinnerEngine('draw'),
};
