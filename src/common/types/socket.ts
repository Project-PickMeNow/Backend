import { Socket, DefaultEventsMap } from 'socket.io';

/**
 * 소켓 1개에 붙는 컨텍스트 (socket.data).
 *
 * RoomGateway 가 connection 시점에 한 번 채워두면,
 * 같은 /rooms 네임스페이스를 공유하는 GameGateway 가 host 검증 등에서 그대로 재사용한다.
 * (이벤트마다 hostToken 을 다시 검증하는 중복을 없애기 위한 규약)
 */
export interface SocketData {
  /** 이 소켓이 속한 방 */
  roomId: string;
  /** host(방 만든 사람) 인지 participant 인지 — connection 때 hostToken 으로 판별 */
  role: 'host' | 'participant';
  /** room:join 으로 닉네임을 확정한 뒤에만 존재. host 나 아직 입장 전 소켓은 undefined */
  nickname?: string;
}

/**
 * socket.data 가 SocketData 로 타입된 Socket.
 * 이벤트 맵은 DefaultEventsMap(자유로운 emit)으로 두고, payload 타입은 room.types.ts 로 관리한다.
 */
export type AppSocket = Socket<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  SocketData
>;
