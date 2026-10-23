import type { GameRoom } from '../../src/GameRoom';
import type { Card, Player } from '../../../shared/types';
import { EVIL_THRESHOLD } from '../../src/constants';
import { isTimerPending } from './timescale';
import { cardLabel } from './cards';

// 게임이 어느 순간에도 지켜야 하는 규칙(불변식)을 검사합니다.
// 서버 핸들러/타이머 콜백 사이(매크로태스크 경계)에서 호출하면 항상 성립해야 합니다.

export type Severity = 'critical' | 'major' | 'minor';

export interface Violation {
  code: string;
  severity: Severity;
  message: string;
  at: number;
  count: number;
}

export const VIOLATION_INFO: Record<string, { severity: Severity; title: string }> = {
  CARD_LOST: { severity: 'minor', title: '카드가 무덤으로 가지 않고 덱/무덤/패 어디에서도 사라짐' },
  CARD_LOST_ON_LEAVE: { severity: 'minor', title: '퇴장한 플레이어의 패가 무덤에 남지 않고 사라짐' },
  CARD_DUPLICATED: { severity: 'minor', title: '같은 카드 id가 두 곳 이상에 존재' },
  CARD_CREATED_UNEXPECTED: { severity: 'major', title: '출처를 알 수 없는 카드가 생겨남' },
  CARD_IN_WRONG_BUCKET: { severity: 'major', title: '카드가 잘못된 패 칸(악의/무기/방패/보물/아이템)에 들어감' },
  MALICE_STALE: { severity: 'major', title: '패와 currentMalice(악의 점수)가 불일치' },
  ALIGNMENT_STALE: { severity: 'major', title: '악의 점수와 선인/악인 성향이 불일치' },
  PENDING_IN_MAIN: { severity: 'major', title: 'MAIN 단계인데 처리 대기 중인 이벤트가 남아 있음' },
  TURN_ON_DEAD_PLAYER: { severity: 'major', title: '죽은 플레이어의 차례로 진행 중' },
  TURN_FLAG_MISMATCH: { severity: 'minor', title: 'isMyTurn 표시가 현재 차례와 다름' },
  TURN_INDEX_DESYNC: { severity: 'major', title: '내부 차례 인덱스와 현재 차례 플레이어가 어긋남 (다음 차례 계산이 틀어짐)' },
  TURN_ORDER_SKIP: { severity: 'major', title: '차례가 다음 생존자를 건너뛰고 넘어감' },
  NO_TURN_TIMER: { severity: 'critical', title: 'MAIN 단계인데 턴 타이머가 꺼져 있음 (차례 주인이 잠수하면 게임이 영원히 멈춤)' },
  GAME_NOT_ENDED: { severity: 'critical', title: '생존자가 1명 이하인데 게임이 끝나지 않음' },
  STUCK_NO_PENDING: { severity: 'critical', title: '이벤트/방어 단계인데 대기 중인 액션이 없음 (영구 정지)' },
  PENDING_NO_TIMER: { severity: 'critical', title: '대기 중인 액션에 제한시간 타이머가 없음 (응답이 없으면 영구 정지)' },
  DEFENSE_TARGET_DEAD: { severity: 'minor', title: '방어 대상이 이미 죽은 상태로 방어 단계가 유지됨' },
  POST_GAME_PHASE_CHANGE: { severity: 'critical', title: '게임 종료(ENDED) 후 단계가 다시 바뀜' },
  POST_GAME_DEATH: { severity: 'major', title: '게임 종료 후 생존 상태가 바뀜' },
  LINK_TO_DEAD: { severity: 'minor', title: '인연의 끈이 죽은/없는 플레이어에게 남아 있음' },
  GAME_RESET_TO_LOBBY: { severity: 'critical', title: '진행 중인 게임이 대기실(WAITING)로 초기화됨' },
};

interface Located {
  card: Card;
  where: string;
  ownerId?: string;
}

