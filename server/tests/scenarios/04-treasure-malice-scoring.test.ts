import { scenario } from '../harness/runner';
import type { GameCtx } from '../harness/game';
import type { PlayerScore } from '../../../shared/types';
import { isTimerPending } from '../harness/timescale';
import { expectedMalice } from '../harness/invariants';
import { TestClient } from '../harness/client';

// 04: 보물(성배·십자가#502·코인·복권·교환권·누군가의 로켓), 악의 카드 12종, 성향(선인/악인), 게임 종료 정산
// 규칙(card.json)대로의 동작을 단언합니다. 실패 = 현재 구현이 규칙과 다름.

// ── 규칙 원문 ────────────────────────────────────────────────────────
const R_USELESS = '특별하게 요구하는 상황(면죄부 등)이 아니라면 기본적으로 무용한 카드입니다.';
const R_LOTTERY =
  '이 보물은 탈출 중에는 일반적인 보물과 같으나 선인으로 탈출에 성공하고 이 보물을 지니고 있다면 승점을 1점 더 얻습니다. / 악인으로 생존 시에는 승점 혜택이 적용되지 않습니다.';
const R_LOCKET =
  '이 보물은 악의인 동시에 보물입니다. 악의를 제외한 카드로 사용 가능합니다. / 이벤트(면죄부 등)에 제출 시, 이 카드 단독(보물+악의 동시 1장 취급)으로는 불가능하며 다른 보물 카드 혹은 악의 카드와 섞어서 제출해야 합니다.';
const R_DEEP = '이 악의는 악의 2장입니다. / 악의를 버리거나 카드를 낼 때는 1장으로 취급합니다. (패에 들고 있을 때만 악의 2장으로 산정)';
const R_INDULGENCE = '[면죄부] 자신의 패에서 보물 1장을 버리면 자신의 악의 1장을 버릴 수 있습니다. 원하는 생존자는 모두 가능합니다. / [1] 1회만 가능합니다.';
const R_DISARM = '[무장해제] 자신의 패에서 무기를 1장 버리면 자신의 악의를 1장 버릴 수 있습니다.';
const R_SAC = '[제물] 모든 생존자는 힘을 합쳐 악의를 제외한 카드를 참가자 수만큼 바쳐야 합니다.';
const R_MALICE = '악의 카드(evilScore 1): 패에 있는 악의 1장 = 악의 1점. 사용(isPlayable=false)할 수 없는 카드.';
const R_SCORE =
  '정산(과제 명세): 최후의 1인이 악인이면 참가 인원만큼, 선인 생존자는 생존자 수만큼 승점. 복권/교환권 +1은 선인 생존자만. 사망자는 0점.';
const R_ALIGN = '성향: 패의 악의 점수(짙은 악의 2점, 누군가의 ~ 1점, 선의 -1)로 선인/악인이 정해지며 패가 바뀔 때마다 다시 계산되어야 함.';

const PLAIN_MALICE = ['시선', '빈상자', '상처', '코즈믹 호러', '흑역사', '어제의 동료', '계시', '사랑이란 변명', '암전', '탐욕', '질투'];
const ALL_MALICE = [...PLAIN_MALICE, '짙은 악의'];
const PLAIN_TREASURES = ['성배', '십자가#502', '코인', '복권', '교환권'];

// ── 헬퍼 ─────────────────────────────────────────────────────────────
const pa = (g: GameCtx): any => g.room.pendingAction as any;

async function drawEvent(g: GameCtx, i: number, name: string): Promise<void> {
  g.c(i).act('draw_card');
  await g.waitFor(() => g.room.graveyard.some((c) => c.name === name), `${name} 발동`);
}

async function attackAndKill(g: GameCtx, a: number, v: number, weapon: string): Promise<void> {
  g.c(a).act('play_tool', g.cardId(a, weapon), g.c(v).id);
  await g.waitPhase('WAITING_FOR_DEFENSE');
  g.c(v).act('skip_defense');
  await g.waitFor(() => !g.p(v).isAlive, `${g.c(v).name} 사망`);
}

async function waitGameOver(g: GameCtx, who: number[]): Promise<void> {
  await g.waitFor(() => who.every((i) => g.c(i).gameOvers.length > 0), 'game_over 수신');
  await g.settle(60);
  // 종료(ENDED) 상태를 불변식 추적기에 기록해 둡니다 (이후 단계/생존 변화 감지용).
  g.check();
}

function scoreOf(g: GameCtx, scores: PlayerScore[], i: number): number | undefined {
  return scores.find((s) => s.playerId === g.c(i).id)?.score;
}

function fmtScores(scores: PlayerScore[]): string {
  return scores.map((s) => `${s.name}=${s.score}(${s.reason})`).join(', ');
}

async function expectClientSync(t: any, g: GameCtx, i: number): Promise<void> {
  await g.settle();
  const st = g.c(i).state!;
  t.expectEq(st.myInfo.currentMalice, g.p(i).currentMalice, `${g.c(i).name} 화면의 악의 점수`);
  t.expectEq(st.myInfo.alignment, g.p(i).alignment, `${g.c(i).name} 화면의 성향`);
}

const inGraveById = (g: GameCtx, id: string) => g.room.graveyard.some((c) => c.id === id);
const sorted = (xs: string[]) => [...xs].sort();

async function waitReveal(g: GameCtx): Promise<void> {
  await g.waitFor(() => !!pa(g)?.revealedCards, '패 공개 시작');
}

function confirmAllAlive(g: GameCtx): void {
  g.clients.forEach((c, i) => {
    if (g.p(i).isAlive) c.act('confirm_reveal');
  });
}

