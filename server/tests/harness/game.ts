import type { GameRoom } from '../../src/GameRoom';
import type { Card, GamePhase, Player } from '../../../shared/types';
import { startTestServer, TestServer } from './server';
import { TestClient, waitUntil, sleep } from './client';
import { makeCard, CardSpec } from './cards';
import { InvariantTracker, Violation } from './invariants';

// 시나리오 테스트용 게임 셋업: 소켓 클라이언트 N명을 방에 넣고 게임을 시작한 뒤,
// 원하는 패/덱/차례로 상태를 조작(리깅)합니다.

export const DEFAULT_NAMES = ['가람', '나래', '다온', '라온', '마루', '바다', '사랑'];

export interface GameOptions {
  players?: number;
  names?: string[];
  /** 플레이어 번호 → 패에 넣을 카드 (이름 또는 카드 번호). 지정하지 않은 플레이어는 빈 패. */
  hands?: Record<number, CardSpec[]>;
  /** 덱 맨 위부터의 카드 순서. 첫 번째가 다음 드로우에 나옵니다. */
  deck?: CardSpec[];
  /** deck 아래에 깔아 둘 무해한 카드(코인) 장수. 기본 10장. */
  filler?: number;
  /** 누구의 차례로 시작할지 (기본 0번). */
  turn?: number;
  /** 현재 차례 플레이어가 이미 카드를 뽑은 상태로 둘지. */
  hasDrawn?: boolean;
  /** 죽은 상태로 시작할 플레이어 번호 (패는 그대로). */
  dead?: number[];
  /** 서버 기준 이벤트 제한시간(ms). 실제 대기 시간은 timeScale이 곱해집니다. */
  eventTimeoutMs?: number;
  /** 서버 기준 턴 제한시간(ms). 기본 600000(10분) — 시나리오 도중 턴이 자동으로 넘어가지 않게 길게 잡습니다. */
  turnDurationMs?: number;
}

let roomSeq = 0;

export class GameCtx {
  readonly t0 = Date.now();
  tracker!: InvariantTracker;

  constructor(
    readonly srv: TestServer,
    readonly code: string,
    readonly clients: TestClient[],
  ) {}

  get room(): GameRoom {
    const room = this.srv.rooms.get(this.code);
    if (!room) throw new Error(`방 ${this.code}이(가) 서버에 없습니다`);
    return room;
  }

  c(i: number): TestClient {
    return this.clients[i];
  }

  /** 서버 쪽 Player 객체 (클라이언트 번호 기준). */
  p(i: number): Player {
    const p = this.room.getPlayerById(this.clients[i].id);
    if (!p) throw new Error(`${this.clients[i].name}이(가) 방에 없습니다`);
    return p;
  }

  /** 소켓 id → 클라이언트 번호. */
  indexOf(id: string | null | undefined): number {
    return this.clients.findIndex((c) => c.id === id);
  }

  hand(i: number): string[] {
    const h = this.p(i).hand;
    return [...h.malices, ...h.weapons, ...h.shields, ...h.treasures, ...h.items].map((c) => c.name);
  }

  handCards(i: number): Card[] {
    const h = this.p(i).hand;
    return [...h.malices, ...h.weapons, ...h.shields, ...h.treasures, ...h.items];
  }

  /** 패에서 이름으로 카드 id를 찾습니다. */
  cardId(i: number, name: string): string {
    const card = this.handCards(i).find((c) => c.name === name || `${c.name}#${c.cardId}` === name);
    if (!card) throw new Error(`${this.clients[i].name}의 패에 ${name}이(가) 없습니다 (패: ${this.hand(i).join(', ') || '없음'})`);
    return card.id;
  }

  /** 카드를 패에 추가하고 기준선을 다시 잡습니다. */
  give(i: number, ...specs: CardSpec[]): Card[] {
    const p = this.p(i);
    const cards = specs.map(makeCard);
    cards.forEach((c) => this.room.addCardToHand(p, c));
    this.room.recalculateMalice(p);
    this.tracker?.rebaseline();
    this.broadcast();
    return cards;
  }

  /** 덱을 통째로 교체합니다. specs[0]이 다음에 뽑힙니다. */
  setDeck(specs: CardSpec[], filler = 10): void {
    const top = specs.map(makeCard);
    const below = Array.from({ length: filler }, () => makeCard('코인'));
    this.room.deck = [...below, ...top.reverse()];
    this.tracker?.rebaseline();
    this.broadcast();
  }

  broadcast(): void {
    this.room.onStateChange?.();
  }

