import type { Card, SanitizedGameState } from '../../../shared/types';
import { TestClient } from '../harness/client';

// 무작위로 (대부분은 합법적인) 행동을 하는 봇.
// chaosRate만큼은 일부러 잘못된 이벤트/인자를 보내 서버의 입력 검증을 시험합니다.

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BotOptions {
  rng: Rng;
  /** 요청을 일부러 무시(잠수)할 확률 → 서버 제한시간 처리 경로를 시험 */
  afkRate: number;
  /** 잘못된 이벤트/인자를 보낼 확률 (생각할 때마다) */
  chaosRate: number;
  /** 채팅을 칠 확률 (눈 없는 괴물 중엔 1/4) */
  chatRate: number;
  /** 다른 봇들의 카드 id 등을 알아내 chaos 인자로 쓰기 위한 정보원 */
  knownIds: () => { players: string[]; cards: string[] };
  log: (line: string) => void;
  /** chaos 입력에 return_to_lobby를 포함할지 (게임을 통째로 초기화하므로 기본 제외) */
  chaosReset?: boolean;
}

const CLIENT_EVENTS = [
  'join_room', 'start_game', 'draw_card', 'resume_draw', 'end_turn', 'play_tool', 'play_shield', 'skip_defense',
  'confirm_reveal', 'submit_vote', 'submit_target', 'submit_gift', 'submit_transmutation', 'submit_cards',
  'claim_excalibur', 'skip_excalibur', 'store_mayuk_sword', 'use_mayuk_sword_now', 'cut_fate_link', 'kill_bait_monster',
  'submit_prophecy', 'interrupt_action', 'play_item', 'send_chat', 'return_to_lobby', 'leave_room',
];

export interface ChaosRecord {
  t: number;
  bot: string;
  ev: string;
  args: unknown[];
}

export class Bot {
  private timer: NodeJS.Timeout | null = null;
  private handledRequests = new Set<number>();
  private lastDefenseKey = '';
  private lastRevealKey = '';
  private lastMayukKey = '';
  private lastExcaliburKey = '';
  private stopped = false;
  chaos: ChaosRecord[] = [];
  actions = 0;