/** 지정 시간 동안 단계를 기록합니다 (게임 종료 후 단계가 바뀌는지 관찰). */
async function samplePhases(g: GameCtx, ms: number): Promise<string[]> {
  const seen: string[] = [];
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const ph = g.room.phase;
    if (seen[seen.length - 1] !== ph) seen.push(ph);
    try {
      g.check();
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  return seen;
}

// ════════════════════════════════════════════════════════════════════
// 1. 악의 점수 계산
// ════════════════════════════════════════════════════════════════════

for (const name of PLAIN_MALICE) {
  scenario(`${name}: 뽑으면 악의 칸에 들어가 악의 1점으로 계산된다`, { card: name, rule: R_MALICE }, async (t) => {
    const g = await t.game({ players: 2, deck: [name] });
    g.c(0).act('draw_card');
    await g.waitFor(() => g.p(0).hasDrawnThisTurn, '드로우');
    t.expectEq(g.p(0).hand.malices.map((c) => c.name), [name], '악의 칸');
    t.expectEq(g.handCards(0).length, 1, '패 1장');
    t.expectEq(g.p(0).currentMalice, 1, '악의 1점');
    t.expectEq(g.p(0).alignment, 'GOOD', '악의 1점은 선인');
    await expectClientSync(t, g, 0);
    t.expectEq(g.c(0).state?.myInfo.currentMalice, 1, '본인 화면에도 악의 1점');
  });
}

scenario('짙은 악의: 패에 들고 있으면 1장이지만 악의 2점으로 계산된다', { card: '짙은 악의', rule: R_DEEP }, async (t) => {
  const g = await t.game({ players: 2, deck: ['짙은 악의'] });
  g.c(0).act('draw_card');
  await g.waitFor(() => g.p(0).hasDrawnThisTurn, '드로우');
  t.expectEq(g.p(0).hand.malices.length, 1, '악의 칸 1장');
  t.expectEq(g.p(0).currentMalice, 2, '악의 2점');
  await expectClientSync(t, g, 0);
});

scenario('누군가의 로켓: 보물 칸에 들어가면서 악의 1점이 더해진다', { card: '누군가의 로켓', rule: R_LOCKET }, async (t) => {
  const g = await t.game({ players: 2, deck: ['누군가의 로켓'] });
  g.c(0).act('draw_card');
  await g.waitFor(() => g.p(0).hasDrawnThisTurn, '드로우');
  t.expectEq(g.p(0).hand.treasures.map((c) => c.name), ['누군가의 로켓'], '보물 칸');
  t.expectEq(g.p(0).hand.malices.length, 0, '악의 칸은 비어 있음');
  t.expectEq(g.p(0).currentMalice, 1, '로켓 = 악의 1점');
  await expectClientSync(t, g, 0);
});

scenario('보물(성배·십자가#502·코인·복권·교환권): 악의 0점이고 보물 칸에 들어간다', { card: '성배', rule: R_USELESS }, async (t) => {
  const g = await t.game({ players: 2, hands: { 0: PLAIN_TREASURES } });
  t.expectEq(g.p(0).hand.treasures.length, 5, '보물 칸 5장');
  t.expectEq(g.p(0).hand.weapons.length, 0, '보물 십자가는 무기 칸이 아님');
  t.expectEq(g.p(0).currentMalice, 0, '보물만으로는 악의 0점');
  t.expectEq(g.p(0).alignment, 'GOOD', '선인');
  await expectClientSync(t, g, 0);
});

scenario('악의 합산: 일반 악의 3장(3점)이면 악인이다', { card: '시선', rule: R_ALIGN }, async (t) => {
  const g = await t.game({ players: 2, hands: { 0: ['시선', '상처', '흑역사'] } });
  t.expectEq(g.p(0).currentMalice, 3, '악의 3점');
  t.expectEq(g.p(0).alignment, 'EVIL', '악의 3점은 악인');
  await expectClientSync(t, g, 0);
});

scenario('짙은 악의: 짙은 악의 + 시선 = 악의 3점이면 악인이다', { card: '짙은 악의', rule: R_DEEP }, async (t) => {
  const g = await t.game({ players: 2, hands: { 0: ['짙은 악의', '시선'] } });
  t.expectEq(g.p(0).currentMalice, 3, '악의 3점');
  t.expectEq(g.p(0).alignment, 'EVIL', '악인');
});

scenario('누군가의 로켓: 로켓 + 시선 + 상처 = 악의 3점이면 악인이다', { card: '누군가의 로켓', rule: R_LOCKET }, async (t) => {
  const g = await t.game({ players: 2, hands: { 0: ['누군가의 로켓', '시선', '상처'] } });
  t.expectEq(g.p(0).currentMalice, 3, '악의 3점');
  t.expectEq(g.p(0).alignment, 'EVIL', '악인');
});

scenario(
  '성향 기준: 악의 2점(시선+상처, 짙은 악의 1장)은 선인이다',
  {
    card: '성향',
    // 2026-10-23 확인: 악인 기준은 3점 이상(constants.ts EVIL_THRESHOLD=3)이 맞고, README의 "2포인트"가 틀린 것.
    rule: '악의 3점 이상이면 악인 (EVIL_THRESHOLD = 3, 확인된 규칙)',
  },
  async (t) => {
    const g = await t.game({ players: 3, hands: { 0: ['시선', '상처', '성정'], 1: ['짙은 악의'] }, dead: [2] });
    t.note(`시선+상처(2점) → 성향=${g.p(0).alignment}, 짙은 악의(2점) → 성향=${g.p(1).alignment}`);
    await attackAndKill(g, 0, 1, '성정');
    await waitGameOver(g, [0]);
    const scores = g.c(0).gameOvers[0];
    t.note(`악의 2점으로 최후의 1인이 된 가람의 정산: ${scoreOf(g, scores, 0)}점 (참가 인원 3, 생존자 1) — ${fmtScores(scores)}`);
    t.expectEq(g.p(0).alignment, 'GOOD', '악의 2점은 선인');
    t.expectEq(g.p(1).alignment, 'GOOD', '짙은 악의 1장(2점)도 선인');
  },
);

// ════════════════════════════════════════════════════════════════════
// 2. 패가 바뀔 때마다 성향 재계산
// ════════════════════════════════════════════════════════════════════

scenario('흑역사: 드로우로 악의 3점이 되는 순간 악인으로 바뀌고 화면에도 반영된다', { card: '흑역사', rule: R_ALIGN }, async (t) => {
  const g = await t.game({ players: 2, hands: { 0: ['시선', '상처'] }, deck: ['흑역사'] });
  t.expectEq(g.p(0).alignment, 'GOOD', '전제: 2점');
  g.c(0).act('draw_card');
  await g.waitFor(() => g.p(0).hasDrawnThisTurn, '드로우');
  t.expectEq(g.p(0).currentMalice, 3, '악의 3점');
  t.expectEq(g.p(0).alignment, 'EVIL', '악인으로 전환');
  await expectClientSync(t, g, 0);
  t.expectEq(g.c(0).state?.myInfo.alignment, 'EVIL', '본인 화면도 악인');
});

scenario('짙은 악의: 선물로 건네면 준 사람은 선인, 받은 사람은 악인으로 다시 계산된다', { card: '짙은 악의', rule: `${R_ALIGN} / [선물] 자신의 패에서 원하는 카드 1장을 골라 다른 생존자에게 선물합니다.` }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['짙은 악의', '상처'], 1: ['시선'] }, deck: ['선물'] });
  t.expectEq([g.p(0).alignment, g.p(1).alignment], ['EVIL', 'GOOD'], '전제');
  await drawEvent(g, 0, '선물');
  await g.waitFor(() => g.requests(0, 'request_target').length > 0, '선물 대상 요청');
  g.c(0).act('submit_gift', g.cardId(0, '짙은 악의'), g.c(1).id);
  await g.waitPhase('MAIN');
  g.check();
  t.expectEq([g.p(0).currentMalice, g.p(0).alignment], [1, 'GOOD'], '준 사람: 1점 선인');
  t.expectEq([g.p(1).currentMalice, g.p(1).alignment], [3, 'EVIL'], '받은 사람: 3점 악인');
  await expectClientSync(t, g, 0);
  await expectClientSync(t, g, 1);
});

scenario('시선: 뒤바뀐 영혼으로 패를 바꾸면 악의·성향도 함께 바뀐다', { card: '시선', rule: `${R_ALIGN} / [뒤바뀐 영혼] 자신의 모든 패와 선택한 생존자의 모든 패를 교환합니다.` }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['시선', '빈상자', '상처'], 1: ['코인'] }, deck: ['뒤바뀐 영혼'] });
  await drawEvent(g, 0, '뒤바뀐 영혼');
  await g.waitFor(() => g.requests(0, 'request_target').length > 0, '대상 요청');
  g.c(0).act('submit_target', g.c(1).id);
  await g.waitPhase('MAIN');
  g.check();
  t.expectEq([g.p(0).currentMalice, g.p(0).alignment], [0, 'GOOD'], '가람: 0점 선인');
  t.expectEq([g.p(1).currentMalice, g.p(1).alignment], [3, 'EVIL'], '나래: 3점 악인');
  await expectClientSync(t, g, 0);
  await expectClientSync(t, g, 1);
});

scenario('짙은 악의: 면죄부로 버리면 1장으로 취급되어 2점이 한 번에 빠지고 선인으로 돌아온다', { card: '짙은 악의', rule: `${R_DEEP} / ${R_INDULGENCE}` }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['짙은 악의', '시선', '코인'] }, deck: ['면죄부'] });
  t.expectEq(g.p(0).alignment, 'EVIL', '전제: 3점 악인');
  await drawEvent(g, 0, '면죄부');
  const deep = g.cardId(0, '짙은 악의');
  const coin = g.cardId(0, '코인');
  g.c(0).act('submit_cards', [coin, deep]);
  g.c(1).act('submit_cards', []);
  g.c(2).act('submit_cards', []);
  await g.waitPhase('MAIN');
  g.check();
  t.expectEq(g.hand(0), ['시선'], '짙은 악의와 코인이 빠지고 시선만 남음');
  t.expectEq([g.p(0).currentMalice, g.p(0).alignment], [1, 'GOOD'], '1점 선인');
  t.expect(inGraveById(g, deep) && inGraveById(g, coin), '버린 카드는 무덤으로');
  await expectClientSync(t, g, 0);
});

scenario('상처: 무소유로 패가 넘어가면 받은 사람의 악의·성향이 다시 계산된다', { card: '상처', rule: `${R_ALIGN} / [무소유] 모든 생존자는 이 카드를 뽑은 자의 패를 순서대로 1장씩 뒷면으로 뽑아갑니다.` }, async (t) => {
  const g = await t.game({ players: 2, hands: { 0: ['시선', '상처', '흑역사'] }, deck: ['무소유'] });
  await drawEvent(g, 0, '무소유');
  await g.waitFor(() => g.handCards(1).length === 3, '무소유 분배', 3000);
  await g.waitPhase('MAIN');
  g.check();
  t.expectEq([g.p(0).currentMalice, g.p(0).alignment], [0, 'GOOD'], '가람: 0점 선인');
  t.expectEq([g.p(1).currentMalice, g.p(1).alignment], [3, 'EVIL'], '나래: 3점 악인');
  await expectClientSync(t, g, 1);
});

scenario('코즈믹 호러: 스캐빈져로 사망자의 악의를 가져오면 악인으로 다시 계산된다', { card: '코즈믹 호러', rule: `${R_ALIGN} / [스캐빈져] 다른 생존자가 죽을 때 그자의 패를 모두 가져옵니다.` }, async (t) => {
  const g = await t.game({
    players: 3,
    turn: 2,
    hands: { 0: ['스캐빈져'], 1: ['코즈믹 호러', '어제의 동료', '계시'], 2: ['성정'] },
  });
  await attackAndKill(g, 2, 1, '성정');
  await g.waitPhase('MAIN');
  g.check();
  t.expectEq(sorted(g.hand(0)), sorted(['코즈믹 호러', '어제의 동료', '계시']), '가람이 유품을 가져감');
  t.expectEq([g.p(0).currentMalice, g.p(0).alignment], [3, 'EVIL'], '가람: 3점 악인');
  await expectClientSync(t, g, 0);
});

scenario('사랑이란 변명: 카르마가 악의로 들어오면 3점이 되어 악인으로 바뀐다', { card: '사랑이란 변명', rule: `${R_ALIGN} / [카르마] 이 카드를 패에 넣는 순간 악의가 됩니다.` }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['사랑이란 변명', '암전'] }, dead: [2], deck: ['카르마'] });
  await drawEvent(g, 0, '카르마');
  await g.waitFor(() => g.requests(2, 'request_target').length > 0, '망자에게 대상 요청');
  g.c(2).act('submit_target', g.c(1).id);
  await g.waitPhase('MAIN');
  g.check();
  t.expectEq([g.p(1).currentMalice, g.p(1).alignment], [3, 'EVIL'], '나래: 3점 악인');
  await expectClientSync(t, g, 1);
});

