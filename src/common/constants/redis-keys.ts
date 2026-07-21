/**
 * Redis 키 스키마 (개발계획서 §2 확정안).
 *
 * 키 문자열을 각 서비스에 흩뿌리면 오타 한 글자로 "저장은 됐는데 안 읽히는" 버그가 난다.
 * 방·게임 관련 키는 반드시 여기를 거쳐서 만든다.
 */
export const RedisKeys = {
  /** 방 상태 (Hash) — title·hostToken·status·gameType·items·createdAt */
  room: (roomId: string) => `room:${roomId}`,

  /** 참가자 목록 (Set) — 닉네임 */
  roomPlayers: (roomId: string) => `room:${roomId}:players`,

  /** 게임 결과 (String, JSON) */
  gameResult: (roomId: string) => `game:${roomId}:result`,

  /** 투표 진행 상태 (Hash) — socket.id → 선택한 itemId. 한 소켓당 1표(덮어쓰기=투표 변경). */
  gameVotes: (roomId: string) => `game:${roomId}:votes`,

  /** 사다리 구조 (String, JSON) — 서버가 생성한 columns·rungs·mapping */
  gameLadder: (roomId: string) => `game:${roomId}:ladder`,

  /** 사다리에서 공개된 시작칸 (Set) — 재접속 시 이어보기용 */
  gameLadderRevealed: (roomId: string) => `game:${roomId}:ladder:revealed`,

  /** 제비뽑기 라운드 (String, JSON) — { count, blanks, blankSet } (꽝 위치는 숨김) */
  gameDraw: (roomId: string) => `game:${roomId}:draw`,

  /** 제비뽑기 뽑힌 제비 (Hash) — index → 닉네임. HSETNX 로 먼저 뽑은 사람이 잠근다. */
  gameDrawPicks: (roomId: string) => `game:${roomId}:draw:picks`,

  /** 전체 접속자 수 (String, 카운터) */
  onlineCount: () => `online:count`,

  /** 방별 접속자 (Set) — socket.id */
  onlineRoom: (roomId: string) => `online:room:${roomId}`,
} as const;

/** 방 상태 Hash 의 필드 (hgetall 결과는 전부 string 이다) */
export interface RoomHash {
  title: string;
  hostToken: string;
  status: 'waiting' | 'playing' | 'finished';
  gameType: string; // 미선택이면 빈 문자열 (Redis Hash 에 null 을 못 넣는다)
  items: string; // JSON 배열 문자열
  maxParticipants: string; // 방 정원(숫자 문자열, 기본 200)
  createdAt: string; // ISO 8601
}
