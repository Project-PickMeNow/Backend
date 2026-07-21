import { SlotEngine } from './slot';
import { MultiWinnerEngine } from './multi-winner';
import { LadderEngine } from './ladder';
import { shuffle, pickN } from './random';
import { Item } from '../../room/room.types';

const items: Item[] = [
  { id: 'a', label: '짜장' },
  { id: 'b', label: '짬뽕' },
  { id: 'c', label: '볶음밥' },
  { id: 'd', label: '탕수육' },
];

describe('random 헬퍼', () => {
  it('shuffle 은 원본을 안 건드리고 같은 원소 집합을 유지한다', () => {
    const copy = [...items];
    const out = shuffle(items);
    expect(items).toEqual(copy); // 원본 불변
    expect(new Set(out)).toEqual(new Set(items)); // 원소 동일
    expect(out).toHaveLength(items.length);
  });

  it('pickN 은 서로 다른 n개를 준다(중복 없음)', () => {
    const picked = pickN(items, 3);
    expect(picked).toHaveLength(3);
    expect(new Set(picked.map((i) => i.id)).size).toBe(3);
  });

  it('pickN 은 n 이 길이를 넘으면 전체를 준다', () => {
    expect(pickN(items, 99)).toHaveLength(items.length);
  });
});

describe('SlotEngine', () => {
  const engine = new SlotEngine();
  it('항상 항목 중 하나를 당첨으로 뽑는다', () => {
    for (let i = 0; i < 30; i++) {
      const r = engine.run(items);
      expect(r.type).toBe('slot');
      expect(items).toContainEqual(r.winner);
    }
  });
  it('빈 배열이면 예외', () => {
    expect(() => engine.run([])).toThrow();
  });
});

describe('MultiWinnerEngine (draw/balloon)', () => {
  const draw = new MultiWinnerEngine('draw');
  const balloon = new MultiWinnerEngine('balloon');

  it('count 를 주면 서로 다른 그만큼 뽑는다', () => {
    const r = draw.run(items, { count: 2 });
    expect(r.type).toBe('draw');
    expect(r.winners).toHaveLength(2);
    expect(r.winnerCount).toBe(2);
    expect(new Set(r.winners.map((i) => i.id)).size).toBe(2);
    r.winners.forEach((w) => expect(items).toContainEqual(w));
  });

  it('count 없으면 기본 1명', () => {
    expect(draw.run(items).winnerCount).toBe(1);
  });

  it('count 가 항목 수를 넘으면 전체로 제한', () => {
    const r = balloon.run(items, { count: 100 });
    expect(r.type).toBe('balloon');
    expect(r.winnerCount).toBe(items.length);
  });

  it('count 가 이상값(0·음수·문자)이면 1명', () => {
    expect(draw.run(items, { count: 0 }).winnerCount).toBe(1);
    expect(draw.run(items, { count: -3 }).winnerCount).toBe(1);
    expect(draw.run(items, { count: 'x' }).winnerCount).toBe(1);
  });
});

describe('LadderEngine', () => {
  const engine = new LadderEngine();
  it('모든 시작 항목이 매핑에 등장하고, 도착 집합은 항목 전체와 같다(순열)', () => {
    const r = engine.run(items);
    expect(r.type).toBe('ladder');
    expect(r.matching).toHaveLength(items.length);
    expect(r.matching.map((m) => m.from)).toEqual(items); // 시작은 순서대로 전부
    expect(new Set(r.matching.map((m) => m.to.id))).toEqual(
      new Set(items.map((i) => i.id)), // 도착도 항목 전체(중복·누락 없음)
    );
  });
  it('빈 배열이면 예외', () => {
    expect(() => engine.run([])).toThrow();
  });
});
