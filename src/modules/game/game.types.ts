import { GameType } from '../../common/constants/game-type';
import { Item } from '../room/room.types';

/**
 * 게임 결과 payload. gameType 별로 형태가 달라 판별 유니온으로 둔다.
 * game:{roomId}:result 에 JSON 으로 저장되고 game:result 이벤트로 broadcast 된다.
 */

/** 룰렛: 1명(개) 당첨 */
export interface SingleWinnerResult {
  type: Extract<GameType, 'roulette'>;
  winner: Item;
}

/** 제비뽑기·풍선터뜨리기: N명(개) 당첨 */
export interface MultiWinnerResult {
  type: Extract<GameType, 'draw' | 'balloon'>;
  winners: Item[]; // 뽑힌 항목들(무작위 순서)
  winnerCount: number; // winners.length 과 같음(프론트 편의용 명시)
}

/** 순서 정하기: 항목을 무작위 순열로 1등~N등 줄 세운 결과 */
export interface OrderResult {
  type: Extract<GameType, 'order'>;
  order: Item[]; // 1등부터 순서대로. order[0] = 1등
}

// ── 사다리타기 (개수 선택형, 네이버 스타일) ──────────────────────────
// 다른 게임(룰렛·투표 등)과 달리 game:result 로 한 번에 끝나지 않는다.
// 호스트가 사다리를 만들고(ladder:build) 시작점을 하나씩 눌러 공개(ladder:reveal)하며,
// 그 과정을 참가자도 실시간으로 함께 본다.

/** 가로줄 하나 — row 행에서 세로줄 col 과 col+1 을 잇는다. */
export interface LadderRung {
  row: number;
  col: number;
}

/** 사다리 구조 — 서버가 한 번 생성해 전원에게 broadcast. 클라이언트는 이걸로 동일한 사다리를 그린다. */
export interface LadderStructure {
  columns: number; // 세로줄(칸) 수
  rows: number; // 행 수(가로줄이 놓일 수 있는 높이)
  rungs: LadderRung[]; // 놓인 가로줄들
  mapping: number[]; // mapping[i] = 시작칸 i 의 도착칸 (항상 순열)
}

/**
 * ladder:built broadcast — 사다리 구조 + 상·하단 라벨(호스트가 칸마다 입력).
 * 상단 = 이름, 하단 = 당첨항목. 둘 다 길이 = columns.
 */
export interface LadderBuiltPayload {
  ladder: LadderStructure;
  topLabels: string[]; // 상단 칸별 라벨(이름)
  bottomLabels: string[]; // 하단 칸별 라벨(당첨항목)
}

/** ladder:revealed broadcast — 방금 공개된 시작칸과 그 도착 결과(상·하단 라벨). */
export interface LadderRevealedPayload {
  topIndex: number; // 공개한 시작칸
  bottomIndex: number; // 도착칸 (= mapping[topIndex])
  topLabel: string; // 시작칸 라벨(이름)
  bottomLabel: string; // 도착칸 라벨(당첨항목)
}

/** ladder:result broadcast — '결과 보기'/전부 공개 시 상단→하단 전체 매칭. 모달을 전원 동시에 연다. */
export interface LadderResultPayload {
  pairs: LadderRevealedPayload[]; // 시작칸 순서대로 topIndex 0..columns-1
}

// ── 제비뽑기 (인터랙티브, 잠금형) ─────────────────────────────────
// 룰렛/투표와 달리 game:result 로 안 끝난다. 호스트가 인원수(제비 개수)·꽝 개수를 정하고
// draw:shuffle 로 꽝 위치를 무작위 배치하면, 방장·참가자가 각자 draw:pick 으로 제비를 뽑는다.
// 먼저 뽑힌 제비는 잠기고(HSETNX), 뽑는 순간 그 제비의 꽝 여부가 공개된다.

/** 뽑힌 제비 하나 (draw:picked broadcast 페이로드이기도 하다) */
export interface DrawPick {
  index: number; // 몇 번째 제비
  by: string; // 뽑은 사람 (참가자 닉네임 또는 '호스트')
  blank: boolean; // 꽝 여부
}

/** 제비뽑기 진행 상태 (room:state 복원용). 아직 섞기 전이면 null. */
export interface DrawState {
  count: number; // 제비 개수
  blanks: number; // 꽝 개수
  perPick: number; // 참가자 1인당 뽑기 상한(= ceil(제비수/사람수), 보통 1)
  picks: DrawPick[]; // 이미 뽑힌 제비들
}

/** draw:shuffled broadcast — 섞기 완료, 이제 뽑기 가능(꽝 위치는 숨김). */
export interface DrawShuffledPayload {
  count: number;
  blanks: number;
  perPick: number; // 참가자 1인당 뽑기 상한(제비수 > 사람수면 2 이상)
}

// ── 풍선 터뜨리기 (러시안 룰렛식, 턴제) ─────────────────────────────
// game:result 로 안 끝난다. 호스트가 풍선 개수를 정해 시작(balloon:start)하면 서버가
// 그중 하나를 비밀 폭탄으로 정한다. 참가자들이 순서대로 턴을 받아 자기 턴에 최대 3번 터뜨리고,
// 폭탄 풍선을 터뜨린 사람이 걸리며(caughtBy) 게임이 끝난다.

/**
 * 풍선 게임 진행 상태 (room:state 복원용). burstAt(터지는 순번)은 서버 비밀이라 여기 없다.
 * turn 은 지금 펌프할 차례인 참가자(걸린 뒤엔 null).
 */
export interface BalloonState {
  capacity: number; // 풍선 크기(이만큼 펌프하면 반드시 터짐)
  pumps: number; // 지금까지 누적 펌프 수
  turnOrder: string[]; // 참가자 닉네임 순서(시작 시 스냅샷)
  turn: string | null; // 현재 턴 참가자(걸린 뒤 null)
  caughtBy: string | null; // 풍선을 터뜨려 걸린 참가자(진행 중이면 null)
}

/** balloon:started broadcast — 게임 시작(터지는 순번은 비밀). */
export interface BalloonStartedPayload {
  capacity: number;
  turnOrder: string[];
  turn: string; // 첫 턴 참가자
}

/** balloon:popped broadcast — 누군가 풍선을 한 번 펌프할 때마다. */
export interface BalloonPoppedPayload {
  by: string; // 이번에 펌프한 참가자
  pumps: number; // 갱신된 누적 펌프 수
  turn: string | null; // 다음 턴 참가자 — 걸렸으면 null
  caughtBy: string | null; // 이 펌프로 터져 걸렸으면 그 사람, 아니면 null
  burst: boolean; // 이 펌프로 풍선이 터졌는지
}

/** 투표 집계 한 줄 — 항목 하나와 그 득표 수 */
export interface VoteTallyEntry {
  item: Item;
  count: number;
}

/** 투표: 집계 + 최다 득표 항목 */
export interface VoteResult {
  type: 'vote';
  tally: VoteTallyEntry[]; // 항목 순서대로, 득표 0 인 항목도 포함
  winner: Item; // 최다 득표(동점이면 항목 순서상 먼저)
}

/**
 * gameType 별 결과 판별 유니온(type 필드로 구분) — game:result 로 나가는 게임들.
 * 사다리는 game:result 를 쓰지 않고 ladder:built/revealed 로 진행하므로 여기 없다.
 */
export type GameResult =
  SingleWinnerResult | MultiWinnerResult | OrderResult | VoteResult;
