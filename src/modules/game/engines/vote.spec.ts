import { VoteEngine } from './vote';
import { Item } from '../../room/room.types';

describe('VoteEngine', () => {
  const engine = new VoteEngine();
  const items: Item[] = [
    { id: 'a', label: '짜장' },
    { id: 'b', label: '짬뽕' },
    { id: 'c', label: '볶음밥' },
  ];

  describe('tally', () => {
    it('득표 0 인 항목도 항목 순서대로 빠짐없이 포함한다', () => {
      const tally = engine.tally(items, ['a', 'a', 'b']);
      expect(tally).toEqual([
        { item: items[0], count: 2 },
        { item: items[1], count: 1 },
        { item: items[2], count: 0 },
      ]);
    });

    it('아무도 투표 안 했으면 전부 0', () => {
      expect(engine.tally(items, []).every((t) => t.count === 0)).toBe(true);
    });
  });

  describe('close', () => {
    it('최다 득표 항목을 winner 로 뽑는다', () => {
      const result = engine.close(items, ['b', 'b', 'b', 'a']);
      expect(result.type).toBe('vote');
      expect(result.winner).toEqual(items[1]);
    });

    it('동점이면 항목 순서상 먼저인 것이 이긴다(결정적)', () => {
      // a 와 b 가 각 1표 동점 → 앞선 a 가 winner
      const result = engine.close(items, ['a', 'b']);
      expect(result.winner).toEqual(items[0]);
    });

    it('아무도 투표 안 했으면 첫 항목이 winner(결정적)', () => {
      const result = engine.close(items, []);
      expect(result.winner).toEqual(items[0]);
      expect(result.tally.every((t) => t.count === 0)).toBe(true);
    });

    it('항목이 없으면 예외(서비스가 먼저 막아야 하는 상황)', () => {
      expect(() => engine.close([], ['x'])).toThrow();
    });
  });
});
