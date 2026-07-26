import { GameService } from './game.service';
import { RedisService } from '../../infra/redis/redis.service';
import { StatsService } from '../stats/stats.service';
import { RoomService } from '../room/room.service';

/**
 * GameService.pruneDisconnected / dropNotReady 단위 테스트.
 * 게임 시작 시 유령(창 닫아 소켓 끊긴)·미복귀 참가자를 명단에서 빼는 로직만 검증한다
 * (Redis·RoomService 는 목으로 대체).
 */
describe('GameService — 게임 시작 시 참가자 정리', () => {
  let smembers: jest.Mock;
  let removeParticipant: jest.Mock;
  let pendingReturn: jest.Mock;
  let service: GameService;

  beforeEach(() => {
    // roomPlayers 의 현재 명단(초기값). removeParticipant 가 불릴 때마다 여기서 뺀 결과를 돌려준다.
    let players = ['철수', '영희', '민수'];
    smembers = jest
      .fn()
      .mockImplementation(() => Promise.resolve([...players]));
    removeParticipant = jest
      .fn()
      .mockImplementation((_room: string, nick: string) => {
        players = players.filter((p) => p !== nick);
        return Promise.resolve({
          participants: [...players],
          participantCount: players.length,
        });
      });
    pendingReturn = jest.fn().mockResolvedValue([]);

    const redis = { client: { smembers } } as unknown as RedisService;
    const stats = {} as unknown as StatsService;
    const rooms = {
      removeParticipant,
      pendingReturn,
    } as unknown as RoomService;
    service = new GameService(redis, stats, rooms);
  });

  describe('pruneDisconnected', () => {
    it('연결이 끊긴(유령) 참가자만 명단에서 빼고, 붙어 있는 사람은 남긴다', async () => {
      // 영희만 창을 닫아 소켓이 없다 → 철수·민수만 connected
      const res = await service.pruneDisconnected('ROOM01', ['철수', '민수']);

      expect(res.removed).toEqual(['영희']);
      expect(removeParticipant).toHaveBeenCalledTimes(1);
      expect(removeParticipant).toHaveBeenCalledWith('ROOM01', '영희');
      expect(res.participants).toEqual(['철수', '민수']);
      expect(res.participantCount).toBe(2);
    });

    it('전원이 연결돼 있으면 아무도 빼지 않는다', async () => {
      const res = await service.pruneDisconnected('ROOM01', [
        '철수',
        '영희',
        '민수',
      ]);

      expect(res.removed).toEqual([]);
      expect(removeParticipant).not.toHaveBeenCalled();
      expect(res.participantCount).toBe(3);
    });

    it('여러 명이 끊겼으면 모두 뺀다', async () => {
      const res = await service.pruneDisconnected('ROOM01', ['철수']);

      expect(res.removed).toEqual(['영희', '민수']);
      expect(res.participants).toEqual(['철수']);
      expect(res.participantCount).toBe(1);
    });
  });

  describe('dropNotReady', () => {
    it('아직 로비로 안 돌아온 참가자를 빼고 removed 로 돌려준다', async () => {
      pendingReturn.mockResolvedValue(['민수']); // 민수만 미복귀

      const res = await service.dropNotReady('ROOM01');

      expect(res.removed).toEqual(['민수']);
      expect(removeParticipant).toHaveBeenCalledWith('ROOM01', '민수');
      expect(res.participants).toEqual(['철수', '영희']);
      expect(res.participantCount).toBe(2);
    });

    it('전원 복귀했으면 아무도 빼지 않는다', async () => {
      pendingReturn.mockResolvedValue([]);

      const res = await service.dropNotReady('ROOM01');

      expect(res.removed).toEqual([]);
      expect(removeParticipant).not.toHaveBeenCalled();
      expect(res.participantCount).toBe(3);
    });
  });
});
