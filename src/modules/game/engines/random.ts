import { randomInt } from 'node:crypto';

/**
 * 게임 엔진 공통 무작위 유틸.
 * 전부 crypto.randomInt 기반 — 균등 분포가 보장되고 예측이 어렵다(Math.random 안 씀).
 * 결과는 서버가 한 번 계산해 전원에게 broadcast 하므로 클라마다 달라질 여지가 없다.
 */

/** 원본을 건드리지 않고 Fisher–Yates 로 섞은 새 배열을 반환한다. */
export function shuffle<T>(items: readonly T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 무작위 1개를 고른다. 빈 배열이면 예외(호출부가 먼저 검증해야 한다). */
export function pickOne<T>(items: readonly T[]): T {
  if (items.length === 0) throw new Error('pickOne: 빈 배열');
  return items[randomInt(items.length)];
}

/** 서로 다른 n개를 고른다. n 이 길이를 넘으면 전체를 섞어 반환한다. */
export function pickN<T>(items: readonly T[], n: number): T[] {
  return shuffle(items).slice(0, Math.max(0, n));
}