scenario('탐욕: 마육검 입찰 후 돌려받은 악의로 성향이 원래대로 계산된다', { card: '탐욕', rule: `${R_ALIGN} / [마육검] 이 검을 얻고 싶은 생존자들은 동시에 악의를 공개합니다.` }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['탐욕', '질투', '암전'] }, deck: ['마육검'] });
  await drawEvent(g, 0, '마육검');
  await g.waitFor(() => pa(g)?.eventName === '마육검' && pa(g)?.type === 'CARD_SUBMISSION', '입찰 시작');
  g.c(0).act('submit_cards', g.handCards(0).map((c) => c.id));
  await g.settle();
  t.note(`입찰(공개) 중 가람의 서버 악의=${g.p(0).currentMalice}, 성향=${g.p(0).alignment}, 패 ${g.handCards(0).length}장 (공개만 했는데 패에서 빠짐)`);
  g.c(1).act('submit_cards', []);
  g.c(2).act('submit_cards', []);
  await g.waitFor(() => g.requests(0, 'request_mayuk_choice').length > 0, '마육검 낙찰');
  g.c(0).act('store_mayuk_sword');
  await g.waitPhase('MAIN');
  g.check();
  t.expectEq(sorted(g.p(0).hand.malices.map((c) => c.name)), sorted(['탐욕', '질투', '암전']), '입찰한 악의는 돌려받음');
  t.expectEq([g.p(0).currentMalice, g.p(0).alignment], [3, 'EVIL'], '3점 악인');
  await expectClientSync(t, g, 0);
});

scenario('질투: 룰렛으로 악의가 오가도 양쪽 악의·성향이 패와 일치한다', { card: '질투', rule: `${R_ALIGN} / [룰렛] 낸 카드를 섞어 1장씩 다시 나눠갖고…` }, async (t) => {
  const g = await t.game({ players: 2, hands: { 0: ['질투', '시선', '상처'], 1: ['코인'] }, deck: ['룰렛'] });
  await drawEvent(g, 0, '룰렛');
  await g.waitFor(() => pa(g)?.eventName === '룰렛', '룰렛 제출 시작');
  g.c(0).act('submit_cards', [g.cardId(0, '질투')]);
  g.c(1).act('submit_cards', [g.cardId(1, '코인')]);
  await g.waitPhase('MAIN');
  g.check();
  const total = g.p(0).currentMalice + g.p(1).currentMalice;
  t.expectEq(total, 3, '두 사람 악의 합은 그대로 3점');
  for (const i of [0, 1]) {
    t.expectEq(g.p(i).currentMalice, expectedMalice(g.p(i)), `${g.c(i).name} 악의 = 패 기준`);
    t.expectEq(g.p(i).alignment, g.p(i).currentMalice >= 3 ? 'EVIL' : 'GOOD', `${g.c(i).name} 성향`);
    await expectClientSync(t, g, i);
  }
});

scenario(
  '누군가의 로켓: 교화의 창으로 모든 악의를 버릴 때 로켓도 버려지는가',
  {
    card: '누군가의 로켓',
    rule: `[교화의 창] 이 창으로 다른 생존자를 죽이는 것에 성공하면 자신의 모든 악의를 버립니다. / ${R_LOCKET}`,
    ambiguous:
      '교화의 창의 "자신의 모든 악의를 버립니다"에 악의인 동시에 보물인 누군가의 로켓도 포함됩니까? (현재는 악의 칸만 비우고 로켓은 남아 악의 1점이 유지됨)',
  },
  async (t) => {
    const g = await t.game({ players: 3, hands: { 0: ['교화의 창', '시선', '누군가의 로켓'] } });
    await attackAndKill(g, 0, 1, '교화의 창');
    await g.waitPhase('MAIN');
    g.check();
    t.note(`교화의 창 성공 후 가람 패: [${g.hand(0).join(', ')}], 악의 ${g.p(0).currentMalice}점, 성향 ${g.p(0).alignment}`);
    t.expect(!g.hand(0).includes('누군가의 로켓'), '로켓도 악의로 버려짐');
  },
);

// ════════════════════════════════════════════════════════════════════
// 3. 보물 카드
// ════════════════════════════════════════════════════════════════════

for (const tr of [...PLAIN_TREASURES, '누군가의 로켓']) {
  scenario(`${tr}: 무기처럼 사용(play_tool)해도 아무 일도 일어나지 않고 패에 남는다`, { card: tr, rule: R_USELESS }, async (t) => {
    const g = await t.game({ players: 3, hands: { 0: [tr] } });
    const id = g.cardId(0, tr);
    g.c(0).act('play_tool', id, g.c(1).id);
    await g.settle();
    t.expectEq(g.room.phase, 'MAIN', '공격 단계로 넘어가지 않음');
    t.expect(g.handCards(0).some((c) => c.id === id), '보물은 패에 그대로');
    t.expect(g.p(1).isAlive, '대상은 살아 있음');
    t.expectEq(g.room.graveyard.length, 0, '무덤에 아무것도 가지 않음');
    t.expectEq(g.p(0).hasUsedWeaponThisTurn, false, '무기 사용 횟수를 소모하지 않음');
  });
}

scenario('십자가#502: 보물 십자가로는 공격할 수 없고 무기 십자가(#201)로만 공격된다', { card: '십자가#502', rule: `[십자가#502 보물] ${R_USELESS} / [십자가#201 무기] 자신의 차례 중 언제든지 다른 생존자를 1회 공격할 수 있으며, 사용 후 버려야 합니다.` }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['십자가#502', '십자가#201'] } });
  const treasure = g.cardId(0, '십자가#502');
  const weapon = g.cardId(0, '십자가#201');
  g.c(0).act('play_tool', treasure, g.c(1).id);
  await g.settle();
  t.expectEq(g.room.phase, 'MAIN', '보물 십자가로는 공격이 시작되지 않음');
  t.expect(g.p(0).hand.treasures.some((c) => c.id === treasure), '보물 십자가는 보물 칸에 남음');
  g.c(0).act('play_tool', weapon, g.c(1).id);
  await g.waitPhase('WAITING_FOR_DEFENSE');
  t.expect(g.p(0).hand.treasures.some((c) => c.id === treasure), '무기 십자가를 써도 보물 십자가는 남음');
  t.expect(inGraveById(g, weapon), '무기 십자가만 무덤으로');
});

scenario('코인: 방어 단계에서 보물을 방패로 낼 수 없다', { card: '코인', rule: R_USELESS }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정'], 1: ['코인', '교환권'] } });
  g.c(0).act('play_tool', g.cardId(0, '성정'), g.c(1).id);
  await g.waitPhase('WAITING_FOR_DEFENSE');
  g.c(1).act('play_shield', g.cardId(1, '코인'));
  g.c(1).act('play_shield', g.cardId(1, '교환권'));
  await g.settle();
  t.expectEq(g.room.phase, 'WAITING_FOR_DEFENSE', '보물로는 방어되지 않음');
  t.expectEq(sorted(g.hand(1)), sorted(['코인', '교환권']), '보물은 패에 그대로');
  g.c(1).act('skip_defense');
  await g.waitFor(() => !g.p(1).isAlive, '방어 포기 → 사망');
});

const INDULGENCE_PAIRS: Array<[string, string]> = [
  ['성배', '시선'],
  ['십자가#502', '빈상자'],
  ['코인', '상처'],
  ['복권', '코즈믹 호러'],
  ['교환권', '흑역사'],
];
for (const [tr, mal] of INDULGENCE_PAIRS) {
  scenario(`${tr}: 면죄부에서 보물로 내고 악의(${mal}) 1장을 버릴 수 있다`, { card: tr, rule: `${R_USELESS} / ${R_INDULGENCE}` }, async (t) => {
    const g = await t.game({ players: 3, hands: { 0: [tr, mal, '계시'] }, deck: ['면죄부'] });
    await drawEvent(g, 0, '면죄부');
    await g.waitFor(() => g.requests(0, 'request_cards').length > 0, '면죄부 제출 요청');
    const trId = g.cardId(0, tr);
    const malId = g.cardId(0, mal);
    g.c(0).act('submit_cards', [trId, malId]);
    g.c(1).act('submit_cards', []);
    g.c(2).act('submit_cards', []);
    await g.waitPhase('MAIN');
    g.check();
    t.expectEq(g.hand(0), ['계시'], '보물과 악의가 빠지고 계시만 남음');
    t.expectEq(g.p(0).currentMalice, 1, '악의 2점 → 1점');
    t.expect(inGraveById(g, trId) && inGraveById(g, malId), '버린 두 장은 무덤으로');
    t.expectEq(g.p(0).hasDrawnThisTurn, false, '이벤트 후 다시 뽑아야 함');
  });
}

scenario('누군가의 로켓: 면죄부에서 보물로 내고 다른 악의를 버릴 수 있다', { card: '누군가의 로켓', rule: `${R_LOCKET} / ${R_INDULGENCE}` }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['누군가의 로켓', '어제의 동료'] }, deck: ['면죄부'] });
  await drawEvent(g, 0, '면죄부');
  g.c(0).act('submit_cards', [g.cardId(0, '누군가의 로켓'), g.cardId(0, '어제의 동료')]);
  g.c(1).act('submit_cards', []);
  g.c(2).act('submit_cards', []);
  await g.waitPhase('MAIN');
  g.check();
  t.expectEq(g.hand(0), [], '두 장 모두 버려짐');
  t.expectEq(g.p(0).currentMalice, 0, '악의 0점');
});

scenario('누군가의 로켓: 면죄부에서 다른 보물과 함께 악의로 버릴 수 있다', { card: '누군가의 로켓', rule: `${R_LOCKET} / ${R_INDULGENCE}` }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['코인', '누군가의 로켓'] }, deck: ['면죄부'] });
  await drawEvent(g, 0, '면죄부');
  g.c(0).act('submit_cards', [g.cardId(0, '코인'), g.cardId(0, '누군가의 로켓')]);
  g.c(1).act('submit_cards', []);
  g.c(2).act('submit_cards', []);
  await g.waitPhase('MAIN');
  g.check();
  t.expectEq(g.hand(0), [], '코인(보물) + 로켓(악의) 모두 버려짐');
  t.expectEq(g.p(0).currentMalice, 0, '악의 0점');
});

