/**
 * 투표 게임 라이프사이클 정책.
 *
 * 상태: preparing(항목 준비, 투표 불가) → open(투표 시작, 투표 가능) →
 *       closing(마감 카운트다운 진행, 취소·재마감 가능) → closed(결과 확정).
 *
 * '투표 마감'을 누르면 COUNTDOWN_SECONDS 초 카운트다운이 시작되고, 0이 되면 실제로 마감된다.
 * 카운트다운 마감 시각(closeAt = 서버 epoch ms)을 전원에게 broadcast 해 모두 같은 카운트다운을 본다.
 */
export const VOTE = {
  COUNTDOWN_SECONDS: 10,
  COUNTDOWN_MS: 10_000,
} as const;

/** 투표 진행 상태. */
export type VoteStatus = 'preparing' | 'open' | 'closing' | 'closed';
