/**
 * 방 정원 정책 (한곳에서 관리).
 * 정원은 선택된 게임 종류로 정해진다 — 현재는 모든 게임 11명(투표 포함).
 * game:select 때 capacityForGame 으로 방의 maxParticipants 를 갱신한다.
 *
 * 여기 값은 모두 **방장을 뺀 참가자 수**다. 방장은 players Set 에 들어가지 않아
 * 정원 검사(scard >= cap)에서도 세지 않기 때문이다.
 * 서비스 정책은 "방장 포함 12명" 이므로 참가자 정원은 11이 된다.
 * 프론트의 shared/lib/roomCapacity.ts(MAX_ROOM_MEMBERS=12) 와 같은 정책을 가리켜야 한다.
 */
export const ROOM_CAPACITY = {
  /** 최소 정원(게임이 성립하려면 최소 인원) */
  MIN: 2,
  /** 하드 상한 — 방장 포함 12명 */
  MAX: 11,
  /** 게임 미선택 시 기본 정원(대기방) */
  DEFAULT: 11,
  /** 투표하기 정원 */
  VOTE: 11,
  /** 그 외 게임 정원 */
  GAME: 11,
} as const;

/** 게임 종류별 정원 — 현재는 투표·그 외(미선택 포함) 모두 11(방장 포함 12명). */
export function capacityForGame(gameType: string | null | undefined): number {
  return gameType === 'vote' ? ROOM_CAPACITY.VOTE : ROOM_CAPACITY.GAME;
}