scenario('누군가의 로켓: 면죄부에 로켓 단독(보물+악의 1장 취급)으로는 낼 수 없다', { card: '누군가의 로켓', rule: R_LOCKET }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['누군가의 로켓'], 1: ['누군가의 로켓'] }, deck: ['면죄부'] });
  await drawEvent(g, 0, '면죄부');
  const a = g.cardId(0, '누군가의 로켓');
  const b = g.cardId(1, '누군가의 로켓');
  g.c(0).act('submit_cards', [a]); // 1장만
  g.c(1).act('submit_cards', [b, b]); // 같은 카드를 두 번
  g.c(2).act('submit_cards', []);
  await g.waitPhase('MAIN');
  g.check();
  t.expectEq(g.hand(0), ['누군가의 로켓'], '1장 제출은 거부');
  t.expectEq(g.hand(1), ['누군가의 로켓'], '같은 로켓 2번 제출도 거부');
  t.expectEq([g.p(0).currentMalice, g.p(1).currentMalice], [1, 1], '악의 그대로');
});

scenario('십자가#201: 무기 십자가는 면죄부의 보물로 낼 수 없다', { card: '십자가#502', rule: `${R_INDULGENCE} (보물이 필요)` }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['십자가#201', '시선'] }, deck: ['면죄부'] });
  await drawEvent(g, 0, '면죄부');
  g.c(0).act('submit_cards', [g.cardId(0, '십자가#201'), g.cardId(0, '시선')]);
  g.c(1).act('submit_cards', []);
  g.c(2).act('submit_cards', []);
  await g.waitPhase('MAIN');
  t.expectEq(sorted(g.hand(0)), sorted(['십자가', '시선']), '무기 십자가와 시선이 그대로');
  t.expectEq(g.p(0).hand.weapons.length, 1, '무기 칸 그대로');
  t.expectEq(g.p(0).currentMalice, 1, '악의 그대로');
});

scenario('십자가#502: 보물 십자가는 무장해제의 무기로 낼 수 없다', { card: '십자가#502', rule: `${R_DISARM} (무기가 필요)` }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['십자가#502', '시선'] }, deck: ['무장해제'] });
  await drawEvent(g, 0, '무장해제');
  g.c(0).act('submit_cards', [g.cardId(0, '십자가#502'), g.cardId(0, '시선')]);
  g.c(1).act('submit_cards', []);
  g.c(2).act('submit_cards', []);
  await g.waitPhase('MAIN');
  t.expectEq(g.p(0).hand.treasures.length, 1, '보물 십자가 그대로');
  t.expectEq(g.p(0).currentMalice, 1, '악의 그대로');
});

scenario('누군가의 로켓: 무장해제에서 무기와 함께 악의로 버릴 수 있다', { card: '누군가의 로켓', rule: `${R_LOCKET} / ${R_DISARM}` }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정', '누군가의 로켓'] }, deck: ['무장해제'] });
  await drawEvent(g, 0, '무장해제');
  g.c(0).act('submit_cards', [g.cardId(0, '성정'), g.cardId(0, '누군가의 로켓')]);
  g.c(1).act('submit_cards', []);
  g.c(2).act('submit_cards', []);
  await g.waitPhase('MAIN');
  g.check();
  t.expectEq(g.hand(0), [], '성정 + 로켓 모두 버려짐');
  t.expectEq(g.p(0).currentMalice, 0, '악의 0점');
});

scenario('짙은 악의: 무장해제로 버릴 때도 1장으로 취급되어 2점이 빠진다', { card: '짙은 악의', rule: `${R_DEEP} / ${R_DISARM}` }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['황금칼', '짙은 악의', '계시'] }, deck: ['무장해제'] });
  await drawEvent(g, 0, '무장해제');
  g.c(0).act('submit_cards', [g.cardId(0, '황금칼'), g.cardId(0, '짙은 악의')]);
  g.c(1).act('submit_cards', []);
  g.c(2).act('submit_cards', []);
  await g.waitPhase('MAIN');
  g.check();
  t.expectEq(g.hand(0), ['계시'], '계시만 남음');
  t.expectEq(g.p(0).currentMalice, 1, '3점 → 1점');
});

scenario('성배: 면죄부는 1회만 가능해 두 번째 제출은 무시된다', { card: '성배', rule: R_INDULGENCE }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성배', '코인', '시선', '상처'] }, deck: ['면죄부'] });
  await drawEvent(g, 0, '면죄부');
  g.c(0).act('submit_cards', [g.cardId(0, '성배'), g.cardId(0, '시선')]);
  await g.settle();
  g.c(0).act('submit_cards', [g.cardId(0, '코인'), g.cardId(0, '상처')]);
  await g.settle();
  g.c(1).act('submit_cards', []);
  g.c(2).act('submit_cards', []);
  await g.waitPhase('MAIN');
  t.expectEq(sorted(g.hand(0)), sorted(['코인', '상처']), '두 번째 제출은 무시');
  t.expectEq(g.p(0).currentMalice, 1, '악의 1점만 빠짐');
});

scenario('코인: 죽은 플레이어는 면죄부에 참여할 수 없다', { card: '코인', rule: `${R_INDULGENCE} (원하는 "생존자")` }, async (t) => {
  const g = await t.game({ players: 3, hands: { 2: ['코인', '시선'] }, dead: [2], deck: ['면죄부'] });
  await drawEvent(g, 0, '면죄부');
  g.c(2).act('submit_cards', [g.cardId(2, '코인'), g.cardId(2, '시선')]);
  g.c(0).act('submit_cards', []);
  g.c(1).act('submit_cards', []);
  await g.waitPhase('MAIN');
  t.expectEq(sorted(g.hand(2)), sorted(['코인', '시선']), '사망자 패는 그대로');
});

scenario('코인: 남의 패에 있는 보물 id로는 면죄부를 쓸 수 없다', { card: '코인', rule: `${R_INDULGENCE} ("자신의 패에서")` }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['시선'], 1: ['코인'] }, deck: ['면죄부'] });
  await drawEvent(g, 0, '면죄부');
  g.c(0).act('submit_cards', [g.cardId(1, '코인'), g.cardId(0, '시선')]);
  g.c(1).act('submit_cards', []);
  g.c(2).act('submit_cards', []);
  await g.waitPhase('MAIN');
  t.expectEq(g.hand(0), ['시선'], '가람의 시선 그대로');
  t.expectEq(g.hand(1), ['코인'], '나래의 코인 그대로');
});

scenario('코인: 이벤트가 없을 때 submit_cards로 보물·악의를 버릴 수 없다', { card: '코인', rule: R_INDULGENCE }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['코인', '시선'] } });
  g.c(0).act('submit_cards', [g.cardId(0, '코인'), g.cardId(0, '시선')]);
  await g.settle();
  t.expectEq(sorted(g.hand(0)), sorted(['코인', '시선']), '패 그대로');
  t.expectEq(g.room.phase, 'MAIN', '단계 그대로');
});

scenario('누군가의 로켓: 제물에 악의를 제외한 카드로 낼 수 있다', { card: '누군가의 로켓', rule: `${R_LOCKET} / ${R_SAC}` }, async (t) => {
  const g = await t.game({ players: 2, hands: { 0: ['누군가의 로켓'], 1: ['코인'] }, deck: ['제물'] });
  await drawEvent(g, 0, '제물');
  await g.waitFor(() => pa(g)?.eventName === '제물', '제물 제출 시작');
  const locket = g.cardId(0, '누군가의 로켓');
  g.c(0).act('submit_cards', [locket]);
  g.c(1).act('submit_cards', [g.cardId(1, '코인')]);
  await g.waitPhase('MAIN');
  g.check();
  t.expect(inGraveById(g, locket), '로켓이 제물로 바쳐져 무덤으로');
  t.expectEq(g.p(0).currentMalice, 0, '로켓의 악의도 함께 사라짐');
  t.expect(g.p(0).isAlive && g.p(1).isAlive, '제물 성공으로 아무도 죽지 않음');
});

scenario('시선: 악의 카드는 제물로 바칠 수 없다', { card: '시선', rule: R_SAC }, async (t) => {
  const g = await t.game({ players: 2, hands: { 0: ['시선', '코인'], 1: ['코인'] }, deck: ['제물'] });
  await drawEvent(g, 0, '제물');
  await g.waitFor(() => pa(g)?.eventName === '제물', '제물 제출 시작');
  const sight = g.cardId(0, '시선');
  g.c(0).act('submit_cards', [sight]);
  await g.settle();
  const stillInHand = g.handCards(0).some((c) => c.id === sight);
  t.note(`시선 제출 직후: 가람 패 [${g.hand(0).join(', ')}], 악의 ${g.p(0).currentMalice}점, 제출 대기 ${JSON.stringify((pa(g)?.responses?.[g.c(0).id] ?? []).map((c: any) => c.name))}`);
  g.c(1).act('submit_cards', [g.cardId(1, '코인')]);
  await g.waitFor(() => g.room.phase === 'MAIN' || pa(g)?.type === 'VOTE', '제물 판정');
  t.note(`제물 판정 후: 단계 ${g.room.phase}, 무덤 [${g.room.graveyard.map((c) => c.name).join(', ')}]`);
  t.expect(stillInHand, '악의(시선)는 제물로 받아들여지지 않고 패에 남아야 함');
});

