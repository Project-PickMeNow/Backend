import { Item } from '../../room/room.types';
import { VoteResult, VoteTallyEntry } from '../game.types';

/**
 * 투표 집계 엔진.
 *
 * 다른 게임 엔진(룰렛 등)과 달리 항목만으로 결과가 나오지 않고 "누가 뭘 골랐는지"가
 * 필요해, GameEngine(run(items)) 인터페이스가 아니라 별도 클래스로 둔다.
 *
 * 입력 choices 는 각 투표자가 고른 itemId 목록(투표자 1명당 1개).
 */
export class VoteEngine {
  /** 실시간 집계 — 항목 순서대로, 득표 0 인 항목도 빠짐없이 포함한다. */
  tally(items: Item[], choices: string[]): VoteTallyEntry[] {
    const counts = new Map<string, number>();
    for (const itemId of choices) {
      counts.set(itemId, (counts.get(itemId) ?? 0) + 1);
    }
    return items.map((item) => ({ item, count: counts.get(item.id) ?? 0 }));
  }

  /**
   * 마감 결과 — 집계 + 최다 득표 항목.
   * 동점이면 항목 순서상 먼저인 것이 이긴다(결정적). 득표가 0 이어도 첫 항목이 winner 가 된다.
   */
  close(items: Item[], choices: string[]): VoteResult {
    if (items.length === 0) {
      // GameService 가 항목 수를 먼저 검증하므로 여기 오면 프로그래밍 오류.
      throw new Error('투표 마감에 항목이 최소 1개는 필요합니다.');
    }
    const tally = this.tally(items, choices);
    // reduce 로 최댓값을 찾되, 앞선 항목을 우선(>= 가 아니라 > 로 갱신)해 동점 시 순서를 지킨다.
    const winner = tally.reduce((best, cur) =>
      cur.count > best.count ? cur : best,
    ).item;
    return { type: 'vote', tally, winner };
  }
}
