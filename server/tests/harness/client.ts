import { io as connectIo, Socket } from 'socket.io-client';
import type { SanitizedGameState, PublicPlayerInfo, PlayerScore } from '../../../shared/types';

// 실제 브라우저 클라이언트처럼 소켓으로 접속하는 테스트용 플레이어.

export interface RecordedEvent {
  t: number;
  ev: string;
  args: any[];
}

export const REQUEST_EVENTS = [
  'request_vote',
  'request_target',
  'request_cards',
  'request_excalibur',
  'request_mayuk_choice',
  'request_prophecy',
] as const;

export class TestClient {
  readonly socket: Socket;
  readonly name: string;
  roomCode = '';
  state: SanitizedGameState | null = null;
  roomPlayers: PublicPlayerInfo[] = [];
  events: RecordedEvent[] = [];
  gameOvers: PlayerScore[][] = [];
  lastEventAt = Date.now();
  private listeners = new Set<() => void>();

  constructor(url: string, name: string) {
    this.name = name;
    this.socket = connectIo(url, { transports: ['websocket'], forceNew: true, reconnection: false, autoConnect: false });
    this.socket.onAny((ev: string, ...args: any[]) => {
      this.lastEventAt = Date.now();
      this.events.push({ t: this.lastEventAt, ev, args });
      if (this.events.length > 5000) this.events.splice(0, 2500);
      if (ev === 'game_state_update') this.state = args[0];
      if (ev === 'room_state_update') this.roomPlayers = args[0];
      if (ev === 'game_over') this.gameOvers.push(args[0]);
      for (const fn of this.listeners) fn();
    });
  }

  get id(): string {
    return this.socket.id ?? '';
  }

  connect(timeoutMs = 3000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.name} 접속 시간 초과`)), timeoutMs);
      this.socket.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.once('connect_error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      this.socket.connect();
    });
  }

  /** 원시 emit (잘못된 인자를 보내는 견고성 테스트용). */
  raw(ev: string, ...args: any[]): void {
    this.socket.emit(ev, ...args);
  }

  /** roomCode를 첫 인자로 붙여 emit합니다. */
  act(ev: string, ...args: any[]): void {
    this.socket.emit(ev, this.roomCode, ...args);
  }

  join(roomCode: string): void {
    this.roomCode = roomCode;
    this.socket.emit('join_room', roomCode, this.name);
  }

  onEvent(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  eventsOf(ev: string, since = 0): RecordedEvent[] {
    return this.events.filter((e) => e.ev === ev && e.t >= since);
  }

  lastOf(ev: string): RecordedEvent | undefined {
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i].ev === ev) return this.events[i];
    }
    return undefined;
  }

  /** action_result / chat_message 텍스트 목록. */
  messages(since = 0): string[] {
    return this.events
      .filter((e) => (e.ev === 'action_result' || e.ev === 'chat_message') && e.t >= since)
      .map((e) => (e.ev === 'chat_message' ? `[채팅] ${e.args[0]}: ${e.args[1]}` : String(e.args[0])));
  }

  close(): void {
    this.listeners.clear();
    this.socket.removeAllListeners();
    this.socket.disconnect();
  }
}

/** 조건이 참이 될 때까지 기다립니다. 실패하면 label을 담은 에러를 던집니다. */
export async function waitUntil(pred: () => boolean, timeoutMs = 2000, label = '조건'): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`${label} 대기 시간 초과 (${timeoutMs}ms)`);
    }
    await sleep(5);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