scenario('누군가의 로켓: 로켓을 가진 채로는 엑스칼리버를 얻을 수 없다', { card: '누군가의 로켓', rule: `${R_LOCKET} / [엑스칼리버] 악의가 0장인 채로 가장 빠르게 자신의 모든 패를 공개해야 합니다.` }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['누군가의 로켓'] }, deck: ['엑스칼리버'] });
  await drawEvent(g, 0, '엑스칼리버');
  await g.waitFor(() => g.requests(0, 'request_excalibur').length > 0, '엑스칼리버 요청');
  g.c(0).act('claim_excalibur');
  await g.settle();
  t.expect(!g.p(0).hand.weapons.some((w) => w.name === '엑스칼리버'), '로켓(악의) 보유자는 획득 불가');
  [0, 1, 2].forEach((i) => g.c(i).act('skip_excalibur'));
  await g.waitPhase('MAIN');
  t.expectEq(g.hand(0), ['누군가의 로켓'], '로켓은 그대로');
});

scenario('누군가의 로켓: 선의로 악의 점수가 0이어도 로켓(악의 1장)을 가진 채로는 엑스칼리버를 얻을 수 없다', { card: '누군가의 로켓', rule: `${R_LOCKET} / [엑스칼리버] 악의가 0장인 채로 가장 빠르게 자신의 모든 패를 공개해야 합니다. / [선의] (단, 이 카드만으로 악의 판정을 유리하게 우회하여 이벤트를 회피할 수는 없음)` }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['누군가의 로켓', '선의'] }, deck: ['엑스칼리버'] });
  t.expectEq(g.p(0).currentMalice, 0, '전제: 로켓 1 + 선의 -1 = 악의 0점');
  await drawEvent(g, 0, '엑스칼리버');
  await g.waitFor(() => g.requests(0, 'request_excalibur').length > 0, '엑스칼리버 요청');
  g.c(0).act('claim_excalibur');
  await g.settle();
  const got = g.p(0).hand.weapons.some((w) => w.name === '엑스칼리버');
  t.note(`로켓+선의 보유 가람의 claim_excalibur 결과: 엑스칼리버 획득=${got}, 단계=${g.room.phase}`);
  if (g.room.phase === 'RESOLVING_EVENT') [0, 1, 2].forEach((i) => g.c(i).act('skip_excalibur'));
  await g.waitPhase('MAIN');
  t.expect(!got, '로켓(악의 1장)이 패에 있으므로 엑스칼리버를 얻을 수 없어야 함');
});

scenario('성배: 면죄부에 보물 없이 악의 2장, 악의 없이 보물 2장은 낼 수 없다', { card: '성배', rule: R_INDULGENCE }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['시선', '상처'], 1: ['성배', '코인'] }, deck: ['면죄부'] });
  await drawEvent(g, 0, '면죄부');
  g.c(0).act('submit_cards', [g.cardId(0, '시선'), g.cardId(0, '상처')]);
  g.c(1).act('submit_cards', [g.cardId(1, '성배'), g.cardId(1, '코인')]);
  g.c(2).act('submit_cards', []);
  await g.waitPhase('MAIN');
  t.expectEq(sorted(g.hand(0)), sorted(['시선', '상처']), '악의 2장은 그대로');
  t.expectEq(sorted(g.hand(1)), sorted(['성배', '코인']), '보물 2장은 그대로');
});

scenario('누군가의 로켓: 천사의 심판대에서 악의 1장으로 판정되어 죽는다', { card: '누군가의 로켓', rule: `${R_LOCKET} / [천사의 심판대] 그 중 악의가 1장이라도 있다면 그자는 죽게 됩니다.` }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['누군가의 로켓'] }, deck: ['천사의 심판대'] });
  await drawEvent(g, 0, '천사의 심판대');
  await g.waitFor(() => pa(g)?.type === 'VOTE', '투표 시작');
  [0, 1, 2].forEach((i) => g.c(i).act('submit_vote', g.c(1).id));
  await waitReveal(g);
  confirmAllAlive(g);
  await g.waitPhase('MAIN');
  t.expect(!g.p(1).isAlive, '로켓만 가진 나래는 사망');
});

// ════════════════════════════════════════════════════════════════════
// 4. 짙은 악의 — 이벤트 판정에서의 장수
// ════════════════════════════════════════════════════════════════════

scenario('짙은 악의: 악마의 고해소에서 패에 든 짙은 악의는 2장으로 세어 살아남는다', { card: '짙은 악의', rule: `${R_DEEP} / [악마의 고해소] 그 중 악의가 1장 이하라면 그자는 죽게 됩니다.` }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['짙은 악의'] }, deck: ['악마의 고해소'] });
  await drawEvent(g, 0, '악마의 고해소');
  await g.waitFor(() => pa(g)?.type === 'VOTE', '투표 시작');
  [0, 1, 2].forEach((i) => g.c(i).act('submit_vote', g.c(1).id));
  await waitReveal(g);
  confirmAllAlive(g);
  await g.waitPhase('MAIN');
  t.expect(g.p(1).isAlive, '짙은 악의(2장) 보유자는 살아남음');
});

scenario('짙은 악의: 선택(惡)에서 짙은 악의만 가진 대상은 악의 2장으로 판정되어 뽑은 자가 산다', { card: '짙은 악의', rule: `${R_DEEP} / [선택 (惡)] 그중 악의가 1장 이하라면 이 카드를 뽑은 자는 죽습니다.` }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['짙은 악의'] }, deck: ['선택 (惡)'] });
  await drawEvent(g, 0, '선택 (惡)');
  await g.waitFor(() => g.requests(0, 'request_target').length > 0, '대상 요청');
  g.c(0).act('submit_target', g.c(1).id);
  await waitReveal(g);
  confirmAllAlive(g);
  await g.waitPhase('MAIN');
  t.expect(g.p(0).isAlive, '뽑은 자는 살아남음');
});

scenario(
  '짙은 악의: 고해성사의 "악의 3장 공개"에 짙은 악의를 2장으로 세는가',
  {
    card: '짙은 악의',
    rule: `${R_DEEP} / [고해성사] 자신의 패에서 악의 3장을 공개하면 자신의 악의 1장을 버릴 수 있습니다.`,
    ambiguous:
      '짙은 악의 + 시선(카드 2장, 악의 3점)을 가진 생존자는 고해성사의 "악의 3장 공개" 조건을 만족합니까? 공개는 패에 든 상태이므로 2장으로 셀 수도, "카드를 낼 때"로 보아 1장으로 셀 수도 있습니다. (서버는 악마의 고해소/선택에서는 짙은 악의를 2장으로 세지만 고해성사에서는 1장으로 셉니다)',
  },
  async (t) => {
    const g = await t.game({ players: 3, hands: { 0: ['짙은 악의', '시선'] }, deck: ['고해성사'] });
    await drawEvent(g, 0, '고해성사');
    await g.waitPhase('MAIN');
    t.note(`고해성사 후 가람 패: [${g.hand(0).join(', ')}], 악의 ${g.p(0).currentMalice}점`);
    t.expectEq(g.p(0).hand.malices.length, 1, '2장으로 센다면 악의 1장을 버림');
  },
);

scenario(
  '짙은 악의: 마육검 입찰에서 짙은 악의 1장을 몇 장으로 세는가',
  {
    card: '짙은 악의',
    rule: `${R_DEEP} / [마육검] 악의를 가장 많이 공개한 생존자가 검의 주인이 됩니다.`,
    ambiguous:
      '마육검 입찰에서 짙은 악의 1장은 악의 1장(카드를 낼 때 1장 취급)입니까, 2장(악의 2점)입니까? 가람이 짙은 악의 1장을 먼저, 나래가 시선+상처 2장을 나중에 내면 누가 낙찰됩니까? (현재: 2점으로 세어 동점 → 먼저 낸 가람 낙찰)',
  },
  async (t) => {
    const g = await t.game({ players: 3, turn: 2, hands: { 0: ['짙은 악의'], 1: ['시선', '상처'] }, deck: ['마육검'] });
    await drawEvent(g, 2, '마육검');
    await g.waitFor(() => pa(g)?.eventName === '마육검', '입찰 시작');
    g.c(0).act('submit_cards', [g.cardId(0, '짙은 악의')]);
    await g.settle();
    await t.sleep(20);
    g.c(1).act('submit_cards', [g.cardId(1, '시선'), g.cardId(1, '상처')]);
    await g.settle();
    g.c(2).act('submit_cards', []);
    await g.waitFor(() => pa(g)?.type === 'TARGET_SELECTION', '낙찰');
    const winner = g.indexOf(pa(g).initiatorId);
    t.note(`낙찰자: ${g.c(winner).name} (가람=짙은 악의 1장 먼저, 나래=시선+상처 2장 나중)`);
    g.c(winner).act('store_mayuk_sword');
    await g.waitPhase('MAIN');
    t.expectEq(winner, 1, '1장 취급이라면 2장을 낸 나래가 낙찰');
  },
);

// ════════════════════════════════════════════════════════════════════
// 5. 악의 카드 — 잘못된 사용
// ════════════════════════════════════════════════════════════════════

scenario('시선: 악의 카드 12종은 무기·아이템·끼어들기로 사용할 수 없다', { card: '시선', rule: R_MALICE }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ALL_MALICE } });
  for (const c of g.handCards(0)) {
    g.c(0).act('play_tool', c.id, g.c(1).id);
    g.c(0).act('play_item', c.id, [g.c(1).id, g.c(2).id]);
    g.c(0).act('interrupt_action', c.id, g.c(1).id);
  }
  await g.settle();
  t.expectEq(g.room.phase, 'MAIN', '단계 그대로');
  t.expectEq(g.handCards(0).length, 12, '악의 12장 그대로');
  t.expectEq(g.p(0).currentMalice, 13, '악의 13점(짙은 악의 2점)');
  t.expect(g.p(1).isAlive && g.p(2).isAlive, '아무도 다치지 않음');
  t.expectEq(g.room.graveyard.length, 0, '무덤 비어 있음');
  t.expectEq(g.room.linkedPlayers, null, '인연이 생기지 않음');
});