  constructor(readonly c: TestClient, readonly opts: BotOptions) {
    c.onEvent(() => this.schedule());
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private r(): number {
    return this.opts.rng();
  }

  private pick<T>(arr: T[]): T | undefined {
    return arr.length ? arr[Math.floor(this.r() * arr.length)] : undefined;
  }

  private schedule(delay?: number): void {
    if (this.stopped || this.timer) return;
    const d = delay ?? 1 + Math.floor(this.r() * 15);
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        this.think();
      } catch (e: any) {
        this.opts.log(`[봇 오류] ${this.c.name}: ${e?.message}`);
      }
    }, d);
  }

  private emit(ev: string, ...args: unknown[]): void {
    this.actions++;
    this.opts.log(`${this.c.name} → ${ev}(${args.map((a) => (typeof a === 'string' && a.length > 24 ? a.slice(0, 8) + '…' : JSON.stringify(a))).join(', ')})`);
    this.c.act(ev, ...args);
  }

  private get s(): SanitizedGameState | null {
    return this.c.state;
  }

  private me() {
    return this.s?.players.find((p) => p.id === this.c.id);
  }

  private handAll(): Card[] {
    const h = this.s?.myInfo.hand;
    if (!h) return [];
    return [...h.malices, ...h.weapons, ...h.shields, ...h.treasures, ...h.items];
  }

  private aliveOthers(): string[] {
    return (this.s?.players ?? []).filter((p) => p.isAlive && p.id !== this.c.id).map((p) => p.id);
  }

  private isMaliceish(c: Card): boolean {
    return c.category === 'MALICE' || ((c as any).maliceValue ?? 0) > 0;
  }

  private think(): void {
    const s = this.s;
    if (!s || this.stopped) return;
    const me = this.me();
    const alive = !!me?.isAlive;

    if (this.r() < this.opts.chaosRate && s.phase !== 'WAITING' && s.phase !== 'ENDED') {
      this.doChaos();
      this.schedule(5 + Math.floor(this.r() * 30));
      return;
    }

    if (this.r() < this.opts.chatRate * (s.silenceMode ? 0.25 : 1)) {
      this.emit('send_chat', this.pick(['ㅋㅋ', '누가 악인이지?', '살려줘', '...']));
    }

    // 1) 서버가 보낸 요청(request_*)에 응답
    const pending = this.c.events
      .map((e, i) => ({ e, i }))
      .filter(({ e, i }) => e.ev.startsWith('request_') && !this.handledRequests.has(e.t * 1000 + i));
    for (const { e, i } of pending.slice(-3)) {
      this.handledRequests.add(e.t * 1000 + i);
      if (this.r() < this.opts.afkRate) continue;
      this.answerRequest(e.ev, e.args, alive);
    }

    // 2) 상태 기반 행동
    if (s.revealedCardsInfo) {
      const key = `${s.revealedCardsInfo.playerId}|${s.revealedCardsInfo.reason}`;
      if (key !== this.lastRevealKey && this.r() > this.opts.afkRate) {
        this.lastRevealKey = key;
        if (alive || this.r() < 0.3) this.emit('confirm_reveal');
      }
    }

    if (s.phase === 'WAITING_FOR_DEFENSE' && alive) this.defend(s);

    if (s.phase === 'RESOLVING_EVENT' && alive) {
      if (s.activeEventName === '엑스칼리버') {
        const key = `${s.actionDeadline}`;
        if (key !== this.lastExcaliburKey && this.r() > this.opts.afkRate) {
          this.lastExcaliburKey = key;
          this.emit(s.myInfo.currentMalice === 0 && this.r() < 0.6 ? 'claim_excalibur' : 'skip_excalibur');
        }
      }
      if (s.mayukWinnerId === this.c.id) {
        const key = `${s.actionDeadline}`;
        if (key !== this.lastMayukKey && this.r() > this.opts.afkRate) {
          this.lastMayukKey = key;
          const target = this.pick(this.aliveOthers());
          if (target && this.r() < 0.6) this.emit('use_mayuk_sword_now', target);
          else this.emit('store_mayuk_sword');
        }
      }
      const kit = s.myInfo.hand.items.find((c) => c.name === '긴급탈출키트');
      if (kit && this.r() < 0.08) this.emit('interrupt_action', kit.id);
    }

    if (s.phase === 'MAIN' && alive) this.mainPhase(s);
  }

  private answerRequest(ev: string, args: any[], alive: boolean): void {
    const s = this.s!;
    const hand = this.handAll();
    if (ev === 'request_vote') {
      const [eventName, candidates] = args as [string, string[]];
      if (!alive && this.r() > 0.2) return;
      if (eventName === '미끼') {
        const weapon = this.pick(s.myInfo.hand.weapons);
        if (weapon && this.r() < 0.3) {
          this.emit('kill_bait_monster', weapon.id);
          return;
        }
      }
      const choice = eventName === '구덩이' ? (this.r() < 0.75 ? 'SAVE' : 'DROP') : this.pick(candidates);
      const hasDictator = s.myInfo.hand.items.some((c) => c.name === '독재');
      this.emit('submit_vote', choice, hasDictator && this.r() < 0.4);
    } else if (ev === 'request_target') {
      const [eventName, targets] = args as [string, string[]];
      if (eventName === '선물') {
        const card = this.pick(hand);
        const target = this.pick(targets);
        if (card && target) this.emit('submit_gift', card.id, target);
        return;
      }
      const target = this.pick(targets);
      if (target) this.emit('submit_target', target);
    } else if (ev === 'request_cards') {
      const [eventName] = args as [string];
      if (!alive) {
        if (this.r() < 0.1) this.emit('submit_cards', []);
        return;
      }
      this.submitCards(eventName, hand);
    } else if (ev === 'request_mayuk_choice') {
      const [, targets] = args as [string, string[]];
      const target = this.pick(targets);
      if (target && this.r() < 0.6) this.emit('use_mayuk_sword_now', target);
      else this.emit('store_mayuk_sword');
    } else if (ev === 'request_prophecy') {
      const [, cards] = args as [string, Card[]];
      const ids = cards.map((c) => c.id).sort(() => this.r() - 0.5);
      this.emit('submit_prophecy', ids);
    } else if (ev === 'request_excalibur') {
      // 상태 기반 처리(think)에서 함께 다룸
    }
  }

  private submitCards(eventName: string, hand: Card[]): void {
    const s = this.s!;
    const weapons = s.myInfo.hand.weapons;
    const treasures = s.myInfo.hand.treasures;
    const maliceish = hand.filter((c) => this.isMaliceish(c));
    const tools = hand.filter((c) => c.category === 'TOOL');
    const nonMaliceTools = tools.filter((c) => !this.isMaliceish(c));
    const subset = (arr: Card[], max: number) => arr.filter(() => this.r() < 0.5).slice(0, max).map((c) => c.id);

    switch (eventName) {
      case '무장해제': {
        const w = this.pick(weapons);
        const m = this.pick(maliceish.filter((c) => c.id !== w?.id));
        this.emit('submit_cards', w && m && this.r() < 0.7 ? [w.id, m.id] : []);
        break;
      }
      case '면죄부': {
        const tr = this.pick(treasures);
        const m = this.pick(maliceish.filter((c) => c.id !== tr?.id));
        this.emit('submit_cards', tr && m && this.r() < 0.7 ? [tr.id, m.id] : []);
        break;
      }
      case '인체 연성':
        this.emit('submit_cards', subset(tools, 3));
        break;
      case '마육검':
        this.emit('submit_cards', subset(maliceish, 5));
        break;
      case '제물':
        this.emit('submit_cards', subset(nonMaliceTools, 2));
        break;
      case '룰렛': {
        const c = this.pick(hand);
        if (c) this.emit('submit_cards', [c.id]);
        break;
      }
      default: {
        const c = this.pick(hand);
        this.emit('submit_cards', c ? [c.id] : []);
      }
    }
  }

  private defend(s: SanitizedGameState): void {
    const key = `${s.defenseTargetId}|${s.defenseInitiatorId}|${s.actionDeadline}`;
    if (key === this.lastDefenseKey) return;
    if (this.r() < this.opts.afkRate) {
      this.lastDefenseKey = key;
      return;
    }
    const me = this.c.id;
    const isArrow = s.activeEventName === '화살 함정';
    const isTarget = s.defenseTargetId === me;
    const shields = s.myInfo.hand.shields;
    const items = s.myInfo.hand.items;

    if (isTarget) {
      this.lastDefenseKey = key;
      const roll = this.r();
      const humanShield = items.find((c) => c.name === '인간 방패');
      const silence = items.find((c) => c.name === '침묵');
      const kit = items.find((c) => c.name === '긴급탈출키트');
      if (shields.length && roll < 0.55) {
        this.emit('play_shield', this.pick(shields)!.id);
      } else if (humanShield && roll < 0.7) {
        const cands = this.aliveOthers().filter((id) => id !== s.defenseInitiatorId);
        const t = this.pick(cands);
        if (t) this.emit('interrupt_action', humanShield.id, t);
        else this.emit('skip_defense');
      } else if (silence && roll < 0.8) {
        this.emit('interrupt_action', silence.id);
      } else if (kit && roll < 0.85) {
        this.emit('interrupt_action', kit.id);
      } else {
        this.emit('skip_defense');
      }
      return;
    }

    const angel = shields.find((c) => c.name === '수호천사');
    if ((isArrow && shields.length) || (angel && s.defenseInitiatorId !== me)) {
      this.lastDefenseKey = key;
      if (this.r() < 0.35) this.emit('play_shield', (isArrow ? this.pick(shields)! : angel!).id);
      else this.emit('skip_defense');
    }
  }

  private mainPhase(s: SanitizedGameState): void {
    const me = this.c.id;
    const myTurn = s.currentTurnPlayerId === me;
    const weapons = s.myInfo.hand.weapons;
    const targets = this.aliveOthers();

    if (s.freeForAll && !myTurn && weapons.length && targets.length && this.r() < 0.15) {
      this.emit('play_tool', this.pick(weapons)!.id, this.pick(targets));
      return;
    }
    if (!myTurn) {
      // 차례가 아니어도 인연의 끈은 무기로 끊을 수 있음 (규칙상 아무나)
      if (s.linkedPlayers && weapons.length && this.r() < 0.05) this.emit('cut_fate_link', this.pick(weapons)!.id);
      return;
    }
    if (this.r() < this.opts.afkRate * 0.5) return; // 차례 잠수 → 턴 타이머 경로

    const canAttack = weapons.length > 0 && !s.myInfo.hasUsedWeaponThisTurn && targets.length > 0;
    const tie = s.myInfo.hand.items.find((c) => c.name === '인연의 끈');
    const roll = this.r();

    if (!s.myInfo.hasDrawnThisTurn) {
      if (canAttack && roll < 0.15) this.emit('play_tool', this.pick(weapons)!.id, this.pick(targets));
      else if (tie && roll < 0.2 && (s.players.filter((p) => p.isAlive).length >= 2)) {
        const alive = s.players.filter((p) => p.isAlive).map((p) => p.id).sort(() => this.r() - 0.5);
        this.emit('play_item', tie.id, alive.slice(0, 2));
      } else this.emit('draw_card');
      return;
    }
    if (canAttack && roll < 0.4) this.emit('play_tool', this.pick(weapons)!.id, this.pick(targets));
    else if (tie && roll < 0.5) {
      const alive = s.players.filter((p) => p.isAlive).map((p) => p.id).sort(() => this.r() - 0.5);
      this.emit('play_item', tie.id, alive.slice(0, 2));
    } else if (s.linkedPlayers?.includes(me) && weapons.length && roll < 0.55) this.emit('cut_fate_link', this.pick(weapons)!.id);
    else this.emit('end_turn');
  }

  // ── 잘못된 입력 ──
  private doChaos(): void {
    const known = this.opts.knownIds();
    const junk: unknown[] = [
      null, undefined, 0, -1, 1e9, '', 'x', 'DROP', 'SAVE', [], [null], [{}], {}, { length: 2 }, true,
      'A'.repeat(5000), ['a', 'a'],
      this.pick(known.players), this.pick(known.cards), [this.pick(known.cards), this.pick(known.cards)],
      this.c.id,
    ];
    const ev = this.pick(CLIENT_EVENTS)!;
    if (ev === 'leave_room' || ev === 'join_room') return; // 퇴장/입장은 러너가 따로 시험
    if (ev === 'return_to_lobby' && !this.opts.chaosReset) return;
    const argc = Math.floor(this.r() * 4);
    const args: unknown[] = [];
    for (let i = 0; i < argc; i++) args.push(this.pick(junk));
    const roomCode = this.r() < 0.9 ? this.c.roomCode : this.pick(junk);
    const record = { t: Date.now(), bot: this.c.name, ev, args: [roomCode, ...args] };
    this.chaos.push(record);
    if (this.chaos.length > 200) this.chaos.splice(0, 100);
    this.opts.log(`${this.c.name} ⚡ ${ev}(${record.args.map((a) => (typeof a === 'string' && a.length > 24 ? `"${a.slice(0, 6)}…(${a.length})"` : JSON.stringify(a))).join(', ')})`);
    this.c.raw(ev, roomCode, ...args);
  }
}
