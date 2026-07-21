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
    sismember: jest.Mock;
    sadd: jest.Mock;
    smembers: jest.Mock;
  };
  let stats: { incrementRooms: jest.Mock; incrementParticipants: jest.Mock };
  let service: RoomService;

  beforeEach(() => {
    multiMock = createMultiMock();
    clientMock = {
      multi: jest.fn(() => multiMock),
      exists: jest.fn().mockResolvedValue(0), // 기본: 충돌 없음
      hgetall: jest.fn(),
      scard: jest.fn().mockResolvedValue(0),
      sismember: jest.fn().mockResolvedValue(0), // 기본: 새 참가자
      sadd: jest.fn().mockResolvedValue(1), // 기본: 추가 성공
      smembers: jest.fn().mockResolvedValue([]),
    };
    stats = {
      incrementRooms: jest.fn().mockResolvedValue(undefined),
      incrementParticipants: jest.fn().mockResolvedValue(undefined),
    };

    const config = {
      get: (key: string, fallback: string) =>
        ({
          ROOM_TTL_SECONDS: '259200',
          FRONTEND_BASE_URL: 'https://example.test',
          ROOM_MAX_PARTICIPANTS: '3', // 테스트 편의상 낮게
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

  describe('addParticipant', () => {
    it('새 닉네임을 추가하면 status=added + 통계·TTL 갱신', async () => {
      clientMock.sismember.mockResolvedValue(0); // 아직 없음
      clientMock.scard.mockResolvedValue(1); // 정원(3) 미만
      clientMock.sadd.mockResolvedValue(1); // 추가 성공
      clientMock.smembers.mockResolvedValue(['기존', '새사람']);

      const res = await service.addParticipant('ABC123', '새사람');

      expect(res.status).toBe('added');
      expect(res.participantCount).toBe(2);
      expect(stats.incrementParticipants).toHaveBeenCalledTimes(1);
      // touchRoom 이 multi().expire(...).exec() 로 TTL 을 리셋한다.
      expect(multiMock.expire).toHaveBeenCalled();
      expect(multiMock.exec).toHaveBeenCalled();
    });

    it('닉네임이 중복이면 status=taken (SADD 가 0)', async () => {
      clientMock.sismember.mockResolvedValue(0);
      clientMock.scard.mockResolvedValue(1);
      clientMock.sadd.mockResolvedValue(0); // 이미 존재
      clientMock.smembers.mockResolvedValue(['중복']);

      const res = await service.addParticipant('ABC123', '중복');

      expect(res.status).toBe('taken');
      expect(stats.incrementParticipants).not.toHaveBeenCalled();
    });

    it('정원이 차면 신규 입장은 status=full (SADD 를 시도하지 않는다)', async () => {
      clientMock.sismember.mockResolvedValue(0); // 새 참가자
      clientMock.scard.mockResolvedValue(3); // 정원(3) 도달

      const res = await service.addParticipant('ABC123', '초과');

      expect(res.status).toBe('full');
      expect(clientMock.sadd).not.toHaveBeenCalled();
      expect(stats.incrementParticipants).not.toHaveBeenCalled();
    });

    it('이미 들어와 있던 닉네임의 재요청은 정원과 무관하게 통과', async () => {
      clientMock.sismember.mockResolvedValue(1); // 이미 있음
      clientMock.scard.mockResolvedValue(3); // 정원 꽉 찼어도
      clientMock.sadd.mockResolvedValue(0); // 이미 존재라 0
      clientMock.smembers.mockResolvedValue(['나', '남', '또']);

      const res = await service.addParticipant('ABC123', '나');

      // 정원 체크를 건너뛰므로 full 이 아니다(SADD 결과에 따라 taken).
      expect(res.status).not.toBe('full');
    });
  });
});