scenario('상처: 방어 단계에서 악의 카드를 방패로 낼 수 없다', { card: '상처', rule: R_MALICE }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정'], 1: ['상처', '짙은 악의'] } });
  g.c(0).act('play_tool', g.cardId(0, '성정'), g.c(1).id);
  await g.waitPhase('WAITING_FOR_DEFENSE');
  g.c(1).act('play_shield', g.cardId(1, '상처'));
  g.c(1).act('play_shield', g.cardId(1, '짙은 악의'));
  await g.settle();
  t.expectEq(g.room.phase, 'WAITING_FOR_DEFENSE', '방어되지 않음');
  t.expectEq(g.p(1).hand.malices.length, 2, '악의 그대로');
});

scenario('계시: 이벤트와 무관한 카드 제출(예언 중 submit_cards)로 악의를 없앨 수 없다', { card: '계시', rule: `${R_INDULGENCE} / ${R_DISARM} — 악의는 정해진 이벤트로만 버릴 수 있음. [예언] 이 카드를 뽑은 자는 카드를 참가자 수만큼 뽑아 미리 봅니다.` }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['계시', '시선', '상처'] }, deck: ['예언'] });
  t.expectEq(g.p(1).alignment, 'EVIL', '전제: 나래 악인');
  await drawEvent(g, 0, '예언');
  await g.waitFor(() => g.requests(0, 'request_prophecy').length > 0, '예언 요청');
  g.c(1).act('submit_cards', [g.cardId(1, '계시')]);
  await g.settle();
  const mid = g.hand(1);
  g.c(0).act('submit_prophecy', []);
  await g.waitPhase('MAIN');
  g.check();
  t.note(`예언 중 계시 제출 직후 나래 패: [${mid.join(', ')}] / 예언 종료 후: [${g.hand(1).join(', ')}], 악의 ${g.p(1).currentMalice}점, 성향 ${g.p(1).alignment}, 무덤: [${g.room.graveyard.map((c) => c.name).join(', ')}]`);
  t.expect(g.hand(1).includes('계시'), '계시는 패에 남아 있어야 함');
  t.expectEq(g.p(1).alignment, 'EVIL', '악인 그대로');
});

scenario('시선: 다른 플레이어에게 내 패의 악의 장수가 전달되지 않는다', { card: '시선', rule: '[룰렛] 자신의 패에서 원하는 카드를 1장씩 뒤집어서 냅니다 … 무기를 뽑게 된 것은 생존자가 카드를 확인 후 직접 말하여 공개해야 합니다. / [선택 (善)] 생존자 중 한 명을 선택해 카드를 전부 공개시킵니다. — 패의 종류는 비공개 정보' }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['시선', '상처', '코인'] } });
  await g.settle();
  const view = g.c(1).state!.players.find((p) => p.id === g.c(0).id)!;
  const hc: any = view.handCount;
  t.note(`나래가 받은 game_state_update의 가람 handCount: ${JSON.stringify(hc)}`);
  t.expect(!(typeof hc?.malices === 'number' && hc.malices > 0), `나래에게 가람의 악의 장수(${hc?.malices})가 그대로 전달됨`);
});

// ════════════════════════════════════════════════════════════════════
// 6. 게임 종료 & 정산
// ════════════════════════════════════════════════════════════════════

scenario('정산(최후의 1인·악인): 참가 인원(사망자 포함)만큼 승점, game_over는 모두에게 한 번', { card: '정산', rule: R_SCORE }, async (t) => {
  const g = await t.game({ players: 4, hands: { 0: ['시선', '상처', '흑역사', '성정'] }, dead: [2, 3] });
  t.expectEq(g.p(0).alignment, 'EVIL', '전제: 악인');
  await attackAndKill(g, 0, 1, '성정');
  await waitGameOver(g, [0, 1, 2, 3]);
  t.expectEq(g.room.phase, 'ENDED', '게임 종료');
  for (const i of [0, 1, 2, 3]) t.expectEq(g.c(i).gameOvers.length, 1, `${g.c(i).name}에게 game_over 1회`);
  const scores = g.c(0).gameOvers[0];
  t.expectEq(sorted(scores.map((s) => s.playerId)), sorted(g.clients.map((c) => c.id)), '점수표에 4명 모두 한 번씩');
  t.expectEq(scoreOf(g, scores, 0), 4, '악인 최후 1인 = 참가 인원 4점');
  t.expectEq([scoreOf(g, scores, 1), scoreOf(g, scores, 2), scoreOf(g, scores, 3)], [0, 0, 0], '사망자 0점');
});

scenario('복권: 악인 최후 1인은 복권·교환권 보너스를 받지 않는다', { card: '복권', rule: `${R_LOTTERY} / ${R_SCORE}` }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['시선', '상처', '흑역사', '복권', '교환권', '성정'] }, dead: [2] });
  await attackAndKill(g, 0, 1, '성정');
  await waitGameOver(g, [0]);
  const scores = g.c(0).gameOvers[0];
  t.expectEq(scoreOf(g, scores, 0), 3, '참가 인원 3점만 (보물 보너스 없음)');
});

scenario('복권: 선인 최후 1인은 생존자 수(1) + 1점', { card: '복권', rule: `${R_LOTTERY} / ${R_SCORE}` }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['복권', '성정'] }, dead: [2] });
  await attackAndKill(g, 0, 1, '성정');
  await waitGameOver(g, [0]);
  t.expectEq(scoreOf(g, g.c(0).gameOvers[0], 0), 2, '1 + 복권 1');
});

scenario('교환권: 선인 최후 1인은 생존자 수(1) + 1점', { card: '교환권', rule: `${R_LOTTERY} / ${R_SCORE}` }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['교환권', '성정'] }, dead: [2] });
  await attackAndKill(g, 0, 1, '성정');
  await waitGameOver(g, [0]);
  t.expectEq(scoreOf(g, g.c(0).gameOvers[0], 0), 2, '1 + 교환권 1');
});

scenario('교환권: 죽은 플레이어는 복권·교환권이 있어도 0점', { card: '교환권', rule: `${R_LOTTERY} / ${R_SCORE}` }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정'], 1: ['복권', '교환권'] }, dead: [2] });
  await attackAndKill(g, 0, 1, '성정');
  await waitGameOver(g, [0, 1]);
  const scores = g.c(0).gameOvers[0];
  t.expectEq(scoreOf(g, scores, 1), 0, '사망자 나래는 0점');
  t.expectEq(scoreOf(g, scores, 0), 1, '선인 최후 1인 가람 1점');
});

scenario('정산(덱 소진): 선인 생존자는 생존자 수만큼, 복권·교환권은 장당 +1, 사망자 0점', { card: '정산', rule: `${R_LOTTERY} / ${R_SCORE}` }, async (t) => {
  const g = await t.game({
    players: 4,
    hands: { 0: ['복권'], 1: ['복권', '교환권'], 3: ['교환권'] },
    dead: [3],
    deck: [],
    filler: 0,
  });
  g.c(0).act('draw_card');
  await waitGameOver(g, [0, 1, 2, 3]);
  t.expectEq(g.room.phase, 'ENDED', '게임 종료');
  for (const i of [0, 1, 2, 3]) t.expectEq(g.c(i).gameOvers.length, 1, `${g.c(i).name}에게 game_over 1회`);
  const scores = g.c(0).gameOvers[0];
  t.expectEq(
    [0, 1, 2, 3].map((i) => scoreOf(g, scores, i)),
    [3 + 1, 3 + 2, 3, 0],
    '가람 3+1, 나래 3+2, 다온 3, 사망자 라온 0',
  );
});

scenario('복권: 덱 소진 시 살아남은 악인은 0점이고 복권 보너스도 없다', { card: '복권', rule: `${R_LOTTERY} / ${R_SCORE}` }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['코인'], 1: ['시선', '상처', '흑역사', '복권'] }, dead: [2], deck: [], filler: 0 });
  g.c(0).act('draw_card');
  await waitGameOver(g, [0, 1, 2]);
  const scores = g.c(0).gameOvers[0];
  t.note(fmtScores(scores));
  t.expectEq(scoreOf(g, scores, 1), 0, '살아남은 악인(최후 1인 아님) 0점');
});

scenario(
  '정산(덱 소진): 선인의 "생존자 수"에 살아남은 악인도 포함되는가',
  {
    card: '정산',
    rule: R_SCORE,
    ambiguous:
      '덱이 소진되어 탈출했을 때 선인 생존자가 받는 "생존자 수" 점수에 살아남은 악인도 포함됩니까? 예: 선인 2명 + 악인 1명 생존 시 선인은 3점입니까, 2점입니까? (현재: 악인 포함 3점)',
  },
  async (t) => {
    const g = await t.game({ players: 4, hands: { 1: ['시선', '상처', '흑역사'] }, dead: [3], deck: [], filler: 0 });
    g.c(0).act('draw_card');
    await waitGameOver(g, [0]);
    const scores = g.c(0).gameOvers[0];
    t.note(`선인 2 + 악인 1 생존: ${fmtScores(scores)}`);
    t.expectEq(scoreOf(g, scores, 0), 3, '생존자 전체(3) 기준');
  },
);

