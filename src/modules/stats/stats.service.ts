import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infra/prisma/prisma.service';

/**
 * 누적 통계 서비스.
 * - 다른 모듈(room·game)이 카운터 증가를 호출
 * - GET /stats 가 현재 누적치를 읽음
 */
@Injectable()
export class StatsService {
  /**
   * stats 는 "서비스 전체 요약" 이라 항상 1행만 존재해야 한다.
   * findFirst 로 찾아 없으면 create 하는 방식은 동시 요청 시 2행이 생길 수 있으므로,
   * 고정 UUID 를 PK 로 못박고 upsert 한다 (중복은 PK 제약이 막아준다).
   */
  private static readonly SINGLETON_ID = '00000000-0000-0000-0000-000000000001';

  constructor(private readonly prisma: PrismaService) {}

  /** 누적 통계 조회 (대시보드용) */
  async getStats() {
    const row = await this.prisma.stats.findUnique({
      where: { id: StatsService.SINGLETON_ID },
    });

    // 아직 아무 활동도 없었다면 행 자체가 없다 — 조회 때문에 행을 만들지는 않고 0 으로 응답한다.
    // BigInt 는 JSON 직렬화가 안 되므로(JSON.stringify 가 예외를 던진다) 여기서 Number 로 바꾼다.
    return {
      totalRooms: Number(row?.totalRooms ?? 0),
      totalPlays: Number(row?.totalPlays ?? 0),
      totalParticipants: Number(row?.totalParticipants ?? 0),
    };
  }

  /** 방 생성 시 +1 */
  async incrementRooms(): Promise<void> {
    await this.increment('totalRooms');
  }

  /** 참가자 입장 시 +1 */
  async incrementParticipants(): Promise<void> {
    await this.increment('totalParticipants');
  }

  /** 게임 실행 시 +1 */
  async incrementPlays(): Promise<void> {
    await this.increment('totalPlays');
  }

  /** 카운터 1 증가. 행이 없으면 만들면서 1 로 시작한다. */
  private async increment(
    field: 'totalRooms' | 'totalPlays' | 'totalParticipants',
  ): Promise<void> {
    await this.prisma.stats.upsert({
      where: { id: StatsService.SINGLETON_ID },
      create: { id: StatsService.SINGLETON_ID, [field]: 1 },
      update: { [field]: { increment: 1 } },
    });
  }
}
