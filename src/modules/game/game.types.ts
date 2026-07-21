import { GameType } from '../../common/constants/game-type';
import { Item } from '../room/room.types';

/**
 * 게임 결과 payload. gameType 별로 형태가 달라 판별 유니온으로 둔다.
 * game:{roomId}:result 에 JSON 으로 저장되고 game:result 이벤트로 broadcast 된다.
 */

/** 룰렛·슬롯: 1명(개) 당첨 */
export interface SingleWinnerResult {
  type: Extract<GameType, 'roulette' | 'slot'>;
  winner: Item;
}

/** 제비뽑기·풍선터뜨리기: N명(개) 당첨 */
export interface MultiWinnerResult {
  type: Extract<GameType, 'draw' | 'balloon'>;
  winners: Item[]; // 뽑힌 항목들(무작위 순서)
  winnerCount: number; // winners.length 과 같음(프론트 편의용 명시)
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

/** ladder:built broadcast — 사다리 구조 + 하단 라벨(호스트가 입력한 결과들). */
export interface LadderBuiltPayload {
  ladder: LadderStructure;
  labels: string[]; // 하단 칸별 라벨(items 라벨). 길이 = columns
}

/** ladder:revealed broadcast — 방금 공개된 시작칸과 그 도착 결과. */
export interface LadderRevealedPayload {
  topIndex: number; // 공개한 시작칸
  bottomIndex: number; // 도착칸 (= mapping[topIndex])
  label: string; // 도착칸 라벨
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
export type GameResult = SingleWinnerResult | MultiWinnerResult | VoteResult;