export function collectCards(room: GameRoom): Located[] {
  const out: Located[] = [];
  room.deck.forEach((card) => out.push({ card, where: '덱' }));
  room.graveyard.forEach((card) => out.push({ card, where: '무덤' }));
  for (const p of room.players) {
    for (const bucket of ['malices', 'weapons', 'shields', 'treasures', 'items'] as const) {
      p.hand[bucket].forEach((card) => out.push({ card, where: `${p.name}의 패(${bucket})`, ownerId: p.id }));
    }
  }
  // 이벤트 진행 중 제출되어 잠시 보관 중인 카드 (마육검 입찰, 제물, 인체 연성, 룰렛 등)
  const pending = room.pendingAction;
  if (pending) {
    for (const [pid, value] of Object.entries(pending.responses ?? {})) {
      if (!Array.isArray(value)) continue;
      for (const v of value) {
        if (v && typeof v === 'object' && typeof v.id === 'string' && 'category' in v) {
          const owner = room.players.find((p) => p.id === pid)?.name ?? pid;
          out.push({ card: v as Card, where: `제출 대기(${owner})` });
        }
      }
    }
  }
  return out;
}

export function expectedMalice(p: Player): number {
  const fromMalice = p.hand.malices.reduce((s, c) => s + (c.maliceValue ?? 0), 0);
  const tools = [...p.hand.weapons, ...p.hand.shields, ...p.hand.treasures, ...p.hand.items];
  const fromTools = tools.reduce((s, c) => s + (c.maliceValue ?? 0) + (c.maliceModifier ?? 0), 0);
  return Math.max(0, fromMalice + fromTools);
}

export class InvariantTracker {
  violations: Violation[] = [];
  private byKey = new Map<string, Violation>();
  private baseline = new Map<string, string>();
  private lastWhere = new Map<string, string>();
  private lastOwner = new Map<string, string>();
  private endedSnapshot: string | null = null;
  private restoreNextTurn: (() => void) | null = null;
  private restoreEventHook: (() => void) | null = null;
  private lastEvent = '';
  private lastPhase = '';

  constructor(readonly room: GameRoom, readonly onViolation?: (v: Violation) => void) {
    this.rebaseline();
    this.hookTurnOrder();
    this.hookEvents();
  }

  // 카드가 사라졌을 때 어떤 이벤트 도중이었는지 보고서에 남기기 위해 이벤트 시작을 동기적으로 기록합니다.
  private hookEvents(): void {
    const room = this.room as any;
    const original = room.startEventResolution;
    room.startEventResolution = (initiator: Player, eventCard: Card, ...rest: any[]) => {
      this.lastEvent = eventCard?.name ?? '';
      return original.call(room, initiator, eventCard, ...rest);
    };
    this.restoreEventHook = () => {
      room.startEventResolution = original;
    };
  }

  private ctx(): string {
    return this.lastEvent ? ` [최근 이벤트: ${this.lastEvent}]` : '';
  }

  /** 테스트가 덱/패를 직접 조작했거나 새 게임을 시작했을 때 기준선을 다시 잡습니다. */
  rebaseline(): void {
    this.baseline.clear();
    this.lastWhere.clear();
    this.lastOwner.clear();
    for (const { card, where, ownerId } of collectCards(this.room)) {
      this.baseline.set(card.id, cardLabel(card));
      this.lastWhere.set(card.id, where);
      if (ownerId) this.lastOwner.set(card.id, ownerId);
    }
    this.endedSnapshot = null;
    this.lastPhase = this.room.phase;
  }

  dispose(): void {
    this.restoreNextTurn?.();
    this.restoreEventHook?.();
  }

  private report(code: string, message: string, key = code + '|' + message): void {
    const existing = this.byKey.get(key);
    if (existing) {
      existing.count++;
      return;
    }
    const info = VIOLATION_INFO[code] ?? { severity: 'major' as Severity };
    const v: Violation = { code, severity: info.severity, message, at: Date.now(), count: 1 };
    this.byKey.set(key, v);
    this.violations.push(v);
    this.onViolation?.(v);
  }

