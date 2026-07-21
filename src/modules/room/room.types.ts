/**
 * RoomGateway 가 클라이언트로 내보내는 실시간 payload 형태.
 * 프론트(socket.io-client)와 계약이 되는 부분이라 한곳에 모아둔다.
 */

// 사다리 구조 타입은 game 도메인이 소유. 순환 런타임 의존을 피해 타입만 가져온다.
import type { LadderStructure } from '../game/game.types';

/**
 * 게임에 쓰이는 항목 하나.
 * item:remove·item:reorder 가 id 기반이라 label 만으로는 부족해 구조화한다.
 * 방 해시(room:{id})의 items 필드에 JSON 배열로 저장된다.
 */
export interface Item {
  id: string;
  label: string;
}

/** connection 직후 접속자에게만 보내는 방 전체 스냅샷 (room:state) */
export interface RoomStatePayload {
  roomId: string;
  title: string;
  status: string;
  gameType: string | null;
  items: Item[];
  participants: string[]; // 닉네임 목록
  participantCount: number;
  onlineCount: number; // 이 방에 연결된 소켓 수(닉네임 확정 전 포함)
  maxParticipants: number; // 방 정원(호스트 설정, 기본 200)
  // 사다리가 진행 중이면 그 구조·라벨(build 당시 스냅샷)·이미 공개된 시작칸들 —
  // 늦게 들어오거나 재접속한 참가자도 room:state 하나로 현재 사다리를 그대로 복원한다.
  // 사다리 아니면 null·빈 배열.
  ladder: LadderStructure | null;
  ladderTopLabels: string[]; // 상단 라벨 스냅샷(이름, 칸 수와 항상 일치)
  ladderBottomLabels: string[]; // 하단 라벨 스냅샷(당첨항목, 칸 수와 항상 일치)
  ladderRevealed: number[];
}

/** 입·퇴장 시 방 전체에 broadcast (participant:joined / participant:left) */
export interface ParticipantChangePayload {
  nickname: string;
  participants: string[];
  participantCount: number;
}