  /** 모든 클라이언트가 ms 동안 아무 이벤트도 받지 않을 때까지 기다립니다. */
  async settle(quietMs = 40, maxMs = 3000): Promise<void> {
    const start = Date.now();
    await sleep(5);
    while (Date.now() - start < maxMs) {
      const last = Math.max(...this.clients.map((c) => c.lastEventAt));
      if (Date.now() - last >= quietMs) return;
      await sleep(5);
    }
  }

  waitFor(pred: () => boolean, label = '조건', timeoutMs = 3000): Promise<void> {
    return waitUntil(pred, timeoutMs, label);
  }

  waitPhase(phase: GamePhase, timeoutMs = 3000): Promise<void> {
    return waitUntil(() => this.srv.rooms.get(this.code)?.phase === phase, timeoutMs, `phase=${phase}`);
  }

  /** 서버 제한시간 타이머가 터질 만큼 기다립니다 (timeScale 반영). */
  async waitServerMs(serverMs: number): Promise<void> {
    const { scaled } = await import('./timescale');
    await sleep(scaled(serverMs) + 30);
  }

  msgs(i = 0, since = this.t0): string[] {
    return this.clients[i].messages(since);
  }

  requests(i: number, ev: string, since = this.t0): any[][] {
    return this.clients[i].eventsOf(ev, since).map((e) => e.args);
  }

  check(): Violation[] {
    return this.tracker.check();
  }

  async close(): Promise<void> {
    const room = this.srv.rooms.get(this.code);
    this.tracker?.check();
    this.tracker?.dispose();
    // 게임 중 퇴장 처리(사망 처리 등)가 정리 과정에서 일어나지 않도록 대기실 상태로 돌려 둡니다.
    room?.resetToLobby();
    this.clients.forEach((c) => c.close());
    await waitUntil(() => !this.srv.rooms.has(this.code), 2000, '방 정리').catch(() => undefined);
  }
}

export async function createGame(opts: GameOptions = {}): Promise<GameCtx> {
  const srv = await startTestServer();
  const n = opts.players ?? opts.names?.length ?? 3;
  const names = (opts.names ?? DEFAULT_NAMES).slice(0, n);
  const code = `T${++roomSeq}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

  const clients = names.map((name) => new TestClient(srv.url, name));
  await Promise.all(clients.map((c) => c.connect()));
  for (const [i, c] of clients.entries()) {
    c.join(code);
    await waitUntil(() => (srv.rooms.get(code)?.players.length ?? 0) === i + 1, 2000, `${c.name} 입장`);
  }

  const g = new GameCtx(srv, code, clients);
  clients[0].act('start_game');
  await waitUntil(() => g.room.phase === 'MAIN', 2000, '게임 시작');
  await waitUntil(() => clients.every((c) => c.state?.phase === 'MAIN'), 2000, '시작 상태 수신');

  rig(g, opts);
  g.tracker = new InvariantTracker(g.room);
  await g.settle();
  return g;
}

function rig(g: GameCtx, opts: GameOptions): void {
  const room = g.room as any;
  if (room.pendingAction?.timer) clearTimeout(room.pendingAction.timer);
  room.pendingAction = null;
  room.activeEvent = null;
  room.silenceMode = false;
  room.freeForAll = false;
  room.linkedPlayers = null;
  room.graveyard = [];
  if (opts.eventTimeoutMs) room.eventTimeoutMs = opts.eventTimeoutMs;
  room.turnDurationMs = opts.turnDurationMs ?? 600000;

  g.clients.forEach((_, i) => {
    const p = g.p(i);
    p.hand = { malices: [], weapons: [], shields: [], treasures: [], items: [] };
    for (const spec of opts.hands?.[i] ?? []) room.addCardToHand(p, makeCard(spec));
    p.isAlive = !(opts.dead ?? []).includes(i);
    room.recalculateMalice(p);
  });

  const top = (opts.deck ?? []).map(makeCard);
  const below = Array.from({ length: opts.filler ?? 10 }, () => makeCard('코인'));
  room.deck = [...below, ...top.reverse()];

  const turn = opts.turn ?? 0;
  room.phase = 'MAIN';
  room.currentTurnIndex = turn;
  room.currentTurnPlayerId = g.clients[turn].id;
  for (const p of room.players as Player[]) {
    p.isMyTurn = p.id === room.currentTurnPlayerId;
    p.hasDrawnThisTurn = p.isMyTurn ? !!opts.hasDrawn : false;
    p.hasUsedWeaponThisTurn = false;
    p.isSilenced = false;
  }
  room.startTurnTimer(room.turnDurationMs);
  g.broadcast();
}
