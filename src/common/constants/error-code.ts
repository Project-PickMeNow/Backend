// 에러 코드 (API 명세 4️⃣ 에러 코드와 동일)
export const ERROR_CODES = {
  ROOM_NOT_FOUND: 'ROOM_NOT_FOUND', // 없는 roomId
  ROOM_EXPIRED: 'ROOM_EXPIRED', // TTL 만료된 방
  ROOM_FULL: 'ROOM_FULL', // 정원 초과
  NOT_HOST: 'NOT_HOST', // 참가자가 host 전용 액션 시도
  NICKNAME_TAKEN: 'NICKNAME_TAKEN', // 닉네임 중복
  NEED_MORE_ITEMS: 'NEED_MORE_ITEMS', // 항목 2개 미만
  GAME_RUNNING: 'GAME_RUNNING', // 이미 게임 진행 중
  ALREADY_PICKED: 'ALREADY_PICKED', // 제비뽑기 — 참가자가 이미 1개를 뽑음(1인 1제비)
  ROOM_LOCKED: 'ROOM_LOCKED', // 게임 진행 중이라 신규 입장 불가
  VALIDATION_ERROR: 'VALIDATION_ERROR', // 필드 누락·형식 오류
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;
