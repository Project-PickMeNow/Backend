import { randomInt } from 'node:crypto';
import { Item } from '../../room/room.types';
import { GameResult } from '../game.types';
import type { GameEngine } from './index';

/**
 * 룰렛 — 항목 중 무작위 1개를 당첨으로 뽑는다.
 * Math.random 이 아니라 crypto.randomInt 를 쓴다: 균등 분포가 보장되고 예측이 어렵다.
 * (결과는 서버가 한 번 계산해 전원에게 broadcast 하므로, 클라마다 다르게 나올 여지가 없다)
 */
export class RouletteEngine implements GameEngine {
  run(items: Item[]): GameResult {
    if (items.length === 0) {
      // GameService 가 최소 항목 수(NEED_MORE_ITEMS)를 먼저 검증하므로 여기 오면 프로그래밍 오류.
      throw new Error('룰렛 실행에 항목이 최소 1개는 필요합니다.');
    }
    const winner = items[randomInt(items.length)];
    return { type: 'roulette', winner };
  }
}
