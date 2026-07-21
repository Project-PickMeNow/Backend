import { Item } from '../../room/room.types';
import { SingleWinnerResult } from '../game.types';
import { pickOne } from './random';
import type { GameEngine } from './index';

/** 슬롯머신 — 룰렛과 같은 "무작위 1개 당첨". UI(릴 애니)만 다르다. */
export class SlotEngine implements GameEngine {
  run(items: Item[]): SingleWinnerResult {
    if (items.length === 0) {
      throw new Error('슬롯 실행에 항목이 최소 1개는 필요합니다.');
    }
    return { type: 'slot', winner: pickOne(items) };
  }
}
