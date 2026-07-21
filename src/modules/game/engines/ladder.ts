import { Item } from '../../room/room.types';
import { LadderResult } from '../game.types';
import { shuffle } from './random';
import type { GameEngine } from './index';

/**
 * 사다리타기 — 항목들을 무작위로 재배치해 시작→도착 매핑을 만든다.
 * 사다리 특성상 시작이 자기 자신에 도착할 수도 있다(같은 열로 내려오는 경우). 그대로 둔다.
 * 실제 사다리 선긋기 애니는 프론트가 이 매핑을 받아 그린다.
 */
export class LadderEngine implements GameEngine {
  run(items: Item[]): LadderResult {
    if (items.length === 0) {
      throw new Error('사다리 실행에 항목이 최소 1개는 필요합니다.');
    }
    const destinations = shuffle(items);
    const matching = items.map((from, i) => ({ from, to: destinations[i] }));
    return { type: 'ladder', matching };
  }
}