scenario(
  '덱 소진: 마지막 카드를 뽑는 순간 끝나는가, 빈 덱에서 뽑으려 할 때 끝나는가',
  {
    card: '정산',
    rule: '🏰 던전의 끝에 도달했습니다! 탈출 성공! (서버 메시지) — card.json에는 덱 소진 시점 규칙이 없음',
    ambiguous:
      '덱의 마지막 카드(일반 카드)를 뽑으면 그 즉시 탈출(게임 종료)입니까, 아니면 다음 사람이 빈 덱에서 뽑으려 할 때 끝납니까? (현재: 마지막 카드를 뽑아도 게임이 계속되고, 다음 차례 사람이 뽑기를 눌러야 종료됨 — 그 사이 무기 공격 등이 가능)',
  },
  async (t) => {
    const g = await t.game({ players: 2, deck: ['코인'], filler: 0 });
    g.c(0).act('draw_card');
    await g.waitFor(() => g.p(0).hasDrawnThisTurn, '마지막 카드 드로우');
    await g.settle();
    const afterLast = g.room.phase;
    const msgEnd = g.msgs(0).some((m) => m.includes('던전의 끝'));
    t.note(`마지막 카드를 뽑은 직후: 단계=${afterLast}, 덱=${g.room.deck.length}장, 종료 메시지=${msgEnd}, game_over=${g.c(0).gameOvers.length}`);
    g.c(0).act('end_turn');
    await g.waitFor(() => g.room.currentTurnPlayerId === g.c(1).id, '차례 넘김');
    t.note(`차례 종료 후 나래 차례: 단계=${g.room.phase}`);
    g.c(1).act('draw_card');
    await waitGameOver(g, [0, 1]);
    t.note(`나래가 빈 덱에서 뽑으려 하자: 단계=${g.room.phase}, game_over=${g.c(0).gameOvers.length}`);
    t.expectEq(afterLast, 'ENDED', '마지막 카드를 뽑는 순간 종료');
  },
);

scenario('덱 소진: 마지막 카드가 이벤트여도 처리 후 다시 뽑으면 게임이 끝나고 game_over는 한 번', { card: '정산', rule: '덱 소진 시 탈출(게임 종료) / 이벤트 처리 후 뽑은 사람은 다시 뽑음' }, async (t) => {
  const g = await t.game({ players: 2, deck: ['고해성사'], filler: 0 });
  await drawEvent(g, 0, '고해성사');
  await g.waitPhase('MAIN');
  t.expectEq(g.p(0).hasDrawnThisTurn, false, '이벤트 후 다시 뽑아야 함');
  g.c(0).act('draw_card');
  await waitGameOver(g, [0, 1]);
  t.expectEq(g.room.phase, 'ENDED', '종료');
  t.expectEq([g.c(0).gameOvers.length, g.c(1).gameOvers.length], [1, 1], 'game_over 1회씩');
});

scenario('정산(이벤트 사망): 천사의 심판대로 최후 1인이 되어도 game_over는 모두에게 한 번', { card: '정산', rule: R_SCORE }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['시선'] }, dead: [2], deck: ['천사의 심판대'] });
  await drawEvent(g, 0, '천사의 심판대');
  await g.waitFor(() => pa(g)?.type === 'VOTE', '투표 시작');
  g.c(0).act('submit_vote', g.c(1).id);
  g.c(1).act('submit_vote', g.c(1).id);
  await waitReveal(g);
  g.c(0).act('confirm_reveal');
  g.c(1).act('confirm_reveal');
  await waitGameOver(g, [0, 1, 2]);
  await g.waitServerMs(30000);
  await g.settle();
  t.expectEq([0, 1, 2].map((i) => g.c(i).gameOvers.length), [1, 1, 1], 'game_over 1회씩');
  t.expectEq(scoreOf(g, g.c(0).gameOvers[0], 0), 1, '선인 최후 1인 1점');
  t.expectEq(g.room.phase, 'ENDED', '종료 유지');
});

scenario(
  '정산: 중도 퇴장한 플레이어도 "참가 인원"에 포함되는가',
  {
    card: '정산',
    rule: R_SCORE,
    ambiguous:
      '게임 도중 방을 나간 플레이어도 악인 최후 1인 점수의 "참가 인원"에 포함됩니까? (현재: 퇴장자는 players에서 제거되어 4인 게임이 3점으로 계산되고 점수표에서도 빠짐)',
  },
  async (t) => {
    const g = await t.game({ players: 4, hands: { 0: ['시선', '상처', '흑역사', '성정'] }, dead: [2] });
    g.c(3).act('leave_room');
    await g.waitFor(() => g.room.players.length === 3, '라온 퇴장');
    await g.settle();
    await attackAndKill(g, 0, 1, '성정');
    await waitGameOver(g, [0]);
    const scores = g.c(0).gameOvers[0];
    t.note(`4명 시작 → 1명 퇴장 후 악인 최후 1인: ${fmtScores(scores)}`);
    t.expectEq(scoreOf(g, scores, 0), 4, '처음 참가 인원 4명 기준');
  },
);

scenario('게임 종료 후: 뽑기·차례 종료·무기 사용은 모두 무시된다', { card: '정산', rule: '게임 종료(ENDED) 후에는 상태가 바뀌지 않아야 함' }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정'], 1: ['황금칼'] }, deck: [], filler: 0 });
  g.c(0).act('draw_card');
  await waitGameOver(g, [0, 1, 2]);
  g.c(0).act('draw_card');
  g.c(0).act('end_turn');
  g.c(0).act('play_tool', g.cardId(0, '성정'), g.c(1).id);
  g.c(1).act('play_tool', g.cardId(1, '황금칼'), g.c(2).id);
  await g.settle();
  t.expectEq(g.room.phase, 'ENDED', '종료 유지');
  t.expect([0, 1, 2].every((i) => g.p(i).isAlive), '아무도 죽지 않음');
  t.expectEq([g.hand(0), g.hand(1)], [['성정'], ['황금칼']], '무기는 패에 그대로');
  t.expectEq([0, 1, 2].map((i) => g.c(i).gameOvers.length), [1, 1, 1], 'game_over 추가 없음');
});

scenario('게임 종료 후: 난투 중 덱이 소진되어 끝나도 무기 공격으로 결과를 바꿀 수 없다', { card: '정산', rule: `[난투] 지금은 자신의 차례가 아닐지라도 누구나 무기를 사용할 수 있습니다. / ${R_SCORE} — 게임 종료 후에는 상태가 바뀌지 않아야 함` }, async (t) => {
  const g = await t.game({
    players: 3,
    hands: { 1: ['시선', '상처', '흑역사', '성정', '황금칼'] },
    deck: ['난투'],
    filler: 0,
  });
  await drawEvent(g, 0, '난투');
  await g.waitPhase('MAIN');
  g.c(0).act('draw_card');
  await waitGameOver(g, [0, 1, 2]);
  const first = g.c(1).gameOvers[0];
  t.note(`덱 소진 정산: ${fmtScores(first)}`);
  // 종료 후 악인 나래가 무기로 공격을 시도
  g.c(1).act('play_tool', g.cardId(1, '성정'), g.c(0).id);
  await g.settle();
  const phaseAfterAttack = g.room.phase;
  t.note(`종료 후 나래의 성정 공격 → 단계 ${phaseAfterAttack}`);
  if (phaseAfterAttack === 'WAITING_FOR_DEFENSE') {
    g.c(0).act('skip_defense');
    await g.waitFor(() => !g.p(0).isAlive, '가람 사망').catch(() => undefined);
    await g.settle();
    t.note(`가람 사망 후 단계 ${g.room.phase}, 현재 차례=${g.room.currentTurnPlayerId}`);
    if (g.hand(1).includes('황금칼')) {
      g.c(1).act('play_tool', g.cardId(1, '황금칼'), g.c(2).id);
      await g.waitPhase('WAITING_FOR_DEFENSE').catch(() => undefined);
      g.c(2).act('skip_defense');
      await g.settle(60);
    }
    const last = g.c(1).gameOvers[g.c(1).gameOvers.length - 1];
    t.note(`game_over ${g.c(1).gameOvers.length}회 수신, 마지막 정산: ${fmtScores(last)}`);
  }
  t.expectEq(phaseAfterAttack, 'ENDED', '종료 후 공격은 무시되어 단계가 ENDED로 유지');
  t.expect(g.p(0).isAlive, '가람은 종료 후 죽지 않아야 함');
  t.expectEq(g.c(1).gameOvers.length, 1, 'game_over는 한 번만');
});

scenario('게임 종료 후: 퇴장으로 최후 1인이 정해지면 진행 중이던 심판대 투표가 게임을 다시 움직이지 않는다', { card: '정산', rule: `${R_SCORE} — game_over는 한 번, 종료 후 생존/단계 변화 없음` }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['시선'] }, dead: [2], deck: ['천사의 심판대'] });
  await drawEvent(g, 0, '천사의 심판대');
  await g.waitFor(() => pa(g)?.type === 'VOTE', '투표 시작');
  g.c(1).act('leave_room');
  await waitGameOver(g, [0, 2]);
  t.note(`퇴장 직후 정산: ${fmtScores(g.c(0).gameOvers[0])}, 단계 ${g.room.phase}, 남은 pendingAction=${pa(g)?.type ?? '없음'}`);
  const phases = await samplePhases(g, 4000);
  await g.settle();
  t.note(`이후 단계 변화: ${phases.join(' → ')}; game_over ${g.c(0).gameOvers.length}회; 가람 생존=${g.p(0).isAlive}`);
  if (g.c(0).gameOvers.length > 1) t.note(`두 번째 정산: ${fmtScores(g.c(0).gameOvers[1])}`);
  t.expectEq(phases, ['ENDED'], '종료 후 단계 변화 없음');
  t.expect(g.p(0).isAlive, '우승자 가람은 종료 후 죽지 않아야 함');
  t.expectEq([g.c(0).gameOvers.length, g.c(2).gameOvers.length], [1, 1], 'game_over 1회');
});

