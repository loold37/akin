import { scenario, ScenarioApi } from '../harness/runner';
import { createGame, GameCtx, GameOptions, DEFAULT_NAMES } from '../harness/game';
import { TestClient, waitUntil, sleep } from '../harness/client';
import { startTestServer, TestServer } from '../harness/server';
import { isTimerPending, scaled } from '../harness/timescale';
import { VIOLATION_INFO } from '../harness/invariants';
import type { Card, Player } from '../../../shared/types';

// 09: 카드가 아닌 서버 자체의 견고성 · 보안 · 게임 흐름
//  - 잘못된 인자(null, 생략, 숫자, 객체, 문자열, [null], [{}], {"toString":1})를 단계별로 모든 이벤트에 보내는 스윕
//  - 다른 방 소켓 / 중간 입장 / 최대 인원 / 중복 입장 / return_to_lobby / start_game 권한
//  - 자기 차례·방어·공격·투표·패 공개 중 퇴장(연결 끊김) 시 차례 순서와 이벤트 정리
//  - 아주 긴 닉네임/채팅
// 규칙(card.json)이나 상식적인 서버 계약대로의 동작을 단언합니다. 실패 = 현재 구현의 버그.

// ── 규칙 원문 ────────────────────────────────────────────────────────
const R_INPUT =
  '서버는 클라이언트가 보낸 인자를 검증해 잘못된 입력은 무시해야 합니다. 소켓 핸들러에서 예외가 나면 운영 서버 프로세스 전체가 종료됩니다.';
const R_KIT =
  '[긴급탈출키트] 이 카드를 사용하면 이벤트를 한 개 취소합니다. 자신의 차례가 아니거나 이벤트가 진행 중 일지라도 사용 가능합니다. / 즉시 발동하여 현재 진행 중인 이벤트의 효과를 완전히 무효화합니다.';
const R_GOOD =
  '[선택 (善)] 이 카드를 뽑은 자는 생존자 중 한 명을 선택해 카드를 전부 공개시킵니다. 그중 악의가 1장이라도 있다면 이 카드를 뽑은 자는 죽습니다.';
const R_PROPHECY = '[예언] 이 카드를 뽑은 자는 카드를 참가자 수만큼 뽑아 미리 봅니다. 그 후 카드를 원하는 순서대로 바꿔 올려놓습니다.';
const R_JUDGE =
  '[천사의 심판대] 생존자 회의를 통해 한 명을 결정합니다. 결정된 자는 모든 패를 공개하고 그 중 악의가 1장이라도 있다면 그자는 죽게 됩니다.';
const R_TURN = '차례는 항상 현재 차례 플레이어 다음 좌석의 생존자에게 넘어가야 합니다 (불변식 TURN_ORDER_SKIP / TURN_INDEX_DESYNC).';
const R_ROOM = '방의 참가자만 그 방의 게임에 영향을 줄 수 있어야 합니다.';
const R_MAX = 'constants.ts: MAX_PLAYERS = 6 (참가 인원은 2~6명)';
const R_LAST = '최후의 1인이 결정되면 게임이 끝나고, 끝난 게임의 생존/점수는 바뀌면 안 됩니다.';

// ── 공통 헬퍼 ────────────────────────────────────────────────────────
const ALL_VIOLATIONS = Object.keys(VIOLATION_INFO);
const roomOf = (g: GameCtx): any => g.srv.rooms.get(g.code) as any;
const pa = (g: GameCtx): any => roomOf(g)?.pendingAction ?? null;
const ID = (g: GameCtx, i: number): string => g.c(i).id;
const inGrave = (g: GameCtx, name: string) => (roomOf(g)?.graveyard ?? []).some((c: Card) => c.name === name);
const handOf = (p: Player): Card[] => [...p.hand.malices, ...p.hand.weapons, ...p.hand.shields, ...p.hand.treasures, ...p.hand.items];
const curName = (g: GameCtx): string => {
  const r = roomOf(g);
  return r?.getPlayerById(r.currentTurnPlayerId)?.name ?? '없음';
};
const inRoom = (g: GameCtx, id: string): boolean => !!roomOf(g)?.players.some((p: Player) => p.id === id);

function frameOf(stack: string): string {
  const lines = stack.split('\n');
  const line = lines.find((l) => /[\\/]server[\\/]src[\\/]/.test(l)) ?? lines[1] ?? '';
  const m = line.match(/([\w.-]+\.ts):(\d+)/);
  return m ? `${m[1]}:${m[2]}` : line.trim();
}

function crashText(srv: TestServer, from: number): string {
  return srv.crashes
    .slice(from)
    .map((c) => `${c.message} @ ${frameOf(c.stack)}`)
    .join(' / ');
}

