import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { GAME_TYPES } from '../../../common/constants/game-type';
import type { GameType } from '../../../common/constants/game-type';
import { ROOM_CAPACITY } from '../../../common/constants/room-capacity';

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

  /** 방 정원(호스트가 설정). 안 주면 기본 200. 2~200 범위. */
  @IsOptional()
  @IsInt({ message: '정원은 정수여야 합니다.' })
  @Min(ROOM_CAPACITY.MIN, {
    message: `정원은 ${ROOM_CAPACITY.MIN}명 이상이어야 합니다.`,
  })
  @Max(ROOM_CAPACITY.MAX, {
    message: `정원은 최대 ${ROOM_CAPACITY.MAX}명입니다.`,
  })
  maxParticipants?: number;
}

/** POST /api/rooms 응답 data (응답 형태라 interface로 충분) */
export interface CreateRoomResponse {
  roomId: string;
  joinUrl: string;
  hostToken: string;
}
