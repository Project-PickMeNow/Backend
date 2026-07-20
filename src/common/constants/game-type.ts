// 게임 종류 6종 (와이어프레임·API 명세와 동일)
export const GAME_TYPES = [
  'roulette', // 룰렛
  'draw', // 제비뽑기
  'slot', // 슬롯머신
  'balloon', // 풍선터뜨리기
  'ladder', // 사다리타기
  'vote', // 투표하기
] as const;

export type GameType = (typeof GAME_TYPES)[number];