scenario('게임 종료 후: 눈 없는 괴물에게 들켜 최후 1인이 정해지면 진행 중이던 심판대 투표가 게임을 다시 움직이지 않는다', { card: '정산', rule: `${R_SCORE} / [눈 없는 괴물] 소리를 낸 생존자는 괴물에게 들켜 죽게 됩니다.` }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['시선'] }, dead: [2], deck: ['눈 없는 괴물', '천사의 심판대'] });
  await drawEvent(g, 0, '눈 없는 괴물');
  await g.waitPhase('MAIN');
  await drawEvent(g, 0, '천사의 심판대');
  await g.waitFor(() => pa(g)?.type === 'VOTE', '투표 시작');
  g.c(1).act('send_chat', '살려줘');
  await waitGameOver(g, [0, 1, 2]);
  t.note(`나래 사망 직후 정산: ${fmtScores(g.c(0).gameOvers[0])}`);
  const phases = await samplePhases(g, 4000);
  await g.settle();
  t.note(`이후 단계 변화: ${phases.join(' → ')}; game_over ${g.c(0).gameOvers.length}회; 가람 생존=${g.p(0).isAlive}`);
  if (g.c(0).gameOvers.length > 1) t.note(`두 번째 정산: ${fmtScores(g.c(0).gameOvers[1])}`);
  t.expectEq(phases, ['ENDED'], '종료 후 단계 변화 없음');
  t.expect(g.p(0).isAlive, '우승자 가람은 종료 후 죽지 않아야 함');
  t.expectEq([0, 1, 2].map((i) => g.c(i).gameOvers.length), [1, 1, 1], 'game_over 1회씩');
});

scenario('새 게임: 종료 후 start_game을 하면 패·악의·성향·생존·타이머·특수 상태가 초기화된다', { card: '정산', rule: '게임 종료(ENDED) 후 새 게임은 처음 상태(각자 2장, 전원 생존, 첫 플레이어 차례)로 시작해야 함' }, async (t) => {
  const g = await t.game({
    players: 3,
    hands: { 0: ['시선', '상처', '흑역사', '짙은 악의'], 1: ['복권', '교환권'], 2: ['코인'] },
    dead: [2],
    turn: 1,
    deck: [],
    filler: 0,
  });
  const room = g.room as any;
  room.linkedPlayers = [g.c(0).id, g.c(1).id];
  room.silenceMode = true;
  room.freeForAll = true;
  g.c(1).act('draw_card');
  await waitGameOver(g, [0, 1, 2]);
  t.expectEq(g.room.phase, 'ENDED', '1판 종료');
  const startedBefore = g.c(0).eventsOf('game_started').length;
  g.c(2).act('start_game'); // 사망했던 플레이어도 새 게임 시작 가능
  await g.waitPhase('MAIN');
  await g.waitFor(() => g.clients.every((c) => c.eventsOf('game_started').length > startedBefore && c.state?.phase === 'MAIN'), '새 게임 상태 수신');
  g.tracker.rebaseline();
  await g.settle();
  g.check();
  t.expect([0, 1, 2].every((i) => g.p(i).isAlive), '전원 생존');
  for (const i of [0, 1, 2]) {
    const p = g.p(i);
    t.expectEq(g.handCards(i).length, 2, `${g.c(i).name} 초기 패 2장`);
    t.expect(g.handCards(i).every((c) => c.category !== 'EVENT'), `${g.c(i).name} 패에 이벤트 없음`);
    t.expectEq(p.currentMalice, expectedMalice(p), `${g.c(i).name} 악의 = 새 패 기준`);
    t.expectEq([p.hasDrawnThisTurn, p.hasUsedWeaponThisTurn, p.isSilenced], [false, false, false], `${g.c(i).name} 차례 플래그 초기화`);
    t.expectEq(g.c(i).state?.myInfo.hand ? Object.values(g.c(i).state!.myInfo.hand).flat().length : -1, 2, `${g.c(i).name} 화면의 패 2장`);
  }
  t.expectEq(g.room.currentTurnPlayerId, g.c(0).id, '첫 플레이어(가람) 차례');
  t.expectEq(g.room.players.filter((p) => p.isMyTurn).map((p) => p.id), [g.c(0).id], 'isMyTurn은 가람만');
  t.expectEq([room.linkedPlayers, room.silenceMode, room.freeForAll, room.pendingAction, room.activeEvent], [null, false, false, null, null], '특수 상태 초기화');
  t.expect(isTimerPending(g.room.turnTimer) && !g.room.isTurnTimerPaused, '턴 타이머 동작 중');
  t.expect((g.room.turnDeadline ?? 0) > Date.now(), '턴 마감 시각이 미래');
  const total = g.room.deck.length + g.room.graveyard.length + [0, 1, 2].reduce((s, i) => s + g.handCards(i).length, 0);
  t.expectEq(total, 30, '새 덱(3명×10장)에서 카드가 빠짐없이');
  t.expectEq([0, 1, 2].map((i) => g.c(i).gameOvers.length), [1, 1, 1], '새 게임 시작으로 game_over가 다시 오지 않음');
});

scenario('새 게임: 이전 게임에 남아 있던 이벤트 타이머가 새 게임을 건드리지 않는다', { card: '정산', rule: '게임 종료 후 새 게임은 이전 게임의 타이머와 무관해야 함' }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['시선'] }, dead: [2], deck: ['천사의 심판대'] });
  await drawEvent(g, 0, '천사의 심판대');
  await g.waitFor(() => pa(g)?.type === 'VOTE', '투표 시작');
  g.c(1).act('leave_room');
  await waitGameOver(g, [0, 2]);
  g.c(0).act('start_game');
  await g.waitPhase('MAIN');
  await g.waitFor(() => [0, 2].every((i) => g.c(i).state?.phase === 'MAIN'), '새 게임 상태 수신');
  g.tracker.rebaseline();
  const phases = await samplePhases(g, 3500);
  t.note(`새 게임 단계 변화: ${phases.join(' → ')}`);
  t.expectEq(phases, ['MAIN'], '새 게임은 MAIN 유지');
  t.expect(g.p(0).isAlive && g.p(2).isAlive, '새 게임에서 아무도 죽지 않음');
  t.expectEq([g.c(0).gameOvers.length, g.c(2).gameOvers.length], [1, 1], 'game_over 추가 없음');
});

scenario('return_to_lobby: 게임 진행 중에는 무시되어야 한다', { card: '정산', rule: 'return_to_lobby: "게임 종료 후 대기실로 복귀"(shared/types.ts) — 진행 중인 게임을 한 사람이 초기화할 수 없어야 함' }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['시선', '성정'], 1: ['코인'] } });
  g.c(1).act('return_to_lobby');
  await g.settle();
  t.note(`나래의 return_to_lobby 후: 단계=${g.room.phase}, 가람 패=[${g.hand(0).join(', ')}], 덱=${g.room.deck.length}장`);
  t.expectEq(g.room.phase, 'MAIN', '게임 진행 유지');
  t.expectEq(sorted(g.hand(0)), sorted(['시선', '성정']), '가람 패 유지');
  t.expectEq(g.hand(1), ['코인'], '나래 패 유지');
});

scenario('return_to_lobby: 방에 없는 외부인은 진행 중인 게임을 초기화할 수 없다', { card: '정산', rule: 'return_to_lobby: 게임 종료 후 대기실로 복귀 — 방 참가자가 아닌 소켓이 남의 게임을 초기화할 수 없어야 함' }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['시선', '성정'] } });
  const outsider = new TestClient(g.srv.url, '외부인');
  await outsider.connect();
  try {
    outsider.raw('return_to_lobby', g.code);
    await g.settle();
    t.note(`외부인의 return_to_lobby 후: 단계=${g.room.phase}, 가람 패=[${g.hand(0).join(', ')}]`);
    t.expectEq(g.room.phase, 'MAIN', '게임 진행 유지');
    t.expectEq(sorted(g.hand(0)), sorted(['시선', '성정']), '가람 패 유지');
  } finally {
    outsider.close();
  }
});

scenario('return_to_lobby: 게임 종료 후에는 대기실로 돌아가 패·악의·성향이 초기화된다', { card: '정산', rule: 'return_to_lobby: 게임 종료 후 대기실로 복귀' }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['시선', '상처', '흑역사'] }, dead: [2], deck: [], filler: 0 });
  g.c(0).act('draw_card');
  await waitGameOver(g, [0, 1, 2]);
  g.c(1).act('return_to_lobby');
  await g.waitPhase('WAITING');
  // 하네스는 ENDED → WAITING도 POST_GAME_PHASE_CHANGE로 보므로, 정상적인 대기실 복귀 후 기준선을 다시 잡습니다.
  g.tracker.rebaseline();
  await g.settle();
  for (const i of [0, 1, 2]) {
    t.expectEq([g.handCards(i).length, g.p(i).currentMalice, g.p(i).alignment, g.p(i).isAlive], [0, 0, 'GOOD', true], `${g.c(i).name} 초기화`);
  }
  t.expect(!isTimerPending(g.room.turnTimer), '턴 타이머 정지');
});

scenario('start_game: 게임 진행 중에는 무시된다', { card: '정산', rule: '진행 중인 게임을 start_game으로 다시 시작할 수 없어야 함' }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['시선', '성정'] } });
  const before = g.c(0).eventsOf('game_started').length;
  g.c(1).act('start_game');
  await g.settle();
  t.expectEq(g.room.phase, 'MAIN', 'MAIN 유지');
  t.expectEq(sorted(g.hand(0)), sorted(['시선', '성정']), '패 유지');
  t.expectEq(g.c(0).eventsOf('game_started').length, before, 'game_started 재전송 없음');
});
