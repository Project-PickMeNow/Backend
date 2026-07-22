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
  NOT_ENOUGH_STICKS: 'NOT_ENOUGH_STICKS', // 제비뽑기 — 제비 수가 참가자 수보다 적어 시작 불가
  NEED_MORE_PLAYERS: 'NEED_MORE_PLAYERS', // 풍선 등 턴제 게임에 참가자가 부족함
  NOT_YOUR_TURN: 'NOT_YOUR_TURN', // 풍선 — 자기 턴이 아닌데 펌프/넘기기
  PUMP_LIMIT: 'PUMP_LIMIT', // 풍선 — 이번 턴 펌프 상한(MAX_PER_TURN) 도달, 더 못 펌프
  PUMP_FIRST: 'PUMP_FIRST', // 풍선 — 1번도 안 펌프하고 넘기기 시도
  ROOM_LOCKED: 'ROOM_LOCKED', // 게임 진행 중이라 신규 입장 불가
  ROOM_NOT_STARTED: 'ROOM_NOT_STARTED', // 방 유효기간 시작 전 — 아직 입장할 수 없음
  WRONG_PASSWORD: 'WRONG_PASSWORD', // 비밀방 — 입장 비밀번호가 없거나 틀림
  VOTE_NOT_OPEN: 'VOTE_NOT_OPEN', // 투표가 아직 시작 전(준비 중)이거나 이미 마감돼 투표할 수 없음
  VOTE_NO_VOTES: 'VOTE_NO_VOTES', // 아직 아무도 투표하지 않아 마감할 수 없음
  PLAYERS_NOT_READY: 'PLAYERS_NOT_READY', // 이전 게임 참가자가 아직 방으로 다 안 돌아옴(새 게임 시작 불가)
  VALIDATION_ERROR: 'VALIDATION_ERROR', // 필드 누락·형식 오류
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;
