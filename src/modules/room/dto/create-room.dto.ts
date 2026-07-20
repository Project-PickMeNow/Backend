import { GameType } from '../../../common/constants/game-type';

/**
 * POST /api/rooms 요청 body.
 * NestJS DTO는 class로 정의 (데코레이터 메타데이터 + 나중에 class-validator 부착용).
 */
export class CreateRoomDto {
  title?: string; // 방 제목 (선택)
  gameType?: GameType; // 초기 게임 종류 (선택)
}

/** POST /api/rooms 응답 data (응답 형태라 interface로 충분) */
export interface CreateRoomResponse {
  roomId: string;
  joinUrl: string;
  hostToken: string;
}