let codeSeq = 0;
const newCode = (prefix: string) => `${prefix}${++codeSeq}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

async function newClient(srv: TestServer, name: string): Promise<TestClient> {
  const c = new TestClient(srv.url, name);
  await c.connect();
  return c;
}

/** 대기실(WAITING)만 만들고 게임은 시작하지 않습니다. */
interface Lobby {
  srv: TestServer;
  code: string;
  clients: TestClient[];
  extra: TestClient[];
  room(): any;
  close(): Promise<void>;
}

async function openLobby(n: number, names: string[] = DEFAULT_NAMES, code = newCode('L')): Promise<Lobby> {
  const srv = await startTestServer();
  const clients: TestClient[] = [];
  for (let i = 0; i < n; i++) {
    const c = await newClient(srv, names[i]);
    c.join(code);
    await waitUntil(() => (srv.rooms.get(code)?.players.length ?? 0) === i + 1, 2000, `${names[i]} 입장`);
    clients.push(c);
  }
  const lb: Lobby = {
    srv,
    code,
    clients,
    extra: [],
    room: () => srv.rooms.get(code) as any,
    close: async () => {
      lb.room()?.resetToLobby();
      [...clients, ...lb.extra].forEach((c) => c.close());
      await waitUntil(() => !srv.rooms.has(code), 1500, '대기실 정리').catch(() => undefined);
    },
  };
  return lb;
}

/** 다른 방(대기실)에 혼자 들어가 있는 소켓. */
async function outsider(srv: TestServer, name = '외부인'): Promise<{ x: TestClient; code: string; close(): Promise<void> }> {
  const x = await newClient(srv, name);
  const code = newCode('X');
  x.join(code);
  await waitUntil(() => srv.rooms.get(code)?.players.length === 1, 2000, '외부인이 다른 방에 입장');
  return {
    x,
    code,
    close: async () => {
      x.close();
      await waitUntil(() => !srv.rooms.has(code), 1500, '외부인 방 정리').catch(() => undefined);
    },
  };
}

async function drawTo(g: GameCtx, i: number, pred: () => boolean, label: string): Promise<void> {
  g.c(i).act('draw_card');
  await g.waitFor(pred, label);
}

async function startReveal(g: GameCtx, drawer = 0, target = 1): Promise<void> {
  g.c(drawer).act('draw_card');
  await g.waitFor(() => g.requests(drawer, 'request_target').length > 0, '대상 선택 요청');
  g.c(drawer).act('submit_target', ID(g, target));
  await g.waitFor(() => !!pa(g)?.revealedCards, '패 공개 시작');
}

async function endTurnOf(g: GameCtx, i: number): Promise<void> {
  const r = roomOf(g);
  const before = r.currentTurnPlayerId;
  const timer = r.turnTimer;
  g.c(i).act('end_turn');
  // 차례가 같은 사람에게 다시 돌아오는 경우도 있으므로 턴 타이머 재시작으로도 판정
  await g.waitFor(() => roomOf(g).currentTurnPlayerId !== before || roomOf(g).turnTimer !== timer, `${g.c(i).name} 차례 종료`);
}

/** 현재 차례 플레이어가 차례를 n번 넘기며 차례를 받은 사람 이름을 기록합니다. */
async function rotate(g: GameCtx, n: number): Promise<string[]> {
  const seen: string[] = [];
  for (let k = 0; k < n; k++) {
    const idx = g.indexOf(roomOf(g).currentTurnPlayerId);
    if (idx < 0) {
      seen.push(`(${curName(g)}: 테스트 소켓이 아님)`);
      break;
    }
    await endTurnOf(g, idx);
    seen.push(curName(g));
  }
  return seen;
}

/** 지금까지의 불변식 위반(심각도 minor 제외)을 관찰로 남깁니다. */
function noteViolations(t: ScenarioApi, g: GameCtx): void {
  try {
    g.check();
  } catch {
    /* 방이 없으면 무시 */
  }
  const vs = g.tracker.violations.filter((v) => v.severity !== 'minor');
  if (vs.length) t.note(`불변식 위반: ${vs.map((v) => `[${v.code}] ${v.message}`).join(' / ')}`);
}

async function leaveAndWait(g: GameCtx, i: number, how: 'leave' | 'disconnect' = 'leave'): Promise<string> {
  const id = ID(g, i);
  if (how === 'leave') g.c(i).act('leave_room');
  else g.c(i).close();
  await g.waitFor(() => !inRoom(g, id), `${g.c(i).name} 퇴장 처리`);
  await g.settle();
  return id;
}

// ── 잘못된 인자 스윕 인프라 ─────────────────────────────────────────
interface Payload {
  label: string;
  value?: any;
  omit?: boolean;
}
const PAYLOADS: Payload[] = [
  { label: 'null', value: null },
  { label: 'undefined(인자 생략)', omit: true },
  { label: '123', value: 123 },
  { label: '{}', value: {} },
  { label: '"x"', value: 'x' },
  { label: '[null]', value: [null] },
  { label: '[{}]', value: [{}] },
  { label: '{"toString":1}', value: { toString: 1 } },
];

const PARAMS: Record<string, string[]> = {
  join_room: ['roomCode', 'playerName'],
  play_tool: ['cardId', 'targetId'],
  play_shield: ['cardId', 'targetId'],
  submit_vote: ['targetId', 'useDictatorship'],
  submit_target: ['targetId'],
  submit_gift: ['cardId', 'targetId'],
  submit_transmutation: ['targetDeadPlayerId', 'cardIds'],
  submit_cards: ['cardIds'],
  use_mayuk_sword_now: ['targetId'],
  cut_fate_link: ['weaponCardId'],
  kill_bait_monster: ['cardId'],
  submit_prophecy: ['cardIds'],
  interrupt_action: ['cardId', 'targetId'],
  play_item: ['cardId', 'targetIds'],
  send_chat: ['message'],
};

type Maker = (opts: GameOptions) => Promise<GameCtx>;
interface PhaseSpec {
  label: string;
  setup: (mk: Maker) => Promise<GameCtx>;
}

const SWEEP_EVENT_TIMEOUT = 600000; // 스윕 도중 이벤트 제한시간이 터지지 않도록 (실제 30초)

function phase(label: string, opts: GameOptions, enter?: (g: GameCtx) => Promise<void>): PhaseSpec {
  return {
    label,
    setup: async (mk) => {
      const g = await mk({ eventTimeoutMs: SWEEP_EVENT_TIMEOUT, ...opts });
      if (enter) await enter(g);
      return g;
    },
  };
}

const respCount = (g: GameCtx) => Object.keys(pa(g)?.responses ?? {}).length;

const BASE_HANDS: Record<number, string[]> = {
  0: ['성정', '인연의 끈', '긴급탈출키트', '인간 방패', '침묵', '독재', '황금 방패', '코인', '시선'],
  1: ['황금 방패', '수호천사', '인간 방패', '긴급탈출키트', '성정', '시선'],
  2: ['황금 방패', '긴급탈출키트', '침묵', '코인', '시선'],
};

const PH = {
  MAIN: phase('MAIN(가람 차례)', { players: 3, hands: BASE_HANDS }),
  LOBBY: phase('WAITING(대기실)', { players: 3 }, async (g) => {
    roomOf(g).resetToLobby();
    g.tracker.rebaseline();
    g.broadcast();
  }),
  LINKED: phase('MAIN(가람·나래 인연의 끈)', { players: 3, hands: BASE_HANDS }, async (g) => {
    roomOf(g).linkedPlayers = [ID(g, 0), ID(g, 1)];
    g.broadcast();
  }),
  DEFENSE: phase('무기 방어 대기(가람→나래, 성정)', { players: 3, hands: BASE_HANDS }, async (g) => {
    g.c(0).act('play_tool', g.cardId(0, '성정'), ID(g, 1));
    await g.waitPhase('WAITING_FOR_DEFENSE');
  }),
  ARROW: phase('화살 함정(가람)', { players: 3, hands: BASE_HANDS, deck: ['화살 함정'] }, async (g) => {
    await drawTo(g, 0, () => pa(g)?.eventName === '화살 함정', '화살 함정 시작');
  }),
  BAIT: phase('미끼(괴물 처치/방어 대기)', { players: 3, hands: BASE_HANDS, deck: ['미끼'] }, async (g) => {
    await drawTo(g, 0, () => pa(g)?.eventName === '미끼', '미끼 시작');
  }),
  VOTE_JUDGE: phase('투표: 천사의 심판대(나래·다온 투표 완료, 가람이 마지막)', { players: 3, hands: BASE_HANDS, deck: ['천사의 심판대'] }, async (g) => {
    await drawTo(g, 0, () => pa(g)?.type === 'VOTE', '투표 시작');
    g.c(1).act('submit_vote', ID(g, 2), false);
    g.c(2).act('submit_vote', ID(g, 2), false);
    await g.waitFor(() => respCount(g) === 2, '사전 투표');
  }),
  // 구덩이: 나래 차례로 시작해 나래가 빠지고, 가람이 마지막 투표자
  VOTE_PIT: phase('투표: 구덩이(나래가 빠짐, 나래·다온 투표 완료, 가람이 마지막)', { players: 3, hands: BASE_HANDS, deck: ['구덩이'], turn: 1 }, async (g) => {
    await drawTo(g, 1, () => pa(g)?.type === 'VOTE', '구덩이 투표 시작');
    g.c(1).act('submit_vote', 'SAVE', false);
    g.c(2).act('submit_vote', 'SAVE', false);
    await g.waitFor(() => respCount(g) === 2, '사전 투표');
  }),
  VOTE_TRANS: phase(
    '투표: 인체 연성 부활 대상(나래 투표 완료, 가람이 마지막)',
    { players: 3, dead: [2], hands: { 0: ['코인', '긴급탈출키트'], 1: ['코인'] }, deck: ['인체 연성'] },
    async (g) => {
      await drawTo(g, 0, () => pa(g)?.eventName === '인체 연성' && pa(g)?.type === 'CARD_SUBMISSION', '인체 연성 제출 시작');
      g.c(0).act('submit_cards', [g.cardId(0, '코인')]);
      g.c(1).act('submit_cards', [g.cardId(1, '코인')]);
      await g.waitFor(() => pa(g)?.type === 'VOTE', '부활 투표 시작');
      g.c(1).act('submit_vote', ID(g, 2), false);
      await g.waitFor(() => respCount(g) === 1, '나래 투표');
    },
  ),
  SUB_DISARM: phase(
    '카드 제출: 무장해제(나래·다온 제출 완료)',
    { players: 3, hands: { 0: ['성정', '시선', '긴급탈출키트'], 1: ['황금칼', '상처'], 2: ['코인'] }, deck: ['무장해제'] },
    async (g) => {
      await drawTo(g, 0, () => pa(g)?.eventName === '무장해제', '무장해제 시작');
      g.c(1).act('submit_cards', []);
      g.c(2).act('submit_cards', []);
      await g.waitFor(() => respCount(g) === 2, '사전 제출');
    },
  ),
  SUB_INDUL: phase(
    '카드 제출: 면죄부(나래·다온 제출 완료)',
    { players: 3, hands: { 0: ['코인', '시선', '긴급탈출키트'], 1: ['성배', '상처'], 2: ['코인'] }, deck: ['면죄부'] },
    async (g) => {
      await drawTo(g, 0, () => pa(g)?.eventName === '면죄부', '면죄부 시작');
      g.c(1).act('submit_cards', []);
      g.c(2).act('submit_cards', []);
      await g.waitFor(() => respCount(g) === 2, '사전 제출');
    },
  ),
  SUB_TRANS: phase(
    '카드 제출: 인체 연성(나래 제출 완료)',
    { players: 3, dead: [2], hands: { 0: ['코인', '성배', '긴급탈출키트'], 1: ['코인'] }, deck: ['인체 연성'] },
    async (g) => {
      await drawTo(g, 0, () => pa(g)?.eventName === '인체 연성' && pa(g)?.type === 'CARD_SUBMISSION', '인체 연성 시작');
      g.c(1).act('submit_cards', []);
      await g.waitFor(() => respCount(g) === 1, '사전 제출');
    },
  ),
  SUB_MAYUK: phase(
    '카드 제출: 마육검 경매(나래·다온 입찰 완료)',
    { players: 3, hands: { 0: ['시선', '코인', '긴급탈출키트'], 1: ['상처'], 2: ['코인'] }, deck: ['마육검'] },
    async (g) => {
      await drawTo(g, 0, () => pa(g)?.eventName === '마육검' && pa(g)?.type === 'CARD_SUBMISSION', '마육검 경매 시작');
      g.c(1).act('submit_cards', []);
      g.c(2).act('submit_cards', []);
      await g.waitFor(() => respCount(g) === 2, '사전 입찰');
    },
  ),
  SUB_SAC: phase(
    '카드 제출: 제물(나래·다온 제출 완료)',
    { players: 3, hands: { 0: ['코인', '성배', '긴급탈출키트'], 1: ['코인'], 2: ['코인'] }, deck: ['제물'] },
    async (g) => {
      await drawTo(g, 0, () => pa(g)?.eventName === '제물' && pa(g)?.type === 'CARD_SUBMISSION', '제물 시작');
      g.c(1).act('submit_cards', []);
      g.c(2).act('submit_cards', []);
      await g.waitFor(() => respCount(g) === 2, '사전 제출');
    },
  ),
  SUB_ROUL: phase(
    '카드 제출: 룰렛(나래·다온 제출 완료)',
    { players: 3, hands: { 0: ['코인', '긴급탈출키트'], 1: ['성배'], 2: ['코인'] }, deck: ['룰렛'] },
    async (g) => {
      await drawTo(g, 0, () => pa(g)?.eventName === '룰렛', '룰렛 시작');
      g.c(1).act('submit_cards', [g.cardId(1, '성배')]);
      g.c(2).act('submit_cards', [g.cardId(2, '코인')]);
      await g.waitFor(() => respCount(g) === 2, '사전 제출');
    },
  ),
  SUB_EXCAL: phase('엑스칼리버 경쟁', { players: 3, hands: { 0: ['코인', '긴급탈출키트'], 1: ['시선'] }, deck: ['엑스칼리버'] }, async (g) => {
    await drawTo(g, 0, () => pa(g)?.eventName === '엑스칼리버', '엑스칼리버 시작');
  }),
  SUB_NONPOS: phase('무소유(3초 분배 대기)', { players: 3, hands: { 0: ['코인', '시선'], 1: ['코인', '성배'], 2: ['코인'] }, deck: ['무소유'] }, async (g) => {
    await drawTo(g, 0, () => pa(g)?.eventName === '무소유', '무소유 시작');
  }),
  PROPHECY: phase(
    '예언(가람이 재배치 대기)',
    { players: 3, hands: { 0: ['코인', '긴급탈출키트'], 1: ['코인', '성배'] }, deck: ['예언', '시선', '상처', '흑역사'] },
    async (g) => {
      await drawTo(g, 0, () => pa(g)?.eventName === '예언', '예언 시작');
    },
  ),
  GIFT: phase('선물(가람이 선물 대기)', { players: 3, hands: { 0: ['코인', '시선', '긴급탈출키트'] }, deck: ['선물'] }, async (g) => {
    await drawTo(g, 0, () => pa(g)?.eventName === '선물', '선물 시작');
  }),
  TARGET_GOOD: phase('대상 선택: 선택 (善)', { players: 3, hands: { 0: ['긴급탈출키트'], 1: ['시선'] }, deck: ['선택 (善)'] }, async (g) => {
    await drawTo(g, 0, () => pa(g)?.type === 'TARGET_SELECTION', '선택 (善) 시작');
  }),
  GHOST_KARMA: phase('망자 대상 선택: 카르마(다온 사망)', { players: 3, dead: [2], hands: { 0: ['코인', '긴급탈출키트'] }, deck: ['카르마'] }, async (g) => {
    await drawTo(g, 0, () => pa(g)?.eventName === '카르마' && pa(g)?.type === 'TARGET_SELECTION', '카르마 시작');
  }),
  GHOST_POLTER: phase('망자 대상 선택: 폴터가이스트(다온 사망)', { players: 3, dead: [2], hands: { 0: ['코인'] }, deck: ['폴터가이스트'] }, async (g) => {
    await drawTo(g, 0, () => pa(g)?.eventName === '폴터가이스트' && pa(g)?.type === 'TARGET_SELECTION', '폴터가이스트 시작');
  }),
  REVEAL: phase(
    '패 공개: 선택 (善) (아무도 확인 전)',
    { players: 3, hands: { 0: ['코인'], 1: ['시선', '코인'], 2: ['긴급탈출키트', '코인', '성배'] }, deck: ['선택 (善)'] },
    async (g) => {
      await startReveal(g, 0, 1);
    },
  ),
  MAYUK_CHOICE: phase(
    '마육검 사용 선택(가람 낙찰)',
    { players: 3, hands: { 0: ['시선', '긴급탈출키트'], 1: ['코인'] }, deck: ['마육검'] },
    async (g) => {
      await drawTo(g, 0, () => pa(g)?.eventName === '마육검' && pa(g)?.type === 'CARD_SUBMISSION', '마육검 경매 시작');
      g.c(0).act('submit_cards', [g.cardId(0, '시선')]);
      g.c(1).act('submit_cards', []);
      g.c(2).act('submit_cards', []);
      await g.waitFor(() => pa(g)?.eventName === '마육검' && pa(g)?.type === 'TARGET_SELECTION', '마육검 사용 선택');
    },
  ),
};

// ── 기본 인자 (대체로 유효한 값) ────────────────────────────────────
const cardsOf = (g: GameCtx, s: number): Card[] => {
  const p = roomOf(g)?.getPlayerById(ID(g, s));
  return p ? handOf(p) : [];
};
const cardIdOf = (g: GameCtx, s: number, pred: (c: any) => boolean = () => true): string => cardsOf(g, s).find(pred)?.id ?? 'no-card';
const isType = (t: string) => (c: any) => c.category === 'TOOL' && c.toolType === t;
const named = (...names: string[]) => (c: any) => names.includes(c.name);
const otherAlive = (g: GameCtx, s: number): string =>
  (roomOf(g)?.players as Player[]).find((p) => p.isAlive && p.id !== ID(g, s))?.id ?? ID(g, (s + 1) % g.clients.length);
const deadId = (g: GameCtx): string => (roomOf(g)?.players as Player[]).find((p) => !p.isAlive)?.id ?? ID(g, 2);

type Defaults = (g: GameCtx, s: number) => any[];
const D: Record<string, Defaults> = {
  weapon: (g, s) => [cardIdOf(g, s, isType('WEAPON')), otherAlive(g, s)],
  shield: (g, s) => [cardIdOf(g, s, isType('SHIELD')), otherAlive(g, s)],
  voteOther: (g, s) => [otherAlive(g, s), false],
  votePit: () => ['SAVE', false],
  voteDead: (g) => [deadId(g), false],
  target: (g, s) => [otherAlive(g, s)],
  gift: (g, s) => [cardIdOf(g, s), otherAlive(g, s)],
  trans: (g, s) => [deadId(g), cardsOf(g, s).filter((c) => c.category === 'TOOL').slice(0, 2).map((c) => c.id)],
  cards: (g, s) => [cardsOf(g, s).filter((c) => c.name !== '긴급탈출키트').slice(0, 2).map((c) => c.id)],
  weaponOnly: (g, s) => [cardIdOf(g, s, isType('WEAPON'))],
  prophecy: (g) => [((pa(g)?.prophecyCards ?? []) as Card[]).map((c) => c.id).reverse()],
  kit: (g, s) => [cardIdOf(g, s, named('긴급탈출키트')), otherAlive(g, s)],
  humanShield: (g, s) => [cardIdOf(g, s, named('인간 방패')), ID(g, 2)],
  silence: (g, s) => [cardIdOf(g, s, named('침묵')), ID(g, 0)],
  link: (g, s) => [cardIdOf(g, s, named('인연의 끈')), [ID(g, 1), ID(g, 2)]],
  chat: () => ['안녕하세요'],
};

interface Plan {
  ph: PhaseSpec;
  s: number;
  d: Defaults;
  /** 스윕할 인자 위치 (기본: 전부) */
  positions?: number[];
}

// 상태 서명: 이것이 바뀌면 다음 프로브 전에 게임을 새로 만듭니다.
const objIds = new WeakMap<object, number>();
let objSeq = 0;
function oid(o: any): number {
  if (!o || typeof o !== 'object') return 0;
  if (!objIds.has(o)) objIds.set(o, ++objSeq);
  return objIds.get(o)!;
}
function sig(g: GameCtx): string {
  const r = roomOf(g);
  if (!r) return 'gone';
  const p = r.pendingAction;
  return JSON.stringify([
    r.phase,
    oid(p),
    p ? Object.keys(p.responses ?? {}).sort() : null,
    p?.skippedPlayerIds?.length ?? 0,
    p?.targetId ?? null,
    p?.initiatorId ?? null,
    (r.players as Player[]).map((x) => [x.id, x.isAlive, x.isSilenced, handOf(x).length]),
    r.deck.length,
    r.graveyard.length,
    r.linkedPlayers,
    r.currentTurnPlayerId,
  ]);
}

/** 보낸 소켓의 메시지가 서버에서 처리될 때까지 기다립니다 (같은 소켓에 응답이 오는 무해한 요청을 뒤에 붙임). */
async function barrier(srv: TestServer, c: TestClient, code: string): Promise<void> {
  const room = srv.rooms.get(code) as any;
  const p = room?.getPlayerById(c.id);
  const start = c.events.length;
  if (p && p.isAlive && !p.isSilenced) {
    c.raw('cut_fate_link', code, '__barrier__');
    await waitUntil(
      () => c.events.slice(start).some((e) => e.ev === 'action_result' && String(e.args[0]).includes('인연의 끈')),
      800,
      'barrier',
    ).catch(() => sleep(20));
  } else if (p) {
    c.raw('send_chat', code, '__barrier__');
    await waitUntil(() => c.events.slice(start).some((e) => e.ev === 'chat_message' && e.args[1] === '__barrier__'), 800, 'barrier').catch(() =>
      sleep(20),
    );
  } else {
    await sleep(30);
  }
}

interface CrashHit {
  where: string;
  param: string;
  payload: string;
  msg: string;
}

/** 같은 예외 위치끼리 묶어 "예외 ← [단계 · 인자 = 값들]" 한 줄씩 기록합니다. */
function reportCrashes(t: ScenarioApi, ev: string, hits: CrashHit[]): void {
  const byMsg = new Map<string, Map<string, string[]>>();
  for (const h of hits) {
    const m = byMsg.get(h.msg) ?? new Map<string, string[]>();
    byMsg.set(h.msg, m);
    const k = `${h.where} · ${h.param}`;
    m.set(k, [...(m.get(k) ?? []), h.payload]);
  }
  for (const [msg, m] of byMsg) {
    t.note(`💥 ${ev}: ${msg} ← ${[...m].map(([k, ps]) => `[${k} = ${ps.join(' | ')}]`).join(' ')}`);
  }
}

async function retire(g: GameCtx, seen: Set<string>, label: string): Promise<void> {
  try {
    g.check();
    for (const v of g.tracker.violations) if (v.severity !== 'minor') seen.add(`${v.code} @ ${label}`);
  } catch {
    /* ignore */
  }
  await g.close();
}

async function runSweep(t: ScenarioApi, ev: string, plans: Plan[]): Promise<void> {
  const srv = await startTestServer();
  const hits: CrashHit[] = [];
  const odd = new Set<string>();
  let probes = 0;
  let games = 0;
  for (const plan of plans) {
    let g: GameCtx | null = null;
    let stale = true;
    const nParams = PARAMS[ev].length;
    const positions = plan.positions ?? Array.from({ length: nParams }, (_, k) => k);
    for (const pos of positions) {
      for (const pl of PAYLOADS) {
        if (stale || !g) {
          if (g) await retire(g, odd, plan.ph.label);
          g = await plan.ph.setup(createGame);
          games++;
          stale = false;
        }
        const defaults = plan.d(g, plan.s);
        const args = pl.omit ? defaults.slice(0, pos) : defaults.map((v, k) => (k === pos ? pl.value : v));
        const before = srv.crashes.length;
        const s0 = sig(g);
        g.c(plan.s).raw(ev, g.code, ...args);
        probes++;
        await barrier(srv, g.c(plan.s), g.code);
        if (srv.crashes.length > before) {
          const c = srv.crashes[before];
          hits.push({
            where: `${plan.ph.label} / 보낸 사람 ${g.c(plan.s).name}`,
            param: PARAMS[ev][pos],
            payload: pl.label,
            msg: `${c.message} @ ${frameOf(c.stack)}`,
          });
          stale = true;
        } else if (sig(g) !== s0) {
          stale = true;
        }
      }
    }
    if (g) await retire(g, odd, plan.ph.label);
  }
  t.note(`프로브 ${probes}회 / 게임 ${games}판 / 서버 예외 ${hits.length}건`);
  reportCrashes(t, ev, hits);
  for (const o of odd) t.note(`(참고) 스윕 중 불변식 위반: ${o}`);
}

// ════════════════════════════════════════════════════════════════════
// 1. 잘못된 인자 스윕
// ════════════════════════════════════════════════════════════════════

const ROOMCODE_ONLY_EVENTS: Array<[string, Defaults]> = [
  ['start_game', () => []],
  ['draw_card', () => []],
  ['resume_draw', () => []],
  ['end_turn', () => []],
  ['play_tool', D.weapon],
  ['play_shield', D.shield],
  ['skip_defense', () => []],
  ['confirm_reveal', () => []],
  ['submit_vote', D.voteOther],
  ['submit_target', D.target],
  ['submit_gift', D.gift],
  ['submit_transmutation', D.trans],
  ['submit_cards', D.cards],
  ['claim_excalibur', () => []],
  ['skip_excalibur', () => []],
  ['store_mayuk_sword', () => []],
  ['use_mayuk_sword_now', D.target],
  ['cut_fate_link', D.weaponOnly],
  ['kill_bait_monster', D.weaponOnly],
  ['submit_prophecy', () => [[]]],
  ['interrupt_action', D.kit],
  ['play_item', D.link],
  ['send_chat', D.chat],
  ['leave_room', () => []],
  ['return_to_lobby', () => []],
];

scenario(
  '잘못된 입력 · 방 코드 자리: 모든 이벤트(join_room 제외)에 이상한 방 코드를 보내면 무시되고 서버가 죽지 않는다',
  { card: '잘못된 입력', rule: R_INPUT, timeoutMs: 60000, allowViolations: ALL_VIOLATIONS },
  async (t) => {
    const srv = await startTestServer();
    const g = await createGame({ players: 3, hands: BASE_HANDS, eventTimeoutMs: SWEEP_EVENT_TIMEOUT });
    const hits: CrashHit[] = [];
    const changed: string[] = [];
    let probes = 0;
    try {
      for (const [ev, d] of ROOMCODE_ONLY_EVENTS) {
        for (const pl of PAYLOADS) {
          const args = pl.omit ? [] : [pl.value, ...d(g, 0)];
          const before = srv.crashes.length;
          const s0 = sig(g);
          g.c(0).raw(ev, ...args);
          probes++;
          await barrier(srv, g.c(0), g.code);
          if (srv.crashes.length > before) {
            const c = srv.crashes[before];
            hits.push({ where: 'MAIN / 보낸 사람 가람', param: `${ev}.roomCode`, payload: pl.label, msg: `${c.message} @ ${frameOf(c.stack)}` });
          } else if (sig(g) !== s0) {
            changed.push(`${ev}(${pl.label})`);
          }
        }
      }
    } finally {
      await g.close();
    }
    t.note(`프로브 ${probes}회 / 서버 예외 ${hits.length}건`);
    reportCrashes(t, '방 코드', hits);
    t.expectEq(changed, [], '이상한 방 코드로 보낸 요청이 이 방 상태를 바꾸면 안 됨');
  },
);

scenario(
  '잘못된 입력 · join_room: 방 코드/닉네임 자리에 이상한 값을 보내도 서버가 죽지 않는다',
  { card: '잘못된 입력', rule: R_INPUT, timeoutMs: 90000, allowViolations: ALL_VIOLATIONS },
  async (t) => {
    const srv = await startTestServer();
    const hits: CrashHit[] = [];
    const stored: string[] = [];
    for (const mode of ['방 코드', '닉네임(대기실)', '닉네임(게임 진행 중)'] as const) {
      for (const pl of PAYLOADS) {
        let lb: Lobby | null = null;
        let g: GameCtx | null = null;
        let code: string;
        if (mode === '닉네임(게임 진행 중)') {
          g = await createGame({ players: 2 });
          code = g.code;
        } else {
          lb = await openLobby(1, ['방장']);
          code = lb.code;
        }
        const j = await newClient(srv, '입장자');
        const before = srv.crashes.length;
        const args = mode === '방 코드' ? (pl.omit ? [] : [pl.value, '입장자']) : pl.omit ? [code] : [code, pl.value];
        j.raw('join_room', ...args);
        await waitUntil(() => j.eventsOf('room_state_update').length > 0, 300, 'room_state_update').catch(() => undefined);
        await sleep(20);
        if (srv.crashes.length > before) {
          const c = srv.crashes[before];
          hits.push({ where: `${mode} / 입장 시`, param: mode === '방 코드' ? 'roomCode' : 'playerName', payload: pl.label, msg: `${c.message} @ ${frameOf(c.stack)}` });
        }
        if (mode !== '방 코드') {
          const p = (srv.rooms.get(code) as any)?.players.find((x: Player) => x.id === j.id);
          if (p && typeof p.name !== 'string') stored.push(`${mode} ${pl.label}(${p.name === null ? 'null' : typeof p.name})`);
        }
        const jid = j.id;
        const before2 = srv.crashes.length;
        j.close();
        await sleep(60);
        if (srv.crashes.length > before2) {
          const c = srv.crashes[before2];
          hits.push({ where: `${mode} / 연결 끊김(퇴장) 시`, param: mode === '방 코드' ? 'roomCode' : 'playerName', payload: pl.label, msg: `${c.message} @ ${frameOf(c.stack)}` });
        }
        // 예외로 퇴장 처리가 끝나지 않은 유령 플레이어 정리
        for (const r of srv.rooms.values()) {
          const anyR = r as any;
          if (anyR.players.some((p: Player) => p.id === jid)) {
            anyR.players = anyR.players.filter((p: Player) => p.id !== jid);
            if (anyR.players.length === 0) {
              for (const [k, v] of srv.rooms.entries()) if (v === r) srv.rooms.delete(k);
            }
          }
        }
        if (g) await g.close();
        if (lb) await lb.close();
      }
    }
    t.note(`서버 예외 ${hits.length}건`);
    reportCrashes(t, 'join_room', hits);
    if (stored.length) t.note(`문자열이 아닌 닉네임이 그대로 저장됨(대기실·게임 중 공통): ${[...new Set(stored.map((x) => x.replace(/^닉네임\([^)]*\) /, '')))].join(', ')}`);
  },
);

const SWEEPS: Array<{ ev: string; title: string; plans: Plan[] }> = [
  {
    ev: 'play_tool',
    title: 'MAIN(차례 주인/다른 사람)·방어 대기 중 cardId/targetId',
    plans: [
      { ph: PH.MAIN, s: 0, d: D.weapon },
      { ph: PH.MAIN, s: 1, d: D.weapon },
      { ph: PH.DEFENSE, s: 0, d: D.weapon },
    ],
  },
  {
    ev: 'play_shield',
    title: '무기 방어·화살 함정·미끼 단계의 cardId/targetId',
    plans: [
      { ph: PH.DEFENSE, s: 1, d: D.shield },
      { ph: PH.DEFENSE, s: 2, d: D.shield },
      { ph: PH.ARROW, s: 0, d: D.shield },
      { ph: PH.ARROW, s: 1, d: D.shield },
      { ph: PH.BAIT, s: 1, d: D.shield },
    ],
  },
  {
    ev: 'submit_vote',
    title: '천사의 심판대·구덩이·인체 연성 투표의 targetId/useDictatorship (마지막 투표자가 보냄)',
    plans: [
      { ph: PH.VOTE_JUDGE, s: 0, d: D.voteOther },
      { ph: PH.VOTE_PIT, s: 0, d: D.votePit },
      { ph: PH.VOTE_TRANS, s: 0, d: D.voteDead },
    ],
  },
  {
    ev: 'submit_target',
    title: '선택 (善)·카르마·폴터가이스트(망자)·선물·마육검 선택 단계의 targetId',
    plans: [
      { ph: PH.TARGET_GOOD, s: 0, d: D.target },
      { ph: PH.GHOST_KARMA, s: 2, d: D.target },
      { ph: PH.GHOST_POLTER, s: 2, d: D.target },
      { ph: PH.GIFT, s: 0, d: D.target },
      { ph: PH.MAYUK_CHOICE, s: 0, d: D.target },
    ],
  },
  { ev: 'submit_gift', title: '선물 단계의 cardId/targetId', plans: [{ ph: PH.GIFT, s: 0, d: D.gift }] },
  {
    ev: 'submit_transmutation',
    title: '인체 연성 제출/투표 단계의 targetDeadPlayerId/cardIds',
    plans: [
      { ph: PH.SUB_TRANS, s: 0, d: D.trans },
      { ph: PH.VOTE_TRANS, s: 0, d: D.trans },
    ],
  },
  {
    ev: 'submit_cards',
    title: '무장해제·면죄부·인체 연성·마육검·제물·룰렛·엑스칼리버·무소유·예언·패 공개 단계의 cardIds',
    plans: [
      { ph: PH.SUB_DISARM, s: 0, d: D.cards },
      { ph: PH.SUB_INDUL, s: 0, d: D.cards },
      { ph: PH.SUB_TRANS, s: 0, d: D.cards },
      { ph: PH.SUB_MAYUK, s: 0, d: D.cards },
      { ph: PH.SUB_SAC, s: 0, d: D.cards },
      { ph: PH.SUB_ROUL, s: 0, d: D.cards },
      { ph: PH.SUB_EXCAL, s: 0, d: D.cards },
      { ph: PH.SUB_NONPOS, s: 1, d: D.cards },
      { ph: PH.PROPHECY, s: 1, d: D.cards },
      { ph: PH.REVEAL, s: 2, d: D.cards },
    ],
  },
  { ev: 'use_mayuk_sword_now', title: '마육검 사용 선택 단계의 targetId', plans: [{ ph: PH.MAYUK_CHOICE, s: 0, d: D.target }] },
  { ev: 'cut_fate_link', title: '인연의 끈으로 묶인 상태의 weaponCardId', plans: [{ ph: PH.LINKED, s: 0, d: D.weaponOnly }] },
  { ev: 'kill_bait_monster', title: '미끼 단계의 cardId', plans: [{ ph: PH.BAIT, s: 1, d: D.weaponOnly }] },
  { ev: 'submit_prophecy', title: '예언 단계의 cardIds (예언을 뽑은 사람이 보냄)', plans: [{ ph: PH.PROPHECY, s: 0, d: D.prophecy }] },
  {
    ev: 'interrupt_action',
    title: '긴급탈출키트·인간 방패·침묵을 여러 단계에서 cardId/targetId (패 공개는 확인 전)',
    plans: [
      { ph: PH.MAIN, s: 0, d: D.kit },
      { ph: PH.DEFENSE, s: 1, d: D.humanShield },
      { ph: PH.DEFENSE, s: 2, d: D.silence, positions: [0] },
      { ph: PH.DEFENSE, s: 2, d: D.kit, positions: [0] },
      { ph: PH.ARROW, s: 0, d: D.humanShield },
      { ph: PH.VOTE_JUDGE, s: 2, d: D.kit, positions: [0] },
      { ph: PH.SUB_DISARM, s: 0, d: D.kit, positions: [0] },
      { ph: PH.SUB_MAYUK, s: 0, d: D.kit, positions: [0] },
      { ph: PH.REVEAL, s: 2, d: D.kit, positions: [0] },
      { ph: PH.PROPHECY, s: 0, d: D.kit, positions: [0] },
      { ph: PH.GHOST_KARMA, s: 0, d: D.kit, positions: [0] },
    ],
  },
  { ev: 'play_item', title: 'MAIN에서 인연의 끈 cardId/targetIds', plans: [{ ph: PH.MAIN, s: 0, d: D.link }] },
  {
    ev: 'send_chat',
    title: '대기실·MAIN·망자 채팅의 message',
    plans: [
      { ph: PH.LOBBY, s: 0, d: D.chat },
      { ph: PH.MAIN, s: 0, d: D.chat },
      { ph: PH.GHOST_KARMA, s: 2, d: D.chat },
    ],
  },
];

for (const sw of SWEEPS) {
  scenario(
    `잘못된 입력 · ${sw.ev}: ${sw.title}에 이상한 값을 보내도 서버가 죽지 않는다`,
    { card: '잘못된 입력', rule: R_INPUT, timeoutMs: 180000, allowViolations: ALL_VIOLATIONS },
    async (t) => {
      await runSweep(t, sw.ev, sw.plans);
    },
  );
}

// ════════════════════════════════════════════════════════════════════
// 2. 긴급탈출키트 × 패 공개
// ════════════════════════════════════════════════════════════════════

scenario(
  '긴급탈출키트: 패 공개(선택 (善)) 중 누군가 확인을 누른 뒤에 써도 서버가 죽지 않고 이벤트가 취소된다',
  { card: '긴급탈출키트', rule: R_KIT },
  async (t) => {
    const g = await t.game({ players: 3, hands: { 1: ['시선'], 2: ['긴급탈출키트'] }, deck: ['선택 (善)'] });
    await startReveal(g, 0, 1);
    const rev = pa(g);
    g.c(1).act('confirm_reveal');
    await g.waitFor(() => rev.responses[ID(g, 1)] === true, '나래 확인');
    const before = g.srv.crashes.length;
    g.c(2).act('interrupt_action', g.cardId(2, '긴급탈출키트'));
    await g.settle();
    if (g.srv.crashes.length > before) {
      t.note(
        `서버 예외: ${crashText(g.srv, before)} — 직후 상태: phase=${g.room.phase}, 대기 액션=${pa(g)?.eventName ?? '없음'}, 제한시간 타이머 ${
          isTimerPending(pa(g)?.timer) ? '살아 있음' : '없음(영구 정지)'
        }, 키트 ${g.hand(2).includes('긴급탈출키트') ? '패에 남음' : '소모됨'}`,
      );
    }
    t.expectEq(g.room.phase, 'MAIN', '이벤트가 취소되어 MAIN으로 돌아와야 함');
    t.expect(g.p(0).isAlive, '취소된 선택 (善)으로 가람이 죽으면 안 됨');
    t.expect(inGrave(g, '긴급탈출키트') && !g.hand(2).includes('긴급탈출키트'), '사용한 키트는 무덤으로');
    t.expectEq(g.hand(1), ['시선'], '공개 대상의 패는 그대로');
  },
);

scenario(
  '긴급탈출키트: 패 공개(선택 (善)) 중 아무도 확인하기 전에 쓰면 이벤트가 취소된다',
  { card: '긴급탈출키트', rule: R_KIT },
  async (t) => {
    const g = await t.game({ players: 3, hands: { 1: ['시선'], 2: ['긴급탈출키트'] }, deck: ['선택 (善)'] });
    await startReveal(g, 0, 1);
    g.c(2).act('interrupt_action', g.cardId(2, '긴급탈출키트'));
    await g.waitPhase('MAIN');
    await g.settle();
    t.expect(g.p(0).isAlive, '취소된 선택 (善)으로 가람이 죽으면 안 됨');
    t.expect(inGrave(g, '긴급탈출키트'), '사용한 키트는 무덤으로');
    t.expectEq(g.hand(1), ['시선'], '공개 대상의 패는 그대로');
    t.expect(isTimerPending(g.room.turnTimer), '가람의 턴 타이머가 다시 돌아야 함');
  },
);

// ════════════════════════════════════════════════════════════════════
// 3. 잘못된/엉뚱한 단계의 유효한 입력
// ════════════════════════════════════════════════════════════════════

scenario(
  '선택 (善): 존재하지 않는 대상 id를 보내 이벤트를 무효로 만들 수 없다',
  { card: '선택 (善)', rule: R_GOOD },
  async (t) => {
    // 가람·나래·다온 모두 악의가 있으므로 누구를 공개하든(자기 자신 포함) 가람은 죽어야 함
    const g = await t.game({ players: 3, hands: { 0: ['시선'], 1: ['시선'], 2: ['시선'] }, deck: ['선택 (善)'] });
    g.c(0).act('draw_card');
    await g.waitFor(() => g.requests(0, 'request_target').length > 0, '대상 선택 요청');
    g.c(0).act('submit_target', 'no-such-player');
    await g.settle();
    t.note(`잘못된 대상 id 제출 직후: phase=${g.room.phase}, 대기 액션=${pa(g)?.type ?? '없음'}${pa(g)?.revealedCards ? '(패 공개)' : ''}`);
    await g
      .waitFor(() => !pa(g) || !!pa(g)?.revealedCards, '공개 또는 종료', scaled(30000) + 2000)
      .catch(() => undefined);
    if (pa(g)?.revealedCards) {
      g.clients.forEach((c, i) => g.p(i).isAlive && c.act('confirm_reveal'));
    }
    await g.waitFor(() => !pa(g), '이벤트 종료', scaled(30000) + 2000);
    t.expect(!g.p(0).isAlive, '유효한 생존자를 공개했다면 악의가 있으므로 가람은 죽어야 함 (잘못된 id로 페널티를 피하면 안 됨)');
  },
);

scenario(
  '예언: 같은 카드 id를 여러 번 보내 덱의 카드를 복제할 수 없다',
  { card: '예언', rule: R_PROPHECY },
  async (t) => {
    const g = await t.game({ players: 3, deck: ['예언', '시선', '상처', '흑역사'], filler: 5 });
    g.c(0).act('draw_card');
    await g.waitFor(() => g.requests(0, 'request_prophecy').length > 0, '예언 요청');
    const cards = g.requests(0, 'request_prophecy')[0][1] as Card[];
    const before = g.room.deck.length;
    g.c(0).act('submit_prophecy', [cards[0].id, cards[0].id, cards[0].id]);
    await g.waitPhase('MAIN');
    await g.settle();
    const ids = g.room.deck.map((c) => c.id);
    t.note(`예언 전 덱 ${before}장 → 후 ${ids.length}장, 맨 위 5장: ${g.room.deck.slice(-5).reverse().map((c) => c.name).join(', ')}`);
    t.expectEq(ids.length, before, '덱 장수는 그대로여야 함');
    t.expectEq(new Set(ids).size, ids.length, '덱에 같은 카드(id)가 두 번 들어가면 안 됨');
  },
);

scenario(
  '선택 (善): 패 공개 중 다른 생존자가 submit_cards를 보내도 그 사람 패의 카드가 사라지지 않는다',
  { card: '선택 (善)', rule: `${R_GOOD} (패 공개는 카드 제출 단계가 아님)` },
  async (t) => {
    const g = await t.game({ players: 3, hands: { 1: ['코인'], 2: ['성배'] }, deck: ['선택 (善)'] });
    await startReveal(g, 0, 1);
    g.c(2).act('submit_cards', [g.cardId(2, '성배')]);
    await g.settle();
    const during = g.hand(2);
    g.clients.forEach((c, i) => g.p(i).isAlive && c.act('confirm_reveal'));
    await g.waitFor(() => !pa(g), '패 공개 종료');
    await g.settle();
    t.note(`submit_cards 직후 다온 패: [${during.join(', ')}], 공개 종료 후: [${g.hand(2).join(', ')}], 무덤에 성배: ${inGrave(g, '성배')}`);
    t.expectEq(during, ['성배'], 'submit_cards 직후에도 성배가 패에 있어야 함');
    t.expectEq(g.hand(2), ['성배'], '공개가 끝난 뒤에도 성배가 패에 있어야 함');
  },
);

// ════════════════════════════════════════════════════════════════════
// 4. 다른 방 소켓 · 권한
// ════════════════════════════════════════════════════════════════════

scenario(
  '보안 · return_to_lobby: 게임 진행 중 참가자가 보내도 게임이 대기실로 초기화되면 안 된다',
  { card: '보안', rule: 'return_to_lobby는 게임 종료(ENDED) 후 대기실 복귀용입니다. 클라이언트도 게임 종료 화면에서만 보냅니다.' },
  async (t) => {
    const g = await t.game({ players: 3, hands: { 0: ['성정'], 1: ['시선'] } });
    g.c(1).act('return_to_lobby');
    await g.settle();
    t.expectEq(g.room.phase, 'MAIN', '게임이 계속되어야 함');
    t.expectEq(g.hand(0), ['성정'], '가람의 패가 유지되어야 함');
    t.expectEq(g.hand(1), ['시선'], '나래의 패가 유지되어야 함');
  },
);

scenario(
  '게임 흐름 · return_to_lobby: 게임이 끝난(ENDED) 뒤에는 대기실로 돌아가 다시 시작할 수 있다',
  { card: '게임 흐름', rule: 'return_to_lobby는 게임 종료(ENDED) 후 대기실 복귀용입니다.' },
  async (t) => {
    const g = await t.game({ players: 2, hands: { 0: ['성정'] } });
    g.c(0).act('play_tool', g.cardId(0, '성정'), ID(g, 1));
    await g.waitPhase('WAITING_FOR_DEFENSE');
    g.c(1).act('skip_defense');
    await g.waitPhase('ENDED');
    g.c(1).act('return_to_lobby');
    await g.waitPhase('WAITING');
    t.expectEq(roomOf(g).players.length, 2, '두 사람 모두 대기실에 남음');
    t.expect((roomOf(g).players as Player[]).every((p) => p.isAlive && handOf(p).length === 0), '생존/패가 초기화됨');
    g.c(0).act('start_game');
    await g.waitPhase('MAIN');
    g.tracker.rebaseline(); // 새 게임의 덱으로 기준선 재설정
    t.expect((roomOf(g).players as Player[]).every((p) => p.isAlive), '새 게임 시작');
  },
);

scenario(
  '보안 · 다른 방 소켓: return_to_lobby로 남의 게임을 초기화할 수 없다',
  { card: '보안', rule: R_ROOM },
  async (t) => {
    const g = await t.game({ players: 3, hands: { 0: ['성정'] } });
    const o = await outsider(g.srv);
    try {
      o.x.raw('return_to_lobby', g.code);
      await g.settle();
      t.expectEq(g.room.phase, 'MAIN', '게임이 계속되어야 함');
      t.expectEq(g.hand(0), ['성정'], '패가 유지되어야 함');
    } finally {
      await o.close();
    }
  },
);

scenario(
  '보안 · 다른 방 소켓: 이 방 코드로 보낸 투표가 기록·집계되면 안 된다',
  { card: '보안', rule: `${R_ROOM} ${R_JUDGE}` },
  async (t) => {
    const g = await t.game({ players: 3, deck: ['천사의 심판대'] });
    const o = await outsider(g.srv);
    try {
      await drawTo(g, 0, () => pa(g)?.type === 'VOTE', '투표 시작');
      const vote = pa(g);
      o.x.raw('submit_vote', g.code, ID(g, 1), false);
      await g.settle();
      const recorded = o.x.id in vote.responses;
      g.c(0).act('submit_vote', ID(g, 1), false);
      g.c(1).act('submit_vote', ID(g, 2), false);
      await g.settle();
      t.note(`외부인 투표 기록: ${recorded}, 가람·나래 투표 후 투표 진행 중: ${pa(g) === vote}`);
      t.expect(!recorded, '방에 없는 소켓의 투표는 기록되면 안 됨');
      t.expect(pa(g) === vote, '다온이 아직 투표하지 않았으므로 투표가 계속되어야 함');
    } finally {
      await o.close();
    }
  },
);

scenario(
  '보안 · 다른 방 소켓: 패 공개 확인(confirm_reveal)이 생존자 확인 수에 포함되면 안 된다',
  { card: '보안', rule: `${R_ROOM} 패 공개는 모든 생존자가 확인하거나 제한시간이 지나야 끝납니다.` },
  async (t) => {
    const g = await t.game({ players: 3, hands: { 1: ['시선'] }, deck: ['선택 (善)'] });
    const o = await outsider(g.srv);
    try {
      await startReveal(g, 0, 1);
      const rev = pa(g);
      o.x.raw('confirm_reveal', g.code);
      await g.settle();
      const recorded = o.x.id in rev.responses;
      g.c(0).act('confirm_reveal');
      g.c(1).act('confirm_reveal');
      await g.settle();
      t.note(`외부인 확인 기록: ${recorded}, 가람·나래 확인 후 공개 진행 중: ${pa(g) === rev}`);
      t.expect(!recorded, '방에 없는 소켓의 확인은 기록되면 안 됨');
      t.expect(pa(g) === rev, '다온이 아직 확인하지 않았으므로 패 공개가 계속되어야 함');
    } finally {
      await o.close();
    }
  },
);

scenario(
  '보안 · 다른 방 소켓: start_game으로 남의 대기실 게임을 시작할 수 없다',
  { card: '보안', rule: R_ROOM },
  async (t) => {
    const lb = await openLobby(2);
    const o = await outsider(lb.srv);
    try {
      o.x.raw('start_game', lb.code);
      await sleep(150);
      t.expectEq(lb.room().phase, 'WAITING', '방에 없는 소켓이 게임을 시작하면 안 됨');
    } finally {
      await o.close();
      await lb.close();
    }
  },
);

scenario(
  '보안 · 다른 방 소켓: 그 밖의 모든 액션(뽑기·무기·방패·제출·아이템·채팅·퇴장 등)은 이 방에 아무 영향이 없다',
  { card: '보안', rule: R_ROOM, timeoutMs: 120000, allowViolations: ALL_VIOLATIONS },
  async (t) => {
    const srv = await startTestServer();
    const o = await outsider(srv);
    const changed: string[] = [];
    let probes = 0;
    const evs = ROOMCODE_ONLY_EVENTS.filter(([ev]) => !['start_game', 'return_to_lobby', 'submit_vote', 'confirm_reveal'].includes(ev));
    const phases = [PH.MAIN, PH.LINKED, PH.DEFENSE, PH.ARROW, PH.VOTE_JUDGE, PH.SUB_SAC, PH.SUB_EXCAL, PH.REVEAL, PH.PROPHECY, PH.GIFT, PH.MAYUK_CHOICE, PH.GHOST_KARMA, PH.BAIT];
    try {
      for (const ph of phases) {
        const g = await ph.setup(createGame);
        try {
          for (const [ev, d] of evs) {
            // 방 참가자 0번(가람)이 보낼 법한 유효한 인자를 그대로 사용
            const args = d(g, 0);
            const s0 = sig(g);
            o.x.raw(ev, g.code, ...args);
            probes++;
            await barrier(srv, o.x, o.code);
            if (sig(g) !== s0) changed.push(`${ev} @ ${ph.label}`);
          }
        } finally {
          await g.close();
        }
      }
    } finally {
      await o.close();
    }
    t.note(`프로브 ${probes}회`);
    t.expectEq(changed, [], '방에 없는 소켓의 요청으로 방 상태가 바뀌면 안 됨');
  },
);

scenario(
  '보안 · start_game: 방장(첫 번째 입장자)이 아닌 참가자는 게임을 시작할 수 없다',
  { card: '보안', rule: '클라이언트는 방장(roomPlayers[0])에게만 게임 시작 버튼을 보여 줍니다 (Lobby.tsx isHost).' },
  async (t) => {
    const lb = await openLobby(3);
    try {
      lb.clients[1].raw('start_game', lb.code);
      await sleep(150);
      const afterGuest = lb.room().phase;
      t.note(`나래(방장 아님)가 start_game을 보낸 뒤 단계: ${afterGuest}`);
      t.expectEq(afterGuest, 'WAITING', '방장이 아닌 사람의 start_game은 무시되어야 함');
    } finally {
      await lb.close();
    }
  },
);

scenario(
  '게임 흐름 · start_game: 게임 진행 중(MAIN/방어 대기/투표)에 다시 보내도 게임이 재시작되지 않는다',
  { card: '게임 흐름', rule: '진행 중인 게임은 끝나기 전에는 다시 시작되면 안 됩니다.' },
  async (t) => {
    const g = await t.game({ players: 3, hands: { 0: ['성정', '코인'], 1: ['황금 방패', '시선'] }, deck: ['천사의 심판대'] });
    const snapshot = () => JSON.stringify([g.hand(0), g.hand(1), g.hand(2), g.room.deck.length, g.room.currentTurnPlayerId]);
    const s0 = snapshot();
    g.c(0).act('start_game');
    await g.settle();
    t.expectEq(g.room.phase, 'MAIN', 'MAIN 유지');
    t.expectEq(snapshot(), s0, 'MAIN 중 start_game으로 패/덱/차례가 바뀌면 안 됨');

    g.c(0).act('play_tool', g.cardId(0, '성정'), ID(g, 1));
    await g.waitPhase('WAITING_FOR_DEFENSE');
    const atk = pa(g);
    g.c(2).act('start_game');
    await g.settle();
    t.expect(g.room.phase === 'WAITING_FOR_DEFENSE' && pa(g) === atk, '방어 대기 중 start_game으로 바뀌면 안 됨');
    g.c(1).act('play_shield', g.cardId(1, '황금 방패'));
    await g.waitPhase('MAIN');

    await drawTo(g, 0, () => pa(g)?.type === 'VOTE', '투표 시작');
    const vote = pa(g);
    g.c(1).act('start_game');
    await g.settle();
    t.expect(g.room.phase === 'RESOLVING_EVENT' && pa(g) === vote, '투표 중 start_game으로 바뀌면 안 됨');
    t.expectEq(g.hand(1), ['시선'], '나래 패 유지');
  },
);

// ════════════════════════════════════════════════════════════════════
// 5. 입장 (중간 입장 / 최대 인원 / 중복 입장 / 이상한 이름)
// ════════════════════════════════════════════════════════════════════

scenario(
  '입장 · join_room: 게임 진행 중 들어온 사람은 생존자로 차례·투표에 끼어들면 안 된다',
  { card: '입장/퇴장', rule: '게임은 시작 시점의 참가자로 진행됩니다 (덱도 시작 인원 × 10장으로 구성). 진행 중 입장자는 거부하거나 관전자로 두어야 합니다.' },
  async (t) => {
    const g = await t.game({ players: 3 });
    const j = await newClient(g.srv, '난입자');
    try {
      j.join(g.code);
      await waitUntil(() => j.eventsOf('room_state_update').length > 0, 500, '입장 응답').catch(() => undefined);
      await g.settle();
      const jp = (roomOf(g).players as Player[]).find((p) => p.id === j.id);
      t.note(
        `입장 결과: 방 인원 ${roomOf(g).players.length}명, 난입자 ${jp ? (jp.isAlive ? `생존자로 등록(패 ${handOf(jp).length}장, 좌석 ${roomOf(g).players.indexOf(jp) + 1}번)` : '사망 상태로 등록') : '등록 안 됨'}, game_state_update 수신 ${j.eventsOf('game_state_update').length}회`,
      );
      if (jp) {
        const seen: string[] = [];
        for (let k = 0; k < 3; k++) {
          const idx = g.indexOf(roomOf(g).currentTurnPlayerId);
          if (idx < 0) break;
          await endTurnOf(g, idx);
          seen.push(curName(g));
        }
        t.note(`가람부터 차례를 넘기면: ${seen.join(' → ')}`);
      }
      t.expect(!jp || !jp.isAlive, '진행 중인 게임에 새로 들어온 사람이 생존자로 등록되면 안 됨');
    } finally {
      j.close();
      await sleep(50);
    }
  },
);

scenario(
  '입장 · join_room: 최대 인원(6명)이 찬 방에 7번째 입장은 거부된다',
  { card: '입장/퇴장', rule: R_MAX },
  async (t) => {
    const lb = await openLobby(6);
    try {
      const seventh = await newClient(lb.srv, DEFAULT_NAMES[6]);
      lb.extra.push(seventh);
      seventh.join(lb.code);
      await sleep(150);
      t.note(`7번째 입장 후 방 인원: ${lb.room().players.length}명, 7번째가 받은 대기실 목록: ${seventh.roomPlayers.length}명`);
      t.expectEq(lb.room().players.length, 6, '7번째 입장자는 거부되어야 함');
    } finally {
      await lb.close();
    }
  },
);

scenario(
  '입장 · join_room: 같은 소켓이 두 번 보내도 플레이어가 중복 등록되지 않는다',
  { card: '입장/퇴장', rule: '한 소켓(브라우저 탭)은 한 방에 한 명의 플레이어입니다.' },
  async (t) => {
    const lb = await openLobby(2);
    try {
      const a = lb.clients[0];
      const aid = a.id;
      a.join(lb.code); // 같은 방에 다시 입장 (예: 입장 버튼 연타)
      await sleep(150);
      const entries = (lb.room().players as Player[]).filter((p) => p.id === aid);
      t.note(`같은 소켓의 플레이어 항목 ${entries.length}개: ${entries.map((p) => p.name).join(', ')}`);
      if (entries.length > 1) {
        lb.clients[0].raw('start_game', lb.code);
        await waitUntil(() => lb.room().phase === 'MAIN', 1000, '게임 시작').catch(() => undefined);
        t.note(`게임 시작 시 좌석 ${lb.room().players.length}개, 생존자 ${lb.room().getAlivePlayers().length}명`);
        a.close();
        await sleep(150);
        const left = (lb.room()?.players ?? []).filter((p: Player) => p.id === aid);
        t.note(`가람 연결이 끊긴 뒤 남은 가람 항목: ${left.length}개(생존 ${left.filter((p: Player) => p.isAlive).length}), 방 단계: ${lb.room()?.phase}`);
        lb.room()?.resetToLobby();
        if (lb.room()) lb.room().players = lb.room().players.filter((p: Player) => p.id !== aid);
      }
      t.expectEq(entries.length, 1, '같은 소켓은 한 번만 등록되어야 함');
    } finally {
      await lb.close();
    }
  },
);

scenario(
  '입장 · 다른 방 소켓: 두 방에 동시에 들어간 소켓의 연결이 끊기면 두 방 모두에서 정리된다',
  { card: '입장/퇴장', rule: '연결이 끊긴 플레이어는 진행 중인 게임에서 탈락 처리되어야 합니다 (생존한 유령이 남으면 안 됨).' },
  async (t) => {
    const r1 = await openLobby(2, ['가람', '나래']);
    const r2 = await openLobby(1, ['다온']);
    const gx = r1.clients[0];
    const gid = gx.id;
    try {
      gx.raw('join_room', r2.code, '가람');
      await waitUntil(() => r2.room().players.length === 2, 1000, '가람이 두 번째 방에도 입장');
      r2.clients[0].raw('start_game', r2.code);
      await waitUntil(() => r2.room().phase === 'MAIN', 1000, '두 번째 방 게임 시작');
      gx.close();
      await sleep(200);
      const inR1 = !!r1.room()?.players.some((p: Player) => p.id === gid);
      const ghost = (r2.room()?.players ?? []).find((p: Player) => p.id === gid);
      t.note(`연결 끊김 후: 첫 방에 남음=${inR1}, 두 번째 방(게임 중)에 ${ghost ? (ghost.isAlive ? '생존자로 남음' : '사망자로 남음') : '없음'}, 두 번째 방 단계=${r2.room()?.phase}`);
      t.expect(!inR1, '첫 번째 방에서 정리되어야 함');
      t.expect(!ghost || !ghost.isAlive, '두 번째 방(게임 중)에서도 탈락/퇴장 처리되어야 함');
    } finally {
      if (r2.room()) {
        r2.room().resetToLobby();
        r2.room().players = r2.room().players.filter((p: Player) => p.id !== gid);
      }
      await r1.close();
      await r2.close();
    }
  },
);

scenario(
  '보안 · join_room: 문자열이 아닌 닉네임(객체/숫자)은 거부되거나 문자열로 바뀐다',
  { card: '보안', rule: '닉네임은 문자열이어야 합니다. 클라이언트는 받은 이름을 그대로 렌더링/startsWith 처리하므로(ChatBoard.tsx) 객체 이름은 방 전체 화면을 깨뜨릴 수 있습니다.' },
  async (t) => {
    const lb = await openLobby(1, ['방장']);
    try {
      const results: string[] = [];
      for (const [label, value] of [
        ['{"이름":"객체"}', { 이름: '객체' }],
        ['12345', 12345],
      ] as Array<[string, any]>) {
        const j = await newClient(lb.srv, '입장자');
        lb.extra.push(j);
        j.raw('join_room', lb.code, value);
        await waitUntil(() => lb.room().players.some((p: Player) => p.id === j.id), 500, '입장').catch(() => undefined);
        const p = (lb.room().players as Player[]).find((x) => x.id === j.id);
        const sent = lb.clients[0].roomPlayers.find((x) => x.id === j.id);
        results.push(`${label} → 저장된 이름 타입 ${p ? typeof p.name : '(거부됨)'}, 방장에게 전달된 이름 타입 ${sent ? typeof sent.name : '-'}`);
      }
      for (const r of results) t.note(r);
      const bad = (lb.room().players as Player[]).filter((p) => typeof p.name !== 'string');
      t.expectEq(bad.length, 0, '문자열이 아닌 이름이 저장/전파되면 안 됨');
    } finally {
      await lb.close();
    }
  },
);

scenario(
  '보안 · send_chat: 문자열이 아닌 메시지(객체)는 다른 클라이언트에 그대로 뿌려지지 않는다',
  { card: '보안', rule: '채팅 메시지는 문자열이어야 합니다. 클라이언트는 받은 메시지를 React 자식으로 바로 렌더링하므로(ChatBoard.tsx {msg.text}) 객체가 오면 화면이 깨집니다.' },
  async (t) => {
    const g = await t.game({ players: 2 });
    g.c(0).act('send_chat', { 내용: '객체 메시지' });
    await g.settle();
    const got = g.c(1).eventsOf('chat_message', g.t0).map((e) => e.args[1]);
    t.note(`나래가 받은 chat_message 메시지 타입: ${got.map((m) => typeof m).join(', ') || '(없음)'}`);
    t.expect(got.every((m) => typeof m === 'string'), '문자열이 아닌 채팅이 다른 사람에게 전달되면 안 됨');
  },
);

scenario(
  '입력 길이 · join_room: 아주 긴 닉네임(5만 자)',
  {
    card: '입력 길이',
    rule: '클라이언트 입력창은 닉네임을 10자로 제한합니다 (Lobby.tsx maxLength=10).',
    ambiguous: '서버에서도 닉네임 길이를 제한(예: 10자, 초과 시 거부/절단)해야 하나요? 현재는 아무 길이나 저장되어 모든 상태 갱신마다 전원에게 전송됩니다.',
  },
  async (t) => {
    const lb = await openLobby(1, ['방장']);
    try {
      const long = 'ㄱ'.repeat(50000);
      const j = await newClient(lb.srv, long);
      lb.extra.push(j);
      j.join(lb.code);
      await waitUntil(() => lb.room().players.length === 2, 1000, '긴 이름 입장').catch(() => undefined);
      const p = (lb.room().players as Player[]).find((x) => x.id === j.id);
      t.note(`5만 자 닉네임 입장: ${p ? `허용, 저장된 길이 ${p.name.length}자` : '거부'}`);
      t.expect(!p || p.name.length <= 10, '서버도 닉네임 길이를 제한한다면 10자 이하');
    } finally {
      await lb.close();
    }
  },
);

scenario(
  '입력 길이 · send_chat: 아주 긴 채팅(30만 자 / 1MB 초과)',
  {
    card: '입력 길이',
    rule: '채팅 입력창(ChatBoard.tsx)에는 길이 제한이 없습니다. socket.io 기본 maxHttpBufferSize는 1MB입니다.',
    ambiguous:
      '서버에서 채팅 길이를 제한해야 하나요? 현재 30만 자 채팅은 그대로 전원에게 전달되고, 1MB를 넘는 채팅을 보내면 보낸 사람의 연결이 끊겨 게임에서 탈락 처리됩니다. 긴 글을 붙여넣은 사람이 탈락하는 것이 의도된 동작인가요?',
    allowViolations: ['CARD_LOST_ON_LEAVE'],
  },
  async (t) => {
    const g = await t.game({ players: 3, hands: { 2: ['코인'] } });
    const big = 'ㄱ'.repeat(300000);
    g.c(2).act('send_chat', big);
    await g.waitFor(() => g.c(0).eventsOf('chat_message', g.t0).length > 0, '긴 채팅 수신').catch(() => undefined);
    const got = g.c(0).eventsOf('chat_message', g.t0)[0]?.args[1];
    t.note(`30만 자 채팅: 가람이 받은 길이 ${typeof got === 'string' ? got.length : '(못 받음)'}`);
    const id2 = ID(g, 2);
    g.c(2).act('send_chat', 'a'.repeat(1_100_000));
    await sleep(500);
    const p2 = (roomOf(g).players as Player[]).find((p) => p.id === id2);
    t.note(`1.1MB 채팅 후: 다온 소켓 연결=${g.c(2).socket.connected}, 방에 ${p2 ? (p2.isAlive ? '생존' : '사망') : '없음(퇴장 처리)'}, 단계=${g.room.phase}`);
    t.expect(typeof got !== 'string' || got.length <= 1000, '서버도 채팅 길이를 제한한다면 전달되는 메시지는 짧아야 함');
    t.expect(!!p2 && p2.isAlive, '긴 채팅을 보냈다는 이유로 탈락하면 안 됨');
  },
);

// ════════════════════════════════════════════════════════════════════
// 6. 퇴장 / 연결 끊김과 차례 순서
// ════════════════════════════════════════════════════════════════════

scenario(
  '퇴장 · 자기 차례에 나가면(첫 좌석) 다음 생존자 차례가 되고 이후 아무도 건너뛰지 않는다',
  { card: '입장/퇴장', rule: R_TURN },
  async (t) => {
    const g = await t.game({ players: 4 });
    await leaveAndWait(g, 0, 'leave');
    g.check();
    const first = curName(g);
    const seen = await rotate(g, 3);
    t.note(`나래부터 차례를 넘기면: ${seen.join(' → ')}`);
    noteViolations(t, g);
    t.expectEq(first, '나래', '가람이 나간 뒤 나래 차례');
    t.expectEq(seen, ['다온', '라온', '나래'], '나래 → 다온 → 라온 → 나래 순서');
  },
);

scenario(
  '퇴장 · 차례가 아닌 앞 좌석 플레이어가 나가도 차례 순서가 건너뛰지 않는다',
  { card: '입장/퇴장', rule: R_TURN },
  async (t) => {
    const g = await t.game({ players: 4, turn: 2 });
    await leaveAndWait(g, 0, 'leave');
    g.check();
    t.expectEq(curName(g), '다온', '다온 차례 유지');
    const seen = await rotate(g, 3);
    t.note(`다온부터 차례를 넘기면: ${seen.join(' → ')}`);
    noteViolations(t, g);
    t.expectEq(seen, ['라온', '나래', '다온'], '다온 → 라온 → 나래 → 다온 순서');
  },
);

scenario(
  '퇴장 · 마지막 좌석 플레이어가 자기 차례에 연결이 끊기면 첫 좌석부터 정상 진행된다',
  { card: '입장/퇴장', rule: R_TURN },
  async (t) => {
    const g = await t.game({ players: 3, turn: 2 });
    await leaveAndWait(g, 2, 'disconnect');
    g.check();
    t.expectEq(curName(g), '가람', '다온이 끊긴 뒤 가람 차례');
    const seen = await rotate(g, 2);
    t.expectEq(seen, ['나래', '가람'], '가람 → 나래 → 가람 순서');
    t.expect(isTimerPending(g.room.turnTimer), '턴 타이머가 돌아야 함');
  },
);

scenario(
  '퇴장 · 가운데 좌석 플레이어가 자기 차례에 연결이 끊겨도(disconnect) 이후 차례가 건너뛰지 않는다',
  { card: '입장/퇴장', rule: R_TURN },
  async (t) => {
    const g = await t.game({ players: 4, turn: 1 });
    await leaveAndWait(g, 1, 'disconnect');
    g.check();
    t.expectEq(curName(g), '다온', '나래가 끊긴 뒤 다온 차례');
    const seen = await rotate(g, 3);
    t.note(`다온부터 차례를 넘기면: ${seen.join(' → ')}`);
    noteViolations(t, g);
    t.expectEq(seen, ['라온', '가람', '다온'], '다온 → 라온 → 가람 → 다온 순서');
  },
);

scenario(
  '퇴장 · 무기 방어 대상이 방어 대기 중 나가면 공격이 정리되고 공격자의 차례가 이어진다',
  { card: '입장/퇴장', rule: `${R_TURN} 방어 대상이 사라지면 대기 중인 공격도 정리되어야 합니다.` },
  async (t) => {
    const g = await t.game({ players: 3, hands: { 0: ['성정'] } });
    g.c(0).act('play_tool', g.cardId(0, '성정'), ID(g, 2));
    await g.waitPhase('WAITING_FOR_DEFENSE');
    await leaveAndWait(g, 2, 'leave');
    g.check();
    t.expectEq(g.room.phase, 'MAIN', 'MAIN으로 복귀');
    t.expect(!pa(g), '대기 중인 공격이 남으면 안 됨');
    t.expectEq(curName(g), '가람', '공격자 가람의 차례가 이어짐');
    t.expect(isTimerPending(g.room.turnTimer) && !g.room.isTurnTimerPaused, '가람의 턴 타이머가 다시 돌아야 함');
    const seen = await rotate(g, 2);
    t.expectEq(seen, ['나래', '가람'], '가람 → 나래 → 가람 순서');
  },
);

scenario(
  '퇴장 · 공격자가 방어 대기 중 나가면 다음 생존자 차례가 되고 이후 아무도 건너뛰지 않는다',
  { card: '입장/퇴장', rule: R_TURN },
  async (t) => {
    const g = await t.game({ players: 3, hands: { 0: ['성정'] } });
    g.c(0).act('play_tool', g.cardId(0, '성정'), ID(g, 1));
    await g.waitPhase('WAITING_FOR_DEFENSE');
    await leaveAndWait(g, 0, 'leave');
    g.check();
    t.note(`가람 퇴장 직후: phase=${g.room.phase}, 대기 액션=${pa(g)?.type ?? '없음'}, 나래 생존=${g.p(1).isAlive}`);
    t.expectEq(g.room.phase, 'MAIN', 'MAIN으로 복귀');
    t.expectEq(curName(g), '나래', '가람 다음 생존자인 나래 차례');
    const seen = await rotate(g, 2);
    t.note(`나래부터 차례를 넘기면: ${seen.join(' → ')}`);
    noteViolations(t, g);
    t.expectEq(seen, ['다온', '나래'], '나래 → 다온 → 나래 순서');
  },
);

scenario(
  '퇴장 · 이미 투표한 사람이 나가면 남은 생존자 전원이 투표할 때까지 투표가 끝나지 않는다',
  { card: '입장/퇴장', rule: `${R_JUDGE} (투표는 모든 생존자가 투표하거나 제한시간이 지나야 집계)` },
  async (t) => {
    const g = await t.game({ players: 3, deck: ['천사의 심판대'] });
    await drawTo(g, 0, () => pa(g)?.type === 'VOTE', '투표 시작');
    const vote = pa(g);
    g.c(1).act('submit_vote', ID(g, 2), false);
    await g.waitFor(() => ID(g, 1) in vote.responses, '나래 투표');
    await leaveAndWait(g, 1, 'leave');
    g.c(0).act('submit_vote', ID(g, 2), false);
    await g.settle();
    t.note(`가람 투표 후: 투표 진행 중=${pa(g) === vote}, 응답 키 수=${Object.keys(vote.responses).length}(나간 나래 포함)`);
    t.expect(pa(g) === vote, '다온이 아직 투표하지 않았으므로 투표가 계속되어야 함');
  },
);

scenario(
  '퇴장 · 투표 중 다른 사람이 모두 나가 게임이 끝나면, 남은 투표가 게임 종료 뒤에 처리되면 안 된다',
  { card: '입장/퇴장', rule: `${R_LAST} ${R_JUDGE}` },
  async (t) => {
    const g = await t.game({ players: 3, hands: { 0: ['시선'] }, deck: ['천사의 심판대'] });
    await drawTo(g, 0, () => pa(g)?.type === 'VOTE', '투표 시작');
    await leaveAndWait(g, 1, 'leave');
    await leaveAndWait(g, 2, 'leave');
    await g.waitPhase('ENDED');
    g.check();
    const phases = new Set<string>();
    const until = Date.now() + scaled(30000) * 2 + 800;
    while (Date.now() < until) {
      phases.add(g.room.phase);
      await sleep(10);
    }
    noteViolations(t, g);
    t.note(`게임 종료 후 관찰된 단계: ${[...phases].join(', ')} / 가람 생존: ${g.p(0).isAlive} / game_over 수신 ${g.c(0).gameOvers.length}회 (마지막 점수: ${JSON.stringify(g.c(0).gameOvers.at(-1)?.map((s) => [s.name, s.score]))})`);
    t.expect([...phases].every((p) => p === 'ENDED'), '게임 종료(ENDED) 후 단계가 바뀌면 안 됨');
    t.expect(g.p(0).isAlive, '최후의 1인 가람은 게임 종료 후 죽으면 안 됨');
    t.expectEq(g.c(0).gameOvers.length, 1, 'game_over는 한 번만 보내져야 함');
  },
);

scenario(
  '선택 (善): 패 공개 중 공개 대상이 나가도 뽑은 자의 사망 판정은 유지된다',
  { card: '선택 (善)', rule: R_GOOD },
  async (t) => {
    const g = await t.game({ players: 4, hands: { 1: ['시선'] }, deck: ['선택 (善)'] });
    await startReveal(g, 0, 1);
    await leaveAndWait(g, 1, 'leave');
    t.note(`나래 퇴장 직후: phase=${g.room.phase}, 패 공개 진행 중=${!!pa(g)?.revealedCards}`);
    if (pa(g)?.revealedCards) {
      g.clients.forEach((c, i) => i !== 1 && g.p(i).isAlive && c.act('confirm_reveal'));
    }
    await g.waitFor(() => !pa(g), '패 공개 종료', scaled(30000) + 2000);
    await g.settle();
    t.expect(!g.p(0).isAlive, '공개된 나래의 패에 악의가 있었으므로 가람은 죽어야 함');
  },
);
