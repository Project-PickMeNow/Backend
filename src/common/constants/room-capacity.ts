/**
 * 방 정원 정책 (한곳에서 관리).
 * 정원은 선택된 게임 종류로 정해진다 — 투표하기는 50명, 나머지 게임은 12명.
 * game:select 때 capacityForGame 으로 방의 maxParticipants 를 갱신한다.
 */
export const ROOM_CAPACITY = {
  /** 최소 정원(게임이 성립하려면 최소 인원) */
  MIN: 2,
  /** 하드 상한 — 투표(50)까지 허용 */
  MAX: 50,
  /** 게임 미선택 시 기본 정원(대기방) */
  DEFAULT: 50,
  /** 투표하기 정원 */
  VOTE: 50,
  /** 그 외 게임 정원 — 실사용상 12명 이상도 문제없이 동작해, 서비스가 감당 가능한 상한(50)으로 확대. */
  GAME: 50,
} as const;

/** 게임 종류별 정원 — 투표만 50, 나머지(미선택 포함)는 12. */
export function capacityForGame(gameType: string | null | undefined): number {
  return gameType === 'vote' ? ROOM_CAPACITY.VOTE : ROOM_CAPACITY.GAME;
}
