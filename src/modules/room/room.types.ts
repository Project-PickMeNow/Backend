/**
 * RoomGateway 가 클라이언트로 내보내는 실시간 payload 형태.
 * 프론트(socket.io-client)와 계약이 되는 부분이라 한곳에 모아둔다.
 */

/** connection 직후 접속자에게만 보내는 방 전체 스냅샷 (room:state) */
export interface RoomStatePayload {
  roomId: string;
  title: string;
  status: string;
  gameType: string | null;
  items: string[];
  participants: string[]; // 닉네임 목록
  participantCount: number;
  onlineCount: number; // 이 방에 연결된 소켓 수(닉네임 확정 전 포함)
}

/** 입·퇴장 시 방 전체에 broadcast (participant:joined / participant:left) */
export interface ParticipantChangePayload {
  nickname: string;
  participants: string[];
  participantCount: number;
}
