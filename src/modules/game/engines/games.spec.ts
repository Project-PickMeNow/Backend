import { OrderEngine } from './order';
import { MultiWinnerEngine } from './multi-winner';
import { generateLadder } from './ladder';
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

describe('OrderEngine', () => {
  const engine = new OrderEngine();
  it('항목 전체를 무작위 순서(순열)로 돌려준다', () => {
    for (let i = 0; i < 30; i++) {
      const r = engine.run(items);
      expect(r.type).toBe('order');
      expect(r.order).toHaveLength(items.length); // 전체 포함
      expect(new Set(r.order)).toEqual(new Set(items)); // 같은 원소 집합(누락·중복 없음)
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

describe('generateLadder', () => {
  it('mapping 은 항상 순열이다(모든 도착칸이 정확히 한 번씩)', () => {
    for (let n = 2; n <= 10; n++) {
      for (let t = 0; t < 20; t++) {
        const ladder = generateLadder(n);
        expect(ladder.columns).toBe(n);
        expect(ladder.mapping).toHaveLength(n);
        // 도착칸 집합 = {0..n-1} (중복·누락 없음)
        expect([...ladder.mapping].sort((a, b) => a - b)).toEqual(
          Array.from({ length: n }, (_, i) => i),
        );
      }
    }
  });

  it('가로줄은 유효 범위 안에 있고, 같은 행에서 한 세로줄이 두 줄에 물리지 않는다', () => {
    const ladder = generateLadder(6);
    for (const r of ladder.rungs) {
      expect(r.col).toBeGreaterThanOrEqual(0);
      expect(r.col).toBeLessThan(ladder.columns - 1);
      expect(r.row).toBeGreaterThanOrEqual(0);
      expect(r.row).toBeLessThan(ladder.rows);
    }
    // 같은 행에서 인접 가로줄(col, col+1)이 동시에 있으면 안 됨(경로 모호).
    for (let row = 0; row < ladder.rows; row++) {
      const cols = ladder.rungs
        .filter((r) => r.row === row)
        .map((r) => r.col)
        .sort((a, b) => a - b);
      for (let i = 1; i < cols.length; i++) {
        expect(cols[i] - cols[i - 1]).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('칸이 2개 미만이면 예외', () => {
    expect(() => generateLadder(1)).toThrow();
  });
});
