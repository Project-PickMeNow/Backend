import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infra/prisma/prisma.service';

/**
 * 누적 통계 서비스.
 * - 다른 모듈(room·game)이 카운터 증가를 호출
 * - GET /stats 가 현재 누적치를 읽음
 * TODO: stats 행이 없으면 생성하는 초기화, BigInt 직렬화 처리
 */
@Injectable()
export class StatsService {
  constructor(private readonly prisma: PrismaService) {}

  /** 누적 통계 조회 (대시보드용) */
  async getStats() {
    // TODO: 항상 1행만 존재하도록 upsert 기반으로 구현
    return { totalRooms: 0, totalPlays: 0, totalParticipants: 0 };
  }

  /** 방 생성 시 +1 */
  async incrementRooms(): Promise<void> {
    // TODO
  }

  /** 참가자 입장 시 +1 */
  async incrementParticipants(): Promise<void> {
    // TODO
  }

  /** 게임 실행 시 +1 */
  async incrementPlays(): Promise<void> {
    // TODO
  }
}
