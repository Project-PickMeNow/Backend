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
   * 마감 결과 — 집계 + 최다 득표 항목(들).
   * 동점이면 최다 득표한 항목이 여럿이므로 winners 에 모두 담아 공동 1위를 표현한다(항목 순서 유지).
   * winner 는 하위호환용 대표값(winners[0]). 득표가 0 이어도 최소 첫 항목이 winner 가 된다.
   */
  close(items: Item[], choices: string[]): VoteResult {
    if (items.length === 0) {
      // GameService 가 항목 수를 먼저 검증하므로 여기 오면 프로그래밍 오류.
      throw new Error('투표 마감에 항목이 최소 1개는 필요합니다.');
    }
    const tally = this.tally(items, choices);
    const maxCount = tally.reduce((m, t) => Math.max(m, t.count), 0);
    // 최다 득표(동점 포함) 전원. 득표가 0 이면(아무도 투표 안 함) 첫 항목만 대표로 둔다.
    const winners =
      maxCount > 0
        ? tally.filter((t) => t.count === maxCount).map((t) => t.item)
        : [tally[0].item];
    return { type: 'vote', tally, winner: winners[0], winners };
  }
}
