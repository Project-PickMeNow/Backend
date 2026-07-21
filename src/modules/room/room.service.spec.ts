import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RoomService } from './room.service';
import { RedisService } from '../../infra/redis/redis.service';
import { StatsService } from '../stats/stats.service';

/**
 * RoomService 단위 테스트 — Redis·Postgres 없이 도는 것을 목표로 한다.
 * (실제 연결까지 확인하는 건 e2e 쪽 몫)
 */
describe('RoomService', () => {
  /** multi().hset().expire().exec() 체이닝을 흉내내는 목 */
  const createMultiMock = () => ({
    hset: jest.fn().mockReturnThis(),
    expire: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue([]),
  });

  let multiMock: ReturnType<typeof createMultiMock>;
  let clientMock: {
    multi: jest.Mock;
    exists: jest.Mock;
    hgetall: jest.Mock;
    scard: jest.Mock;
  };
  let stats: { incrementRooms: jest.Mock };
  let service: RoomService;

  beforeEach(() => {
    multiMock = createMultiMock();
    clientMock = {
      multi: jest.fn(() => multiMock),
      exists: jest.fn().mockResolvedValue(0), // 기본: 충돌 없음
      hgetall: jest.fn(),
      scard: jest.fn().mockResolvedValue(0),
    };
    stats = { incrementRooms: jest.fn().mockResolvedValue(undefined) };

    const config = {
      get: (key: string, fallback: string) =>
        ({
          ROOM_TTL_SECONDS: '259200',
          FRONTEND_BASE_URL: 'https://example.test',
        })[key] ?? fallback,
    };

    service = new RoomService(
      { client: clientMock } as unknown as RedisService,
      stats as unknown as StatsService,
      config as unknown as ConfigService,
    );
  });

  describe('createRoom', () => {
    it('사람이 따라 칠 수 있는 6자리 roomId 를 만든다 (헷갈리는 0·1·I·L·O 제외)', async () => {
      const result = await service.createRoom({});

      expect(result.roomId).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
    });

    it('joinUrl 은 프론트 주소 + roomId 로 만든다', async () => {
      const result = await service.createRoom({});

      expect(result.joinUrl).toBe(`https://example.test/join/${result.roomId}`);
    });

    it('방마다 다른 hostToken 을 발급한다', async () => {
      const a = await service.createRoom({});
      const b = await service.createRoom({});

      expect(a.hostToken).not.toBe(b.hostToken);
      expect(a.hostToken.length).toBeGreaterThanOrEqual(32);
    });

    it('TTL 없는 방이 남지 않도록 hset 과 expire 를 같은 multi 에 실어 보낸다', async () => {
      await service.createRoom({ title: '점심' });

      expect(clientMock.multi).toHaveBeenCalledTimes(1);
      expect(multiMock.hset).toHaveBeenCalledTimes(1);
      expect(multiMock.expire).toHaveBeenCalledWith(expect.any(String), 259200);
      expect(multiMock.exec).toHaveBeenCalledTimes(1);
    });

    it('gameType 을 안 주면 빈 문자열로 저장한다 (Redis Hash 는 null 을 못 담는다)', async () => {
      await service.createRoom({});

      const [, hash] = multiMock.hset.mock.calls[0] as [
        string,
        Record<string, string>,
      ];
      expect(hash.gameType).toBe('');
      expect(hash.status).toBe('waiting');
      expect(hash.items).toBe('[]');
    });

    it('누적 통계 카운터를 올린다', async () => {
      await service.createRoom({});

      expect(stats.incrementRooms).toHaveBeenCalledTimes(1);
    });

    it('roomId 가 이미 있으면 다른 값으로 다시 뽑는다', async () => {
      clientMock.exists
        .mockResolvedValueOnce(1) // 첫 후보 충돌
        .mockResolvedValueOnce(0); // 두 번째는 비어 있음

      const result = await service.createRoom({});

      expect(clientMock.exists).toHaveBeenCalledTimes(2);
      expect(result.roomId).toHaveLength(6);
    });
  });

  describe('getRoomSummary', () => {
    it('없는 방이면 ROOM_NOT_FOUND 로 404 를 던진다', async () => {
      clientMock.hgetall.mockResolvedValue({}); // 키가 없으면 빈 객체

      await expect(service.getRoomSummary('ZZZZZZ')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('hostToken 을 응답에 절대 포함하지 않는다 (참가자도 받는 응답이다)', async () => {
      clientMock.hgetall.mockResolvedValue({
        title: '점심',
        hostToken: 'super-secret',
        status: 'waiting',
        gameType: 'roulette',
        items: '[]',
        createdAt: new Date().toISOString(),
      });
      clientMock.scard.mockResolvedValue(3);

      const summary = await service.getRoomSummary('ABC123');

      expect(JSON.stringify(summary)).not.toContain('super-secret');
      expect(summary).toEqual({
        roomId: 'ABC123',
        title: '점심',
        status: 'waiting',
        gameType: 'roulette',
        participantCount: 3,
      });
    });

    it('게임 미선택(빈 문자열)은 null 로 바꿔 응답한다', async () => {
      clientMock.hgetall.mockResolvedValue({
        title: '',
        hostToken: 't',
        status: 'waiting',
        gameType: '',
        items: '[]',
        createdAt: new Date().toISOString(),
      });

      const summary = await service.getRoomSummary('ABC123');

      expect(summary.gameType).toBeNull();
    });
  });
});
