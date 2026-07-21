import { RouletteEngine } from './roulette';
import { Item } from '../../room/room.types';

describe('RouletteEngine', () => {
  const engine = new RouletteEngine();
  const items: Item[] = [
    { id: '1', label: '짜장' },
    { id: '2', label: '짬뽕' },
    { id: '3', label: '볶음밥' },
  ];

  it('항상 항목 중 하나를 당첨으로 뽑는다', () => {
    for (let i = 0; i < 50; i++) {
      const result = engine.run(items);
      expect(result.type).toBe('roulette');
      expect(items).toContainEqual(result.winner);
    }
  });

  it('항목이 1개면 그 항목이 당첨된다', () => {
    const one: Item[] = [{ id: 'x', label: '유일' }];
    expect(engine.run(one).winner).toEqual(one[0]);
  });

  it('여러 번 돌리면 모든 항목이 최소 한 번은 당첨된다(편향 없음 확인)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) {
      seen.add(engine.run(items).winner.id);
    }
    expect(seen).toEqual(new Set(['1', '2', '3']));
  });

  it('항목이 없으면 예외를 던진다(서비스가 먼저 막아야 하는 상황)', () => {
    expect(() => engine.run([])).toThrow();
  });
});
