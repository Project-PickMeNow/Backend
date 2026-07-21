import { Item } from '../../room/room.types';
import { MultiWinnerResult } from '../game.types';
import { pickN } from './random';
import type { GameEngine } from './index';

/**
 * 제비뽑기·풍선터뜨리기 공통 엔진 — 서로 다른 N개를 뽑는다.
 * 뽑을 개수는 game:start 의 options.count(기본 1, 항목 수로 상한).
 * 로직이 같고 UI(뽑기 애니 vs 터뜨리기)만 달라 type 만 바꿔 재사용한다.
 */
export class MultiWinnerEngine implements GameEngine {
  constructor(private readonly type: MultiWinnerResult['type']) {}

  run(items: Item[], options?: Record<string, unknown>): MultiWinnerResult {
    if (items.length === 0) {
      throw new Error(`${this.type} 실행에 항목이 최소 1개는 필요합니다.`);
    }
    const count = this.resolveCount(options, items.length);
    const winners = pickN(items, count);
    return { type: this.type, winners, winnerCount: winners.length };
  }

  /** options.count 를 1 이상·항목 수 이하로 정규화. 없거나 이상하면 1명. */
  private resolveCount(
    options: Record<string, unknown> | undefined,
    max: number,
  ): number {
    const raw = Number(options?.count);
    if (!Number.isFinite(raw) || raw < 1) return 1;
    return Math.min(Math.floor(raw), max);
  }
}