  // nextTurn()이 호출될 때마다 "직전 차례의 다음 생존자"로 넘어갔는지 동기적으로 확인합니다.
  private hookTurnOrder(): void {
    const room = this.room as any;
    const original = room.nextTurn;
    room.nextTurn = (...args: any[]) => {
      const before: string | null = room.currentTurnPlayerId;
      const result = original.apply(room, args);
      if (room.phase === 'ENDED') return result;
      const after: string | null = room.currentTurnPlayerId;
      const players: Player[] = room.players;
      const i = players.findIndex((p) => p.id === before);
      if (before && i !== -1 && after) {
        let expected: Player | undefined;
        for (let k = 1; k <= players.length; k++) {
          const cand = players[(i + k) % players.length];
          if (cand.isAlive) {
            expected = cand;
            break;
          }
        }
        if (expected && expected.id !== after) {
          const name = (id: string) => players.find((p) => p.id === id)?.name ?? id;
          this.report(
            'TURN_ORDER_SKIP',
            `${name(before)} 다음 차례는 ${expected.name}이어야 하는데 ${name(after)}에게 넘어감 (좌석: ${players.map((p) => `${p.name}${p.isAlive ? '' : '†'}`).join(' → ')})`,
          );
        }
      }
      return result;
    };
    this.restoreNextTurn = () => {
      room.nextTurn = original;
    };
  }

