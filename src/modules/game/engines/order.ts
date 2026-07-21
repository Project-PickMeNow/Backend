import { Item } from '../../room/room.types';
import { OrderResult } from '../game.types';
import { shuffle } from './random';
import type { GameEngine } from './index';

/**
 * 순서 정하기 — 항목을 무작위 순열(Fisher–Yates)로 섞어 1등~N등 순서를 만든다.
 * order[0] 이 1등. 결과는 서버가 한 번 계산해 전원에게 broadcast 하므로 모두 같은 순서를 본다.
 */
export class OrderEngine implements GameEngine {
  run(items: Item[]): OrderResult {
    if (items.length === 0) {
      // GameService 가 최소 항목 수(NEED_MORE_ITEMS)를 먼저 검증하므로 여기 오면 프로그래밍 오류.
      throw new Error('순서 정하기에 항목이 최소 1개는 필요합니다.');
    }
    return { type: 'order', order: shuffle(items) };
  }
}
