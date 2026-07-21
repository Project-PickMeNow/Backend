import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { GAME_TYPES } from '../../../common/constants/game-type';
import type { GameType } from '../../../common/constants/game-type';

/**
 * POST /api/rooms 요청 body.
 * class-validator 데코레이터를 붙여 전역 ValidationPipe 가 검증한다.
 * 통과 못 하면 VALIDATION_ERROR 로 400 이 나간다(전역 예외 필터가 형태를 맞춤).
 */
export class CreateRoomDto {
  @IsOptional()
  @IsString()
  @MaxLength(50, { message: '방 제목은 50자 이하여야 합니다.' })
  title?: string; // 방 제목 (선택)

  @IsOptional()
  @IsIn(GAME_TYPES, { message: '지원하지 않는 게임 종류입니다.' })
  gameType?: GameType; // 초기 게임 종류 (선택)
}

/** POST /api/rooms 응답 data (응답 형태라 interface로 충분) */
export interface CreateRoomResponse {
  roomId: string;
  joinUrl: string;
  hostToken: string;
}