  check(): Violation[] {
    const before = this.violations.length;
    const room = this.room;
    const anyRoom = room as any;

    // ── 카드 보존 ──
    const located = collectCards(room);
    const counts = new Map<string, Located[]>();
    for (const loc of located) {
      const list = counts.get(loc.card.id) ?? [];
      list.push(loc);
      counts.set(loc.card.id, list);
    }
    for (const [id, label] of this.baseline) {
      const where = counts.get(id);
      if (!where) {
        const owner = this.lastOwner.get(id);
        if (owner && !room.players.some((p) => p.id === owner)) {
          this.report('CARD_LOST_ON_LEAVE', `퇴장한 플레이어(${this.lastWhere.get(id)})의 ${label} 카드가 사라짐`, 'CARD_LOST|' + id);
        } else {
          this.report('CARD_LOST', `${label} 카드가 사라짐 (마지막 위치: ${this.lastWhere.get(id) ?? '?'})${this.ctx()}`, 'CARD_LOST|' + id);
        }
      }
    }
    for (const [id, list] of counts) {
      if (list.length > 1) {
        this.report('CARD_DUPLICATED', `${cardLabel(list[0].card)} 카드가 ${list.length}곳에 동시에 존재: ${list.map((l) => l.where).join(', ')}${this.ctx()}`, 'CARD_DUPLICATED|' + id);
      }
      if (!this.baseline.has(id)) {
        const card = list[0].card;
        if (card.name !== '마육검' && card.name !== '엑스칼리버') {
          this.report('CARD_CREATED_UNEXPECTED', `${cardLabel(card)} 카드가 새로 생겨남 (위치: ${list[0].where})`, 'CARD_CREATED|' + id);
        }
        this.baseline.set(id, cardLabel(card));
      }
      this.lastWhere.set(id, list[0].where);
      if (list[0].ownerId) this.lastOwner.set(id, list[0].ownerId);
      else this.lastOwner.delete(id);
    }

    // ── 패 분류 & 악의 계산 ──
    for (const p of room.players) {
      const bucketRule: Record<string, (c: Card) => boolean> = {
        malices: (c) => c.category === 'MALICE',
        weapons: (c) => c.category === 'TOOL' && (c as any).toolType === 'WEAPON',
        shields: (c) => c.category === 'TOOL' && (c as any).toolType === 'SHIELD',
        treasures: (c) => c.category === 'TOOL' && (c as any).toolType === 'TREASURE',
        items: (c) => c.category === 'TOOL' && (c as any).toolType === 'ITEM',
      };
      for (const [bucket, ok] of Object.entries(bucketRule)) {
        for (const c of (p.hand as any)[bucket] as Card[]) {
          if (!ok(c)) this.report('CARD_IN_WRONG_BUCKET', `${p.name}의 ${bucket}에 ${cardLabel(c)}(${c.category}) 카드가 있음`, 'BUCKET|' + c.id);
        }
      }
      const exp = expectedMalice(p);
      if (p.currentMalice !== exp) {
        this.report('MALICE_STALE', `${p.name}: 패 기준 악의 ${exp}점인데 currentMalice=${p.currentMalice}`, 'MALICE|' + p.id + '|' + exp + '|' + p.currentMalice);
      } else {
        const align = exp >= EVIL_THRESHOLD ? 'EVIL' : 'GOOD';
        if (p.alignment !== align) this.report('ALIGNMENT_STALE', `${p.name}: 악의 ${exp}점인데 성향=${p.alignment}`, 'ALIGN|' + p.id + '|' + exp);
      }
    }

    // ── 단계(phase)별 상태 ──
    const alive = room.getAlivePlayers();
    const pending = room.pendingAction;
    const phase = room.phase;

    if (phase === 'WAITING' && this.lastPhase && this.lastPhase !== 'WAITING' && this.lastPhase !== 'ENDED') {
      this.report('GAME_RESET_TO_LOBBY', `${this.lastPhase} 단계에서 게임이 대기실로 초기화됨`);
    }
    this.lastPhase = phase;

    if (phase === 'ENDED') {
      const snap = JSON.stringify(room.players.map((p) => [p.id, p.isAlive]));
      if (this.endedSnapshot === null) this.endedSnapshot = snap;
      else if (snap !== this.endedSnapshot) this.report('POST_GAME_DEATH', '게임 종료 이후 생존 상태가 바뀜');
    } else if (this.endedSnapshot !== null) {
      this.report('POST_GAME_PHASE_CHANGE', `게임 종료(ENDED) 이후 단계가 ${phase}로 바뀜`);
      this.endedSnapshot = null;
    }

    if (phase === 'MAIN') {
      if (pending) this.report('PENDING_IN_MAIN', `MAIN 단계인데 pendingAction(${pending.type}/${pending.eventName ?? '무기 공격'})이 남아 있음`);
      if (alive.length <= 1) this.report('GAME_NOT_ENDED', `생존자 ${alive.length}명인데 단계가 MAIN`);
      const cur = room.currentTurnPlayerId ? room.getPlayerById(room.currentTurnPlayerId) : undefined;
      if (!cur) this.report('TURN_ON_DEAD_PLAYER', '현재 차례 플레이어가 방에 없음');
      else if (!cur.isAlive) this.report('TURN_ON_DEAD_PLAYER', `죽은 ${cur.name}의 차례`);
      const flagged = room.players.filter((p) => p.isMyTurn).map((p) => p.id);
      if (flagged.length !== 1 || flagged[0] !== room.currentTurnPlayerId) {
        this.report('TURN_FLAG_MISMATCH', `isMyTurn=${flagged.length}명, 현재 차례와 불일치`);
      }
      const idx = anyRoom.currentTurnIndex as number;
      if (room.players[idx]?.id !== room.currentTurnPlayerId) {
        this.report('TURN_INDEX_DESYNC', `currentTurnIndex=${idx}(${room.players[idx]?.name ?? '없음'})인데 현재 차례는 ${cur?.name ?? room.currentTurnPlayerId}`);
      }
      if (!isTimerPending(room.turnTimer) || room.isTurnTimerPaused) {
        this.report('NO_TURN_TIMER', `${cur?.name ?? '?'}의 차례인데 턴 타이머가 동작하지 않음 (paused=${room.isTurnTimerPaused})`);
      }
    }

    if (phase === 'RESOLVING_EVENT' || phase === 'WAITING_FOR_DEFENSE') {
      if (!pending) {
        this.report('STUCK_NO_PENDING', `${phase} 단계(이벤트: ${room.activeEvent?.name ?? '없음'})인데 대기 중인 액션이 없음`);
      } else {
        if (!isTimerPending(pending.timer)) {
          this.report('PENDING_NO_TIMER', `${pending.type}/${pending.eventName ?? '무기 공격'} 액션에 살아 있는 제한시간 타이머가 없음`);
        }
        if (phase === 'WAITING_FOR_DEFENSE' && pending.targetId) {
          const target = room.getPlayerById(pending.targetId);
          if (!target || !target.isAlive) this.report('DEFENSE_TARGET_DEAD', `방어 대상 ${target?.name ?? pending.targetId}이(가) 이미 사망/퇴장`);
        }
      }
    }

    if (room.linkedPlayers) {
      for (const id of room.linkedPlayers) {
        const p = room.getPlayerById(id);
        if (!p || !p.isAlive) this.report('LINK_TO_DEAD', `인연의 끈이 ${p?.name ?? '퇴장한 플레이어'}에게 남아 있음`);
      }
    }

    return this.violations.slice(before);
  }
}
