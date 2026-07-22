import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
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

  /** 비밀방 여부. true 면 참가자는 입장 시 password 를 맞춰야 한다. */
  @IsOptional()
  @IsBoolean({ message: 'isSecret 은 boolean 이어야 합니다.' })
  isSecret?: boolean;

  /**
   * 비밀방 입장 비밀번호(숫자 최대 6자리). isSecret 이 true 일 때만 검증한다.
   * 서버는 이 값을 평문으로 저장하지 않는다(해시만 저장) — 응답에도 절대 내보내지 않는다.
   */
  @ValidateIf((o: CreateRoomDto) => o.isSecret === true)
  @IsString({ message: '비밀번호는 문자열이어야 합니다.' })
  @IsNotEmpty({ message: '비밀방은 비밀번호가 필요합니다.' })
  @Matches(/^[0-9]{1,6}$/, {
    message: '비밀번호는 숫자 최대 6자리여야 합니다.',
  })
  password?: string;
}

/** POST /api/rooms 응답 data (응답 형태라 interface로 충분) */
export interface CreateRoomResponse {
  roomId: string;
  joinUrl: string;
  hostToken: string;
}
