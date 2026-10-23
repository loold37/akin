import { scenario } from '../harness/runner';
import type { GameCtx } from '../harness/game';
import { makeSyntheticWeapon } from '../harness/cards';
import { isTimerPending } from '../harness/timescale';
import type { Card } from '../../../shared/types';

// 01-weapons: 무기 카드(십자가#201, 성정, 황금칼, 필멸의 창, 누군가의 뼈, 교화의 창)와
// 패에 들어온 엑스칼리버/마육검, 그리고 무기 공격 공통 규칙(1회 제한, 차례, 대상, 난투, 턴 타이머)을 검사합니다.

// ── 규칙 문장 (card.json 인용) ─────────────────────────────────────────
const R_BASIC = '자신의 차례 중 언제든지 다른 생존자를 1회 공격할 수 있으며, 사용 후 버려야 합니다.';
const R_SPEAR =
  '이 창으로 공격당한 자가 방패로 막으면 오른쪽 생존자로 향합니다. 이 창은 자신에게도 돌아오며 누군가 죽을 때까지 반복해야 합니다.';
const R_SPEAR_DETAIL = "창을 사용한 최초 공격자에게 그대로 돌아가는 것이 아니라, '자신에게 오기 직전에 창을 넘긴 생존자'에게 돌아갑니다.";
const R_MIRROR_SPEAR = "'필멸의 창' 공격을 반사할 시, 애초에 창을 던졌던 원래 공격자가 아니라 나에게 창을 넘긴 직전의 생존자에게 반사합니다.";
const R_GUARDIAN = '이 방패는 자신뿐만 아니라 다른 생존자에게 향하는 공격을 대신 막아줄 수 있습니다.';
const R_REFORM = '이 창으로 다른 생존자를 죽이는 것에 성공하면 자신의 모든 악의를 버립니다.';
const R_REFORM_DETAIL = '공격에 성공하여 상대가 사망 확정될 경우 즉시 패에 있는 모든 악의 카드를 버립니다.';
const R_BONE = '이 무기는 악의인 동시에 무기입니다. 악의를 제외한 카드로 사용 가능합니다.';
const R_BONE_DETAIL =
  '이벤트(무장해제 등)에 제출 시, 이 카드 단독(무기+악의 동시 1장 취급)으로는 불가능하며 다른 무기 카드 혹은 악의 카드와 섞어서 제출해야 합니다.';
const R_EXCAL = '이 검은 모든 방패를 뚫을 수 있습니다.';
const R_EXCAL_DETAIL = "패에 성공적으로 추가하면 일반 도구 카드인 '특수 무기'로 취급됩니다.";
const R_MAYUK = '즉시 사용치 않으면 패에 넣고 일반 무기가 됩니다.';
const R_MAYUK_DETAIL = "획득하여 '즉시' 사용할 때만 무기 공격 횟수를 소모하지 않습니다.";
const R_BRAWL = '지금은 자신의 차례가 아닐지라도 누구나 무기를 사용할 수 있습니다. 무기의 사용 횟수 제한도 없습니다.';
const R_BRAWL_DETAIL = '이벤트가 진행되는 동안 모든 생존자가 차례 제약 없이 난투를 벌일 수 있습니다.';

// ── 헬퍼 ───────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 조건이 될 때까지 기다리고 결과를 boolean으로 돌려줍니다 (서버 버그로 안 일어나는 경우 ERROR 대신 FAIL로 판정하기 위함). */
async function within(pred: () => boolean, ms = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return true;
    await sleep(5);
  }
  return pred();
}

/** i번 클라이언트가 앞서 보낸 이벤트가 서버에서 처리되었음을 보장합니다 (같은 소켓의 이벤트는 순서대로 처리됨). */
async function flush(g: GameCtx, i = 0): Promise<void> {
  const token = `flush-${Math.random().toString(36).slice(2, 10)}`;
  const since = Date.now() - 1;
  g.c(i).act('send_chat', token);
  await g.waitFor(() => g.c(i).eventsOf('chat_message', since).some((e) => e.args[1] === token), `flush(${i})`);
  await g.settle();
}

function pending(g: GameCtx): any {
  return (g.room as any).pendingAction;
}

function graveCount(g: GameCtx, name: string): number {
  return g.room.graveyard.filter((c) => c.name === name).length;
}

function graveNames(g: GameCtx): string[] {
  return g.room.graveyard.map((c) => c.name);
}

function who(g: GameCtx, id: string | null | undefined): string {
  const i = g.indexOf(id);
  return i === -1 ? String(id) : `${i}번(${g.c(i).name})`;
}

/** from이 weapon으로 to를 공격하고 방어 단계가 열릴 때까지 기다립니다. */
async function attack(g: GameCtx, from: number, weapon: string, to: number): Promise<void> {
  g.c(from).act('play_tool', g.cardId(from, weapon), g.c(to).id);
  await g.waitFor(
    () => g.room.phase === 'WAITING_FOR_DEFENSE' && pending(g)?.targetId === g.c(to).id,
    `${from}번 → ${to}번 ${weapon} 공격`,
  );
}

function block(g: GameCtx, i: number, shield: string, forWhom?: number): void {
  g.c(i).act('play_shield', g.cardId(i, shield), forWhom === undefined ? undefined : g.c(forWhom).id);
}

/** 현재 방어 대상이 i번이 될 때까지 기다립니다. */
function targetIs(g: GameCtx, i: number): boolean {
  return g.room.phase === 'WAITING_FOR_DEFENSE' && pending(g)?.targetId === g.c(i).id;
}

/** 서버가 마육검(보관)/엑스칼리버 획득 시 넣는 것과 같은 모양의 무기를 패에 넣습니다. */
function giveSynthetic(g: GameCtx, i: number, name: '마육검' | '엑스칼리버'): Card {
  const card = makeSyntheticWeapon(name);
  g.room.addCardToHand(g.p(i), card);
  g.room.recalculateMalice(g.p(i));
  g.tracker.rebaseline();
  g.broadcast();
  return card;
}

/** 현재 차례 플레이어가 덱 맨 위 이벤트를 뽑고 그 이벤트가 진행 중이 될 때까지 기다립니다. */
async function drawEvent(g: GameCtx, name: string): Promise<void> {
  const cur = g.indexOf(g.room.currentTurnPlayerId);
  g.c(cur).act('draw_card');
  await g.waitFor(() => g.room.phase === 'RESOLVING_EVENT' && pending(g)?.eventName === name, `${name} 발동`);
}

/** 0번이 난투를 뽑아 난투 상태가 될 때까지 기다립니다. */
async function startBrawl(g: GameCtx): Promise<void> {
  g.c(0).act('draw_card');
  await g.waitFor(() => g.room.freeForAll && g.room.phase === 'MAIN', '난투 발동');
  await g.settle();
}

// ════════════════════════════════════════════════════════════════════
// 1. 일반 무기 (십자가#201 / 성정 / 황금칼)
// ════════════════════════════════════════════════════════════════════

const BASIC_WEAPONS = [
  { spec: '십자가#201', name: '십자가', label: '십자가(무기)', other: '성정' },
  { spec: '성정', name: '성정', label: '성정', other: '황금칼' },
  { spec: '황금칼', name: '황금칼', label: '황금칼', other: '성정' },
];

for (const w of BASIC_WEAPONS) {
  scenario(`${w.label}: 방어하지 않으면 대상이 죽고, 무기는 무덤으로 버려진다`, { card: w.label, rule: R_BASIC }, async (t) => {
    const g = await t.game({ players: 3, hands: { 0: [w.spec] } });
    await attack(g, 0, w.spec, 1);
    t.expectEq(g.hand(0), [], '무기는 사용하는 순간 패에서 빠져야 함');
    g.c(1).act('skip_defense');
    await g.waitFor(() => !g.p(1).isAlive, '피격자 사망');
    await g.waitPhase('MAIN');
    t.expect(g.p(0).isAlive && g.p(2).isAlive, '공격자와 제3자는 살아 있어야 함');
    t.expectEq(graveCount(g, w.name), 1, `무덤에 ${w.name}이(가) 정확히 1장 있어야 함`);
    t.expectEq(who(g, g.room.currentTurnPlayerId), who(g, g.c(0).id), '공격 후에도 차례는 공격자에게 남아 있어야 함');
    t.expect(g.p(0).hasUsedWeaponThisTurn, '이번 차례 무기 사용 표시');
  });

  scenario(`${w.label}: 방패로 막으면 둘 다 살고, 무기와 방패 모두 버려진다`, { card: w.label, rule: R_BASIC }, async (t) => {
    const g = await t.game({ players: 3, hands: { 0: [w.spec], 1: ['황금 방패'] } });
    await attack(g, 0, w.spec, 1);
    block(g, 1, '황금 방패');
    await g.waitPhase('MAIN');
    await g.settle();
    t.expect(g.p(0).isAlive && g.p(1).isAlive && g.p(2).isAlive, '모두 살아 있어야 함');
    t.expectEq(g.hand(0), [], '공격자 패에서 무기가 빠짐');
    t.expectEq(g.hand(1), [], '방어자 패에서 방패가 빠짐');
    t.expectEq(graveCount(g, w.name), 1, '무덤에 무기 1장');
    t.expectEq(graveCount(g, '황금 방패'), 1, '무덤에 방패 1장');
  });

  scenario(`${w.label}: 한 차례에 무기 공격은 1회뿐이다 (두 번째 무기는 패에 남는다)`, { card: w.label, rule: R_BASIC }, async (t) => {
    const g = await t.game({ players: 3, hands: { 0: [w.spec, w.other], 1: ['황금 방패'] } });
    await attack(g, 0, w.spec, 1);
    block(g, 1, '황금 방패');
    await g.waitPhase('MAIN');
    g.c(0).act('play_tool', g.cardId(0, w.other), g.c(2).id);
    await flush(g, 0);
    t.expectEq(g.room.phase, 'MAIN', '두 번째 공격은 거부되어 MAIN 단계 유지');
    t.expect(g.p(2).isAlive, '2번은 살아 있어야 함');
    t.expectEq(g.hand(0), [w.other], '두 번째 무기는 버려지지 않고 패에 남아야 함');
  });
}

scenario('십자가(무기): 보물 십자가(#502)로는 공격할 수 없다', { card: '십자가(무기)', rule: R_BASIC }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['십자가#502'] } });
  g.c(0).act('play_tool', g.cardId(0, '십자가#502'), g.c(1).id);
  await flush(g, 0);
  t.expectEq(g.room.phase, 'MAIN', '보물로는 방어 단계가 열리지 않아야 함');
  t.expectEq(g.p(0).hand.treasures.length, 1, '보물 십자가는 패에 그대로');
  t.expect(!g.p(0).hasUsedWeaponThisTurn, '무기 사용 횟수가 소모되지 않아야 함');
});

scenario('십자가(무기): 보물 십자가와 함께 있어도 무기 십자가만 사용·폐기된다', { card: '십자가(무기)', rule: R_BASIC }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['십자가#502', '십자가#201'] } });
  await attack(g, 0, '십자가#201', 1);
  g.c(1).act('skip_defense');
  await g.waitPhase('MAIN');
  t.expectEq(g.p(0).hand.weapons.length, 0, '무기 십자가는 버려짐');
  t.expectEq(g.p(0).hand.treasures.map((c) => c.cardId), [502], '보물 십자가(#502)는 패에 남음');
  t.expectEq(g.room.graveyard.filter((c) => c.name === '십자가').map((c) => c.cardId), [201], '무덤에는 #201만');
});

// ════════════════════════════════════════════════════════════════════
// 2. 무기 공격 공통 규칙 (잘못된 사용 거부)
// ════════════════════════════════════════════════════════════════════

scenario('무기 공통: 자기 차례가 아니면 공격할 수 없다', { card: '무기 공통', rule: R_BASIC }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['성정'] } });
  g.c(1).act('play_tool', g.cardId(1, '성정'), g.c(2).id);
  await flush(g, 1);
  t.expectEq(g.room.phase, 'MAIN', '차례가 아닌 사람의 공격은 거부');
  t.expect(g.p(2).isAlive, '2번 생존');
  t.expectEq(g.hand(1), ['성정'], '무기는 패에 남아야 함');
});

scenario('무기 공통: 자기 자신은 공격할 수 없다', { card: '무기 공통', rule: R_BASIC }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정'] } });
  g.c(0).act('play_tool', g.cardId(0, '성정'), g.c(0).id);
  await flush(g, 0);
  t.expectEq(g.room.phase, 'MAIN', '자기 자신 공격은 거부');
  t.expectEq(g.hand(0), ['성정'], '무기는 패에 남아야 함');
  t.expect(!g.p(0).hasUsedWeaponThisTurn, '공격 횟수 미소모');
});

scenario('무기 공통: 죽은 생존자는 공격할 수 없다', { card: '무기 공통', rule: R_BASIC }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정'] }, dead: [2] });
  g.c(0).act('play_tool', g.cardId(0, '성정'), g.c(2).id);
  await flush(g, 0);
  t.expectEq(g.room.phase, 'MAIN', '죽은 사람 공격은 거부');
  t.expectEq(g.hand(0), ['성정'], '무기는 패에 남아야 함');
  t.expect(!g.p(0).hasUsedWeaponThisTurn, '공격 횟수 미소모');
});

scenario('무기 공통: 없는 대상/대상 없이 공격할 수 없다', { card: '무기 공통', rule: R_BASIC }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정'] } });
  g.c(0).act('play_tool', g.cardId(0, '성정'));
  g.c(0).act('play_tool', g.cardId(0, '성정'), 'no-such-player');
  await flush(g, 0);
  t.expectEq(g.room.phase, 'MAIN', '대상 없는 공격은 거부');
  t.expectEq(g.hand(0), ['성정'], '무기는 패에 남아야 함');
});

scenario('무기 공통: 다른 사람 패의 무기로는 공격할 수 없다', { card: '무기 공통', rule: R_BASIC }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['성정'] } });
  g.c(0).act('play_tool', g.cardId(1, '성정'), g.c(2).id);
  await flush(g, 0);
  t.expectEq(g.room.phase, 'MAIN', '남의 카드 id로는 공격 불가');
  t.expectEq(g.hand(1), ['성정'], '1번 패의 성정은 그대로');
  t.expect(g.p(2).isAlive, '2번 생존');
});

scenario('무기 공통: 방패/아이템 카드를 play_tool로 내도 공격이 되지 않는다', { card: '무기 공통', rule: R_BASIC }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['황금 방패', '선의'] } });
  g.c(0).act('play_tool', g.cardId(0, '황금 방패'), g.c(1).id);
  g.c(0).act('play_tool', g.cardId(0, '선의'), g.c(1).id);
  await flush(g, 0);
  t.expectEq(g.room.phase, 'MAIN', '무기가 아닌 카드로는 공격 불가');
  t.expectEq(g.hand(0).sort(), ['선의', '황금 방패'].sort(), '카드는 패에 그대로');
});

scenario('무기 공통: 카드를 뽑기 전에도 공격할 수 있고, 공격 뒤에도 카드를 뽑을 수 있다', { card: '무기 공통', rule: R_BASIC }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정'], 1: ['황금 방패'] } });
  t.expect(!g.p(0).hasDrawnThisTurn, '아직 뽑지 않은 상태');
  await attack(g, 0, '성정', 1);
  block(g, 1, '황금 방패');
  await g.waitPhase('MAIN');
  g.c(0).act('draw_card');
  const drew = await within(() => g.p(0).hasDrawnThisTurn);
  t.expect(drew, '공격 후에도 드로우 가능해야 함');
  t.expectEq(g.hand(0), ['코인'], '뽑은 카드가 패에 들어옴');
});

scenario('무기 공통: 다음 자기 차례에는 다시 공격할 수 있다', { card: '무기 공통', rule: R_BASIC }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정', '황금칼'], 1: ['황금 방패', '골든 레코드'] } });
  await attack(g, 0, '성정', 1);
  block(g, 1, '황금 방패');
  await g.waitPhase('MAIN');
  for (const i of [0, 1, 2]) {
    g.c(i).act('end_turn');
    await g.waitFor(() => g.room.currentTurnPlayerId === g.c((i + 1) % 3).id, `${i}번 차례 종료`);
  }
  t.expect(!g.p(0).hasUsedWeaponThisTurn, '새 차례에는 무기 사용 표시가 초기화');
  await attack(g, 0, '황금칼', 1);
  block(g, 1, '골든 레코드');
  await g.waitPhase('MAIN');
  t.expect(g.p(1).isAlive, '1번 생존');
});

scenario('무기 공통: 이벤트 처리 중(RESOLVING_EVENT)에는 공격할 수 없다', { card: '무기 공통', rule: R_BASIC }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정'] }, deck: ['무장해제'] });
  await drawEvent(g, '무장해제');
  g.c(0).act('play_tool', g.cardId(0, '성정'), g.c(1).id);
  await flush(g, 0);
  t.expectEq(g.room.phase, 'RESOLVING_EVENT', '이벤트 처리 중 공격은 거부');
  t.expectEq(g.hand(0), ['성정'], '무기는 패에 남아야 함');
  for (const i of [0, 1, 2]) g.c(i).act('submit_cards', []);
  await g.waitPhase('MAIN');
  t.expect(g.p(1).isAlive, '1번 생존');
});

scenario('무기 공통: 방어 시간이 지나도록 아무도 막지 않으면 피격자가 죽는다', { card: '무기 공통', rule: R_BASIC }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정'], 1: ['황금 방패'] } });
  await attack(g, 0, '성정', 1);
  await g.waitServerMs(30000);
  const died = await within(() => !g.p(1).isAlive && g.room.phase === 'MAIN', 2000);
  t.expect(died, '제한시간 후 피격자 사망 & MAIN 복귀');
  t.expectEq(g.hand(1), ['황금 방패'], '쓰지 않은 방패는 (죽은 자의) 패에 그대로');
});

scenario('무기 공통: 거울 방패에 반사되어 공격자(차례 주인)가 죽으면 차례가 다음 생존자에게 넘어간다', { card: '무기 공통', rule: R_BASIC }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정'], 1: ['거울 방패'] } });
  await attack(g, 0, '성정', 1);
  block(g, 1, '거울 방패');
  await g.waitFor(() => targetIs(g, 0), '공격이 0번에게 반사');
  g.c(0).act('skip_defense');
  await g.waitFor(() => !g.p(0).isAlive, '공격자 사망');
  const passed = await within(() => g.room.phase === 'MAIN' && g.room.currentTurnPlayerId === g.c(1).id);
  t.expect(passed, '죽은 공격자 다음 생존자(1번)에게 차례가 넘어가야 함');
  t.expect(g.p(1).isAlive && g.p(2).isAlive, '1, 2번 생존');
});

// ════════════════════════════════════════════════════════════════════
// 3. 턴 타이머 (방어 대기 중 턴 마감)
// ════════════════════════════════════════════════════════════════════

const R_TURN = '(서버 규칙) 차례 제한시간이 지나면 차례가 자동으로 종료되어 다음 생존자에게 넘어갑니다. ' + R_BASIC;

scenario('무기 공통(턴 타이머): 방어 대기 중 턴 마감이 지나도, 방패로 막은 뒤 차례가 다음 생존자에게 넘어간다', { card: '무기 공통', rule: R_TURN }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정'], 1: ['황금 방패'] }, turnDurationMs: 4000 });
  g.room.startTurnTimer(4000); // createGame 대기 동안 줄어든 턴 시간을 다시 채움 (실시간 200ms)
  await attack(g, 0, '성정', 1);
  await g.waitServerMs(4000);
  await t.sleep(150); // 턴 마감을 확실히 넘김 (방어 제한시간 1.5초보다는 짧게)
  t.expectEq(g.room.phase, 'WAITING_FOR_DEFENSE', '아직 방어 대기 중이어야 함');
  t.note(`턴 마감 경과 후 방어 대기 중 turnTimer 살아있음=${isTimerPending(g.room.turnTimer)}, paused=${g.room.isTurnTimerPaused}`);
  block(g, 1, '황금 방패');
  await g.waitPhase('MAIN');
  t.note(`방어 종료 후 MAIN: turnTimer 살아있음=${isTimerPending(g.room.turnTimer)}, paused=${g.room.isTurnTimerPaused}`);
  const passed = await within(() => g.room.currentTurnPlayerId === g.c(1).id, 3000);
  t.expect(passed, `방어가 끝난 뒤 차례가 1번에게 넘어가야 함 (3초=서버 60초 대기, 현재 차례: ${who(g, g.room.currentTurnPlayerId)})`);
});

scenario('무기 공통(턴 타이머): 방어 제한시간 초과로 피격자가 죽은 뒤에도 차례가 넘어간다', { card: '무기 공통', rule: R_TURN }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정'] }, turnDurationMs: 4000 });
  g.room.startTurnTimer(4000);
  await attack(g, 0, '성정', 1);
  await g.waitServerMs(30000); // 방어 제한시간(1.5초) — 턴 마감(0.2초)은 이미 지남
  await g.waitFor(() => !g.p(1).isAlive && g.room.phase === 'MAIN', '시간 초과로 1번 사망');
  t.note(`MAIN 복귀 직후 turnTimer 살아있음=${isTimerPending(g.room.turnTimer)}, paused=${g.room.isTurnTimerPaused}`);
  const passed = await within(() => g.room.currentTurnPlayerId === g.c(2).id, 3000);
  t.expect(passed, `차례가 다음 생존자(2번)에게 넘어가야 함 (현재 차례: ${who(g, g.room.currentTurnPlayerId)})`);
});

scenario('무기 공통(턴 타이머): 턴 마감 전에 방어가 끝나면 남은 시간 뒤 차례가 넘어간다', { card: '무기 공통', rule: R_TURN }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정'], 1: ['황금 방패'] }, turnDurationMs: 20000 });
  g.room.startTurnTimer(20000); // 실시간 1초
  await attack(g, 0, '성정', 1);
  block(g, 1, '황금 방패');
  await g.waitPhase('MAIN');
  t.expectEq(g.room.currentTurnPlayerId, g.c(0).id, '방어 직후에는 아직 0번 차례');
  const passed = await within(() => g.room.currentTurnPlayerId === g.c(1).id, 4000);
  t.expect(passed, '턴 제한시간 후 1번에게 차례가 넘어가야 함');
});

// ════════════════════════════════════════════════════════════════════
// 4. 필멸의 창
// ════════════════════════════════════════════════════════════════════

scenario('필멸의 창: 방패로 막으면 오른쪽(다음) 생존자에게 향하고, 그가 막지 않으면 죽는다', { card: '필멸의 창', rule: R_SPEAR }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['필멸의 창'], 1: ['황금 방패'] } });
  await attack(g, 0, '필멸의 창', 1);
  block(g, 1, '황금 방패');
  const bounced = await within(() => targetIs(g, 2));
  t.expect(bounced, `막힌 창은 1번의 오른쪽인 2번에게 향해야 함 (현재 대상: ${who(g, pending(g)?.targetId)}, phase=${g.room.phase})`);
  g.c(2).act('skip_defense');
  await g.waitFor(() => !g.p(2).isAlive, '2번 사망');
  await g.waitPhase('MAIN');
  t.expect(g.p(0).isAlive && g.p(1).isAlive, '0, 1번 생존');
  t.expectEq(graveCount(g, '필멸의 창'), 1, '필멸의 창은 무덤에 1장');
  t.expectEq(g.room.currentTurnPlayerId, g.c(0).id, '차례는 그대로 0번');
});

scenario('필멸의 창: 한 바퀴 돌아 던진 사람에게도 돌아오며, 던진 사람이 죽으면 차례가 넘어간다', { card: '필멸의 창', rule: R_SPEAR }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['필멸의 창'], 1: ['황금 방패'], 2: ['골든 레코드'] } });
  await attack(g, 0, '필멸의 창', 1);
  block(g, 1, '황금 방패');
  await g.waitFor(() => targetIs(g, 2), '창 → 2번');
  block(g, 2, '골든 레코드');
  const back = await within(() => targetIs(g, 0));
  t.expect(back, `2번이 막으면 창은 2번의 오른쪽인 던진 사람(0번)에게 돌아와야 함 (현재 대상: ${who(g, pending(g)?.targetId)})`);
  g.c(0).act('skip_defense');
  await g.waitFor(() => !g.p(0).isAlive, '던진 사람 사망');
  const passed = await within(() => g.room.phase === 'MAIN' && g.room.currentTurnPlayerId === g.c(1).id);
  t.expect(passed, '죽은 차례 주인 다음 생존자(1번)에게 차례가 넘어가야 함');
});

scenario('필멸의 창: 누군가 죽을 때까지 계속 반복된다', { card: '필멸의 창', rule: R_SPEAR }, async (t) => {
  const g = await t.game({
    players: 3,
    hands: { 0: ['필멸의 창', '황금 방패'], 1: ['골든 레코드', '부처님 손바닥'], 2: ['황금 방패'] },
  });
  await attack(g, 0, '필멸의 창', 1);
  const seq: string[] = ['1'];
  const steps: Array<[number, string, number]> = [
    [1, '골든 레코드', 2],
    [2, '황금 방패', 0],
    [0, '황금 방패', 1],
    [1, '부처님 손바닥', 2],
  ];
  for (const [blocker, shield, next] of steps) {
    block(g, blocker, shield);
    const ok = await within(() => targetIs(g, next));
    t.expect(ok, `${blocker}번이 ${shield}로 막은 뒤 창은 ${next}번에게 가야 함 (현재 대상: ${who(g, pending(g)?.targetId)}, phase=${g.room.phase})`);
    seq.push(String(next));
  }
  t.note(`창 이동 순서: ${seq.join(' → ')}`);
  g.c(2).act('skip_defense');
  await g.waitFor(() => !g.p(2).isAlive, '2번 사망');
  await g.waitPhase('MAIN');
  t.expect(g.p(0).isAlive && g.p(1).isAlive, '0, 1번 생존');
  t.expectEq(graveCount(g, '필멸의 창'), 1, '필멸의 창은 무덤에 정확히 1장');
  t.expectEq(g.room.graveyard.length, 5, '무덤: 창 1 + 방패 4');
});

scenario('필멸의 창: 죽은 생존자의 자리는 건너뛰고 다음 생존자에게 향한다', { card: '필멸의 창', rule: R_SPEAR }, async (t) => {
  const g = await t.game({ players: 4, hands: { 0: ['필멸의 창'], 1: ['황금 방패'] }, dead: [2] });
  await attack(g, 0, '필멸의 창', 1);
  block(g, 1, '황금 방패');
  const ok = await within(() => targetIs(g, 3));
  t.expect(ok, `죽은 2번을 건너뛰고 3번에게 가야 함 (현재 대상: ${who(g, pending(g)?.targetId)})`);
  g.c(3).act('skip_defense');
  await g.waitFor(() => !g.p(3).isAlive, '3번 사망');
  await g.waitPhase('MAIN');
});

scenario('필멸의 창: 튕겨 간 창을 아무도 막지 않으면 제한시간 후 그 생존자가 죽는다', { card: '필멸의 창', rule: R_SPEAR }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['필멸의 창'], 1: ['황금 방패'] } });
  await attack(g, 0, '필멸의 창', 1);
  block(g, 1, '황금 방패');
  await g.waitFor(() => targetIs(g, 2), '창 → 2번');
  await g.waitServerMs(30000);
  const died = await within(() => !g.p(2).isAlive && g.room.phase === 'MAIN', 2000);
  t.expect(died, '제한시간 후 2번 사망 & MAIN 복귀');
  t.expect(g.p(0).isAlive && g.p(1).isAlive, '0, 1번 생존');
});

scenario('필멸의 창: 2인 게임에서 막으면 던진 사람에게 바로 돌아온다', { card: '필멸의 창', rule: R_SPEAR }, async (t) => {
  const g = await t.game({ players: 2, hands: { 0: ['필멸의 창'], 1: ['황금 방패'] } });
  await attack(g, 0, '필멸의 창', 1);
  block(g, 1, '황금 방패');
  const back = await within(() => targetIs(g, 0));
  t.expect(back, `창이 0번에게 돌아와야 함 (현재 대상: ${who(g, pending(g)?.targetId)})`);
  g.c(0).act('skip_defense');
  await g.waitFor(() => g.room.phase === 'ENDED', '게임 종료');
  t.expect(!g.p(0).isAlive && g.p(1).isAlive, '0번 사망, 1번 생존');
});

scenario('필멸의 창: 거울 방패로 반사하면 최초 공격자가 아니라 창을 넘긴 생존자에게 간다', {
  card: '필멸의 창',
  rule: `${R_SPEAR_DETAIL} / 거울 방패: ${R_MIRROR_SPEAR}`,
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['필멸의 창'], 1: ['황금 방패'], 2: ['거울 방패'] } });
  await attack(g, 0, '필멸의 창', 1);
  block(g, 1, '황금 방패');
  await g.waitFor(() => targetIs(g, 2), '창 → 2번');
  block(g, 2, '거울 방패');
  const ok = await within(() => targetIs(g, 1));
  t.expect(ok, `반사된 창은 창을 넘긴 1번에게 가야 함 (현재 대상: ${who(g, pending(g)?.targetId)})`);
  g.c(1).act('skip_defense');
  await g.waitFor(() => !g.p(1).isAlive, '1번 사망');
  await g.waitPhase('MAIN');
  t.expect(g.p(0).isAlive && g.p(2).isAlive, '최초 공격자 0번과 반사한 2번은 생존');
});

scenario('필멸의 창: 첫 피격자가 거울 방패로 반사해 던진 사람이 막으면, 창은 던진 사람의 오른쪽으로 향한다', {
  card: '필멸의 창',
  rule: `${R_SPEAR} / 거울 방패: ${R_MIRROR_SPEAR}`,
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['필멸의 창', '황금 방패'], 1: ['거울 방패'] } });
  await attack(g, 0, '필멸의 창', 1);
  block(g, 1, '거울 방패');
  await g.waitFor(() => targetIs(g, 0), '반사 → 0번');
  block(g, 0, '황금 방패');
  const ok = await within(() => targetIs(g, 1));
  t.expect(ok, `0번이 막았으므로 0번의 오른쪽인 1번에게 가야 함 (현재 대상: ${who(g, pending(g)?.targetId)}, phase=${g.room.phase})`);
  g.c(1).act('skip_defense');
  await g.waitFor(() => !g.p(1).isAlive, '1번 사망');
  await g.waitPhase('MAIN');
  t.expect(g.p(0).isAlive && g.p(2).isAlive, '0, 2번 생존');
});

scenario('필멸의 창: 앞 피격자 때 수호천사 보유자가 한 "방어 포기"가 다음 피격자에게 이어지지 않는다', {
  card: '필멸의 창',
  rule: `${R_SPEAR} / 수호천사: ${R_GUARDIAN}`,
}, async (t) => {
  // 0 → 1(황금 방패로 막음) → 2.  3번은 수호천사 보유자.
  const g = await t.game({ players: 4, hands: { 0: ['필멸의 창'], 1: ['황금 방패'], 3: ['수호천사'] } });
  await attack(g, 0, '필멸의 창', 1);
  g.c(3).act('skip_defense'); // 3번: "1번은 안 지켜 준다"
  await flush(g, 3);
  t.expect(g.p(1).isAlive && g.room.phase === 'WAITING_FOR_DEFENSE', '1번 본인의 결정을 기다려야 함');
  block(g, 1, '황금 방패');
  await g.waitFor(() => targetIs(g, 2), '창 → 2번');
  t.note(`튕긴 뒤 skippedPlayerIds = [${(pending(g)?.skippedPlayerIds ?? []).map((id: string) => who(g, id)).join(', ')}]`);
  g.c(2).act('skip_defense'); // 2번 본인은 방패가 없어 포기
  await flush(g, 2);
  t.expect(
    g.p(2).isAlive && targetIs(g, 2),
    '2번에 대한 새 공격이므로 수호천사 보유자(3번)의 결정을 다시 기다려야 함 — 1번 때의 포기가 이어져 2번이 즉시 죽으면 안 됨',
  );
  // 규칙대로라면: 3번이 수호천사로 2번을 지켜 주고, 창은 2번의 오른쪽(3번)으로 향함
  block(g, 3, '수호천사', 2);
  await g.waitFor(() => targetIs(g, 3), '창 → 3번');
  g.c(3).act('skip_defense');
  await g.waitFor(() => !g.p(3).isAlive, '3번 사망');
  t.expect(g.p(0).isAlive && g.p(1).isAlive && g.p(2).isAlive, '0, 1, 2번 생존');
});

scenario('필멸의 창: 수호천사가 대신 막으면 창은 피격자의 오른쪽으로 향한다', {
  card: '필멸의 창',
  rule: `${R_SPEAR} / 수호천사: ${R_GUARDIAN}`,
  ambiguous: '필멸의 창을 제3자가 수호천사로 대신 막았을 때, 창은 원래 피격자의 오른쪽으로 가나요, 수호천사를 쓴 사람의 오른쪽으로 가나요? (또는 수호천사로 막으면 반복이 끝나나요?)',
}, async (t) => {
  const g = await t.game({ players: 4, hands: { 0: ['필멸의 창'], 3: ['수호천사'] } });
  await attack(g, 0, '필멸의 창', 1);
  block(g, 3, '수호천사', 1);
  await within(() => g.room.phase !== 'WAITING_FOR_DEFENSE' || pending(g)?.targetId !== g.c(1).id);
  t.note(`3번이 1번을 수호천사로 지킨 뒤: phase=${g.room.phase}, 창의 새 대상=${who(g, pending(g)?.targetId)} (피격자 1번의 오른쪽=2번, 수호천사 사용자 3번의 오른쪽=0번)`);
  t.expect(targetIs(g, 2), '피격자(1번)의 오른쪽인 2번에게 향함');
});

scenario('필멸의 창: 창을 막아 넘긴 생존자도 수호천사로 다음 피격자를 지켜 줄 수 있다', {
  card: '필멸의 창',
  rule: `${R_SPEAR} / 수호천사: ${R_GUARDIAN}`,
  ambiguous:
    '필멸의 창을 방패로 막아 오른쪽으로 넘긴 생존자는 "공격자"인가요? 그가 가진 수호천사로 다음 피격자를 대신 막아 줄 수 있나요? (현재 구현은 넘긴 사람을 공격자로 보고 막지만, 최초로 창을 던진 사람은 첫 튕김 이후 수호천사로 막아 줄 수 있음)',
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['필멸의 창'], 1: ['황금 방패', '수호천사'] } });
  await attack(g, 0, '필멸의 창', 1);
  block(g, 1, '황금 방패');
  await g.waitFor(() => targetIs(g, 2), '창 → 2번');
  block(g, 1, '수호천사', 2);
  await flush(g, 1);
  const protectedIt = !g.p(1).hand.shields.some((s) => s.name === '수호천사');
  t.note(`1번(창을 넘긴 사람)의 수호천사 사용 ${protectedIt ? '허용됨' : '거부됨'} — 현재 대상 ${who(g, pending(g)?.targetId)}, 메시지: ${g.msgs(1).filter((m) => m.includes('수호천사')).slice(-1)[0] ?? '-'}`);
  t.expect(protectedIt, '넘긴 사람은 공격자가 아니므로 수호천사로 지켜 줄 수 있어야 함');
});

// ════════════════════════════════════════════════════════════════════
// 5. 교화의 창
// ════════════════════════════════════════════════════════════════════

scenario('교화의 창: 공격으로 상대를 죽이면 자신의 모든 악의(짙은 악의 포함)를 버린다', {
  card: '교화의 창',
  rule: `${R_REFORM} / ${R_REFORM_DETAIL}`,
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['교화의 창', '시선', '짙은 악의', '코인'] } });
  t.expectEq(g.p(0).currentMalice, 3, '사전 조건: 악의 3');
  t.expectEq(g.p(0).alignment, 'EVIL', '사전 조건: 악인');
  await attack(g, 0, '교화의 창', 1);
  g.c(1).act('skip_defense');
  await g.waitFor(() => !g.p(1).isAlive, '1번 사망');
  await g.waitPhase('MAIN');
  await g.settle();
  t.expectEq(g.p(0).hand.malices.length, 0, '악의 카드가 모두 버려짐');
  t.expectEq(g.p(0).currentMalice, 0, '악의 점수 0');
  t.expectEq(g.p(0).alignment, 'GOOD', '선인으로 돌아옴');
  t.expectEq(g.hand(0), ['코인'], '악의가 아닌 카드는 남음');
  t.expectEq(graveCount(g, '교화의 창'), 1, '교화의 창은 무덤으로');
});

scenario('교화의 창: 버린 악의 카드는 무덤으로 간다', {
  card: '교화의 창',
  rule: `${R_REFORM} / ${R_REFORM_DETAIL}`,
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['교화의 창', '시선', '짙은 악의'] } });
  await attack(g, 0, '교화의 창', 1);
  g.c(1).act('skip_defense');
  await g.waitFor(() => !g.p(1).isAlive, '1번 사망');
  await g.waitPhase('MAIN');
  await g.settle();
  t.expectEq(g.p(0).hand.malices.length, 0, '악의는 패에서 빠짐');
  t.note(`무덤: ${graveNames(g).join(', ')}`);
  t.expect(graveCount(g, '시선') === 1 && graveCount(g, '짙은 악의') === 1, '"버린" 악의 카드(시선, 짙은 악의)는 무덤에 있어야 함');
});

scenario('교화의 창: 방패에 막히면 악의를 버리지 않는다', { card: '교화의 창', rule: R_REFORM }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['교화의 창', '시선', '짙은 악의'], 1: ['황금 방패'] } });
  await attack(g, 0, '교화의 창', 1);
  block(g, 1, '황금 방패');
  await g.waitPhase('MAIN');
  await g.settle();
  t.expect(g.p(1).isAlive, '1번 생존');
  t.expectEq(g.p(0).hand.malices.length, 2, '악의 카드 유지');
  t.expectEq(g.p(0).currentMalice, 3, '악의 3 유지');
  t.expectEq(graveCount(g, '교화의 창'), 1, '교화의 창은 사용했으므로 버려짐');
});

scenario('교화의 창: 방어 제한시간 초과로 상대가 죽어도 악의를 버린다', { card: '교화의 창', rule: R_REFORM_DETAIL }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['교화의 창', '시선', '상처'], 1: ['황금 방패'] } });
  await attack(g, 0, '교화의 창', 1);
  await g.waitServerMs(30000);
  await g.waitFor(() => !g.p(1).isAlive && g.room.phase === 'MAIN', '시간 초과로 1번 사망');
  await g.settle();
  t.expectEq(g.p(0).currentMalice, 0, '악의 0');
  t.expectEq(g.p(0).hand.malices.length, 0, '악의 카드 없음');
});

scenario('교화의 창: 거울 방패로 반사되어 던진 사람이 죽으면 누구의 악의가 버려지는가', {
  card: '교화의 창',
  rule: `${R_REFORM} / 거울 방패: 이 방패는 다른 생존자가 당신을 공격할 때 사용하면 그대로 그 공격을 당신을 공격한 생존자에게 돌려줍니다.`,
  ambiguous:
    '교화의 창이 거울 방패로 반사되어 원래 던진 사람이 죽은 경우, 반사한 사람이 "이 창으로 죽이는 것에 성공"한 것으로 보아 그의 악의를 모두 버리나요, 아니면 아무도 악의를 버리지 않나요?',
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['교화의 창', '시선'], 1: ['거울 방패', '상처', '흑역사'] } });
  await attack(g, 0, '교화의 창', 1);
  block(g, 1, '거울 방패');
  await g.waitFor(() => targetIs(g, 0), '반사 → 0번');
  g.c(0).act('skip_defense');
  await g.waitFor(() => !g.p(0).isAlive, '던진 0번 사망');
  await g.waitPhase('MAIN');
  await g.settle();
  t.note(`반사한 1번의 악의: ${g.p(1).currentMalice} (반사 전 2), 패: ${g.hand(1).join(', ') || '없음'}`);
  t.note(`죽은 0번의 악의 카드: ${g.p(0).hand.malices.map((c) => c.name).join(', ') || '없음'}`);
  t.expectEq(g.p(1).currentMalice, 2, '창을 쓰지 않은 반사자의 악의는 그대로');
});

scenario('교화의 창: 누군가의 뼈·누군가의 방패처럼 악의를 겸한 도구도 함께 버리는가', {
  card: '교화의 창',
  rule: `${R_REFORM_DETAIL} / 누군가의 뼈: ${R_BONE}`,
  ambiguous:
    '교화의 창으로 죽이는 데 성공했을 때 "모든 악의"에 악의를 겸한 특수 도구(누군가의 뼈/방패/로켓)도 포함되나요? 포함되지 않는다면 공격자는 악의 점수가 남습니다.',
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['교화의 창', '누군가의 뼈', '누군가의 방패', '시선'] } });
  t.expectEq(g.p(0).currentMalice, 3, '사전 조건: 악의 3');
  await attack(g, 0, '교화의 창', 1);
  g.c(1).act('skip_defense');
  await g.waitFor(() => !g.p(1).isAlive, '1번 사망');
  await g.waitPhase('MAIN');
  await g.settle();
  t.note(`교화 후 0번 패: ${g.hand(0).join(', ') || '없음'}, 악의 ${g.p(0).currentMalice}, ${g.p(0).alignment}`);
  t.expectEq(g.p(0).currentMalice, 0, '모든 악의가 사라져 악의 0');
});

scenario('교화의 창: 마지막 상대를 죽여 게임이 끝나면 악의를 버린 뒤 점수를 계산한다', {
  card: '교화의 창',
  rule: R_REFORM_DETAIL,
  ambiguous:
    '교화의 창으로 마지막 상대를 죽여 최후의 1인이 된 경우, 악의를 버린 "후"의 성향(선인)으로 정산하나요, 버리기 "전"의 성향(악인 최후의 1인)으로 정산하나요?',
}, async (t) => {
  const g = await t.game({ players: 2, hands: { 0: ['교화의 창', '시선', '상처', '흑역사'] } });
  t.expectEq(g.p(0).alignment, 'EVIL', '사전 조건: 악인');
  await attack(g, 0, '교화의 창', 1);
  g.c(1).act('skip_defense');
  await g.waitFor(() => g.c(0).gameOvers.length > 0, '게임 종료 정산');
  await g.settle();
  const mine = g.c(0).gameOvers[0].find((s) => s.playerId === g.c(0).id);
  t.note(`정산: ${mine?.score}점 (${mine?.reason}), 정산 후 0번 상태: 악의 ${g.p(0).currentMalice}, ${g.p(0).alignment}, 악의 카드 ${g.p(0).hand.malices.length}장`);
  t.note(`game_over 이벤트 수: ${g.c(0).gameOvers.length}`);
  t.expect(mine?.reason?.startsWith('선인'), '악의를 버린 뒤(선인)로 정산되어야 함');
});

// ════════════════════════════════════════════════════════════════════
// 6. 누군가의 뼈
// ════════════════════════════════════════════════════════════════════

scenario('누군가의 뼈: 무기 칸에 들어가며 패에 있으면 악의 1장으로 계산된다', { card: '누군가의 뼈', rule: R_BONE }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['누군가의 뼈'] } });
  t.expectEq(g.p(0).hand.weapons.map((c) => c.name), ['누군가의 뼈'], '무기 칸');
  t.expectEq(g.p(0).currentMalice, 1, '악의 1');
  g.give(0, '시선', '상처');
  t.expectEq(g.p(0).currentMalice, 3, '악의 카드 2장 + 뼈 1 = 3');
  t.expectEq(g.p(0).alignment, 'EVIL', '악의 3 → 악인');
});

scenario('누군가의 뼈: 무기로 공격할 수 있고, 사용하면 그 악의도 함께 사라진다', { card: '누군가의 뼈', rule: R_BONE }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['누군가의 뼈', '시선', '상처'] } });
  t.expectEq(g.p(0).alignment, 'EVIL', '사전 조건: 악의 3 → 악인');
  await attack(g, 0, '누군가의 뼈', 1);
  t.expectEq(g.p(0).currentMalice, 2, '뼈를 내는 즉시 악의 2');
  g.c(1).act('skip_defense');
  await g.waitFor(() => !g.p(1).isAlive, '1번 사망');
  await g.waitPhase('MAIN');
  t.expectEq(g.p(0).currentMalice, 2, '악의 2');
  t.expectEq(g.p(0).alignment, 'GOOD', '선인으로 돌아옴');
  t.expectEq(graveCount(g, '누군가의 뼈'), 1, '뼈는 무덤으로');
});

scenario('누군가의 뼈: 무기 공격 1회 제한에 포함된다', { card: '누군가의 뼈', rule: `${R_BONE} / ${R_BASIC}` }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정', '누군가의 뼈'], 1: ['황금 방패'] } });
  await attack(g, 0, '성정', 1);
  block(g, 1, '황금 방패');
  await g.waitPhase('MAIN');
  g.c(0).act('play_tool', g.cardId(0, '누군가의 뼈'), g.c(2).id);
  await flush(g, 0);
  t.expectEq(g.room.phase, 'MAIN', '두 번째 공격 거부');
  t.expectEq(g.hand(0), ['누군가의 뼈'], '뼈는 패에 남음');
  t.expectEq(g.p(0).currentMalice, 1, '악의 1 유지');
});

scenario('누군가의 뼈: 무장해제에 이 카드 1장만으로 무기+악의를 동시에 낼 수 없다', { card: '누군가의 뼈', rule: R_BONE_DETAIL }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['누군가의 뼈'] }, deck: ['무장해제'] });
  await drawEvent(g, '무장해제');
  g.c(0).act('submit_cards', [g.cardId(0, '누군가의 뼈')]);
  await flush(g, 0);
  t.expectEq(g.hand(0), ['누군가의 뼈'], '단독 제출로는 버려지지 않아야 함');
  g.c(1).act('submit_cards', []);
  g.c(2).act('submit_cards', []);
  await g.waitPhase('MAIN');
  t.expectEq(g.hand(0), ['누군가의 뼈'], '이벤트 후에도 패에 그대로');
  t.expectEq(g.p(0).currentMalice, 1, '악의 1 유지');
});

scenario('누군가의 뼈: 무장해제에 같은 카드를 두 번 적어 무기+악의로 낼 수 없다', { card: '누군가의 뼈', rule: R_BONE_DETAIL }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['누군가의 뼈'] }, deck: ['무장해제'] });
  await drawEvent(g, '무장해제');
  const id = g.cardId(0, '누군가의 뼈');
  g.c(0).act('submit_cards', [id, id]);
  await flush(g, 0);
  t.expectEq(g.hand(0), ['누군가의 뼈'], '같은 id 2번 제출은 거부');
  g.c(1).act('submit_cards', []);
  g.c(2).act('submit_cards', []);
  await g.waitPhase('MAIN');
});

scenario('누군가의 뼈: 무장해제에 악의 카드와 함께 "무기"로 낼 수 있다', { card: '누군가의 뼈', rule: R_BONE_DETAIL }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['누군가의 뼈', '시선'] }, deck: ['무장해제'] });
  await drawEvent(g, '무장해제');
  g.c(0).act('submit_cards', [g.cardId(0, '누군가의 뼈'), g.cardId(0, '시선')]);
  await flush(g, 0);
  t.expectEq(g.hand(0), [], '뼈와 시선 모두 버려짐');
  t.expectEq(g.p(0).currentMalice, 0, '악의 0');
  g.c(1).act('submit_cards', []);
  g.c(2).act('submit_cards', []);
  await g.waitPhase('MAIN');
  t.expect(graveCount(g, '누군가의 뼈') === 1 && graveCount(g, '시선') === 1, '둘 다 무덤으로');
});

scenario('누군가의 뼈: 무장해제에 다른 무기와 함께 "악의"로 낼 수 있다', { card: '누군가의 뼈', rule: R_BONE_DETAIL }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정', '누군가의 뼈'] }, deck: ['무장해제'] });
  await drawEvent(g, '무장해제');
  g.c(0).act('submit_cards', [g.cardId(0, '성정'), g.cardId(0, '누군가의 뼈')]);
  await flush(g, 0);
  t.expectEq(g.hand(0), [], '성정과 뼈 모두 버려짐');
  t.expectEq(g.p(0).currentMalice, 0, '악의 0');
  g.c(1).act('submit_cards', []);
  g.c(2).act('submit_cards', []);
  await g.waitPhase('MAIN');
});

scenario('누군가의 뼈: 악의로 취급되므로 선택(善)의 공개 대상이 뼈만 들고 있어도 뽑은 자가 죽는다', {
  card: '누군가의 뼈',
  rule: `${R_BONE} / 선택(善): 그중 악의가 1장이라도 있다면 이 카드를 뽑은 자는 죽습니다.`,
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['누군가의 뼈'] }, deck: ['선택 (善)'] });
  g.c(0).act('draw_card');
  await g.waitFor(() => g.requests(0, 'request_target').length > 0, '대상 선택 요청');
  g.c(0).act('submit_target', g.c(1).id);
  await g.waitFor(() => !!pending(g)?.revealedCards, '패 공개');
  for (const i of [0, 1, 2]) g.c(i).act('confirm_reveal');
  const died = await within(() => !g.p(0).isAlive && g.room.phase === 'MAIN');
  t.expect(died, '뼈(악의 1)가 공개되어 뽑은 0번이 죽어야 함');
  t.expect(g.p(1).isAlive, '공개 대상 1번은 생존');
  t.expectEq(g.hand(1), ['누군가의 뼈'], '공개만 할 뿐 카드는 그대로');
});

scenario('누군가의 뼈: 악의로 취급되므로 뼈를 든 채로는 엑스칼리버를 얻을 수 없다', {
  card: '누군가의 뼈',
  rule: `${R_BONE} / 엑스칼리버: 이 검을 얻고 싶다면 악의가 0장인 채로 가장 빠르게 자신의 모든 패를 공개해야 합니다.`,
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['누군가의 뼈'] }, deck: ['엑스칼리버'] });
  await drawEvent(g, '엑스칼리버');
  g.c(0).act('claim_excalibur');
  await flush(g, 0);
  t.expect(!g.hand(0).includes('엑스칼리버'), '뼈(악의 1)를 들고 있으면 획득 실패');
  t.expectEq(g.room.phase, 'RESOLVING_EVENT', '이벤트는 계속 진행');
  for (const i of [0, 1, 2]) g.c(i).act('skip_excalibur');
  await g.waitPhase('MAIN');
  t.expectEq(g.hand(0), ['누군가의 뼈'], '뼈는 그대로');
});

scenario('누군가의 뼈: "악의를 제외한 카드"를 요구하는 인체 연성에 제물로 낼 수 있다', {
  card: '누군가의 뼈',
  rule: `${R_BONE} / 인체 연성: 모든 생존자가 힘을 합쳐 참가자 수만큼 악의를 제외한 카드를 버리면 죽은 자를 한 명 부활시킵니다.`,
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['누군가의 뼈'] }, deck: ['인체 연성'], dead: [2] });
  await drawEvent(g, '인체 연성');
  g.c(0).act('submit_cards', [g.cardId(0, '누군가의 뼈')]);
  await flush(g, 0);
  t.expectEq(g.hand(0), [], '뼈가 제물로 접수되어 패에서 빠짐');
  t.expectEq(g.p(0).currentMalice, 0, '제출 중 악의 0');
  g.c(1).act('submit_cards', []); // 생존자 2명인데 1장뿐 → 실패, 반환
  await g.waitPhase('MAIN');
  t.expectEq(g.hand(0), ['누군가의 뼈'], '실패 시 뼈 반환');
  t.expectEq(g.p(0).currentMalice, 1, '반환 후 악의 1');
});

// ════════════════════════════════════════════════════════════════════
// 7. 엑스칼리버 (패에 들어온 특수 무기)
// ════════════════════════════════════════════════════════════════════

scenario('엑스칼리버: 일반 방패로 막을 수 없고 방패도 소모되지 않는다', { card: '엑스칼리버', rule: `${R_EXCAL} / ${R_EXCAL_DETAIL}` }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['황금 방패'] } });
  giveSynthetic(g, 0, '엑스칼리버');
  await attack(g, 0, '엑스칼리버', 1);
  block(g, 1, '황금 방패');
  await flush(g, 1);
  t.expect(targetIs(g, 1), '방패가 거부되어 여전히 1번이 피격 대상');
  t.expectEq(g.hand(1), ['황금 방패'], '방패는 소모되지 않음');
  g.c(1).act('skip_defense');
  await g.waitFor(() => !g.p(1).isAlive, '1번 사망');
  await g.waitPhase('MAIN');
  t.expectEq(graveCount(g, '엑스칼리버'), 1, '엑스칼리버는 사용 후 버려짐');
});

scenario('엑스칼리버: 거울 방패로 반사할 수 없다', { card: '엑스칼리버', rule: R_EXCAL }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['거울 방패'] } });
  giveSynthetic(g, 0, '엑스칼리버');
  await attack(g, 0, '엑스칼리버', 1);
  block(g, 1, '거울 방패');
  await flush(g, 1);
  t.expect(targetIs(g, 1), '반사되지 않고 1번이 그대로 피격 대상');
  t.expectEq(pending(g)?.initiatorId, g.c(0).id, '공격자는 그대로 0번');
  t.expectEq(g.hand(1), ['거울 방패'], '거울 방패는 소모되지 않음');
  g.c(1).act('skip_defense');
  await g.waitFor(() => !g.p(1).isAlive, '1번 사망');
  t.expect(g.p(0).isAlive, '0번 생존');
});

scenario('엑스칼리버: 수호천사로 대신 막을 수 없다', { card: '엑스칼리버', rule: `${R_EXCAL} / 수호천사: ${R_GUARDIAN}` }, async (t) => {
  const g = await t.game({ players: 3, hands: { 2: ['수호천사'] } });
  giveSynthetic(g, 0, '엑스칼리버');
  await attack(g, 0, '엑스칼리버', 1);
  block(g, 2, '수호천사', 1);
  await flush(g, 2);
  t.expect(targetIs(g, 1), '수호천사가 거부되어 1번이 그대로 피격 대상');
  t.expectEq(g.hand(2), ['수호천사'], '수호천사는 소모되지 않음');
  g.c(1).act('skip_defense');
  await flush(g, 1);
  t.note(`피격자만 포기한 직후: 1번 ${g.p(1).isAlive ? '생존(수호천사 보유자의 포기를 기다림)' : '사망'}`);
  g.c(2).act('skip_defense');
  const died = await within(() => !g.p(1).isAlive && g.room.phase === 'MAIN');
  t.expect(died, '1번 사망');
});

scenario('엑스칼리버: 방패를 들고 있어도 제한시간이 지나면 피격자가 죽는다', { card: '엑스칼리버', rule: R_EXCAL }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['황금 방패', '거울 방패'] } });
  giveSynthetic(g, 0, '엑스칼리버');
  await attack(g, 0, '엑스칼리버', 1);
  await g.waitServerMs(30000);
  const died = await within(() => !g.p(1).isAlive && g.room.phase === 'MAIN', 2000);
  t.expect(died, '1번 사망');
});

scenario('엑스칼리버: 일반 무기처럼 그 차례의 무기 공격 1회를 소모한다', { card: '엑스칼리버', rule: `${R_EXCAL_DETAIL} / ${R_BASIC}` }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정'] } });
  giveSynthetic(g, 0, '엑스칼리버');
  await attack(g, 0, '엑스칼리버', 1);
  g.c(1).act('skip_defense');
  await g.waitFor(() => !g.p(1).isAlive, '1번 사망');
  await g.waitPhase('MAIN');
  g.c(0).act('play_tool', g.cardId(0, '성정'), g.c(2).id);
  await flush(g, 0);
  t.expectEq(g.room.phase, 'MAIN', '두 번째 공격 거부');
  t.expect(g.p(2).isAlive, '2번 생존');
  t.expectEq(g.hand(0), ['성정'], '성정은 패에 남음');
});

scenario('엑스칼리버: 인간 방패(아이템)로 다른 생존자에게 공격을 넘길 수 있는가', {
  card: '엑스칼리버',
  rule: `${R_EXCAL} / 인간 방패: 이 카드를 사용하면 다른 생존자를 방패로 사용해 희생시킵니다. 단 방패로 선택된 자도 방패를 사용해 공격을 막을 수 있습니다.`,
  ambiguous: '"모든 방패를 뚫는" 엑스칼리버 공격을 아이템인 인간 방패로 다른 생존자에게 떠넘길 수 있나요?',
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['인간 방패'], 2: ['황금 방패'] } });
  giveSynthetic(g, 0, '엑스칼리버');
  await attack(g, 0, '엑스칼리버', 1);
  g.c(1).act('interrupt_action', g.cardId(1, '인간 방패'), g.c(2).id);
  await flush(g, 1);
  const redirected = targetIs(g, 2);
  t.note(`인간 방패 사용 ${redirected ? '허용 → 2번이 새 피격 대상' : '거부'}`);
  if (redirected) {
    block(g, 2, '황금 방패');
    await flush(g, 2);
    t.note(`넘겨받은 2번의 황금 방패: ${g.hand(2).includes('황금 방패') ? '거부됨(엑스칼리버)' : '사용됨'}`);
    g.c(2).act('skip_defense');
    await within(() => g.room.phase === 'MAIN');
    t.note(`결과: 1번 ${g.p(1).isAlive ? '생존' : '사망'}, 2번 ${g.p(2).isAlive ? '생존' : '사망'}`);
  }
  t.expect(!redirected, '모든 방패를 뚫으므로 인간 방패도 통하지 않음');
});

// ════════════════════════════════════════════════════════════════════
// 8. 마육검 (패에 보관된 일반 무기)
// ════════════════════════════════════════════════════════════════════

scenario('마육검: 패에 보관한 마육검으로 공격해 막지 않으면 죽이고, 마육검은 버려진다', { card: '마육검', rule: R_MAYUK }, async (t) => {
  const g = await t.game({ players: 3 });
  giveSynthetic(g, 0, '마육검');
  await attack(g, 0, '마육검', 1);
  t.expectEq(g.hand(0), [], '패에서 빠짐');
  g.c(1).act('skip_defense');
  await g.waitFor(() => !g.p(1).isAlive, '1번 사망');
  await g.waitPhase('MAIN');
  t.expectEq(graveCount(g, '마육검'), 1, '마육검 무덤으로');
});

scenario('마육검: 패에 보관한 마육검은 방패로 막을 수 있다', { card: '마육검', rule: R_MAYUK }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['황금 방패'] } });
  giveSynthetic(g, 0, '마육검');
  await attack(g, 0, '마육검', 1);
  block(g, 1, '황금 방패');
  await g.waitPhase('MAIN');
  t.expect(g.p(1).isAlive, '1번 생존');
  t.expectEq(g.hand(1), [], '방패 소모');
});

scenario('마육검: 패에 보관한 마육검은 그 차례의 무기 공격 1회를 소모한다', { card: '마육검', rule: `${R_MAYUK} / ${R_MAYUK_DETAIL}` }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정'], 1: ['황금 방패'] } });
  giveSynthetic(g, 0, '마육검');
  await attack(g, 0, '마육검', 1);
  block(g, 1, '황금 방패');
  await g.waitPhase('MAIN');
  g.c(0).act('play_tool', g.cardId(0, '성정'), g.c(2).id);
  await flush(g, 0);
  t.expectEq(g.room.phase, 'MAIN', '두 번째 공격 거부');
  t.expectEq(g.hand(0), ['성정'], '성정은 패에 남음');
  t.expect(g.p(2).isAlive, '2번 생존');
});

scenario('마육검: 다른 무기로 이미 공격했다면 보관한 마육검으로 또 공격할 수 없다', { card: '마육검', rule: `${R_MAYUK} / ${R_MAYUK_DETAIL}` }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정'], 1: ['황금 방패'] } });
  giveSynthetic(g, 0, '마육검');
  await attack(g, 0, '성정', 1);
  block(g, 1, '황금 방패');
  await g.waitPhase('MAIN');
  g.c(0).act('play_tool', g.cardId(0, '마육검'), g.c(2).id);
  await flush(g, 0);
  t.expectEq(g.room.phase, 'MAIN', '마육검 공격 거부');
  t.expectEq(g.hand(0), ['마육검'], '마육검은 패에 남음');
});

// ════════════════════════════════════════════════════════════════════
// 9. 난투 중 무기 사용
// ════════════════════════════════════════════════════════════════════

scenario('난투: 차례가 아닌 생존자도 무기를 쓸 수 있고 횟수 제한이 없다', { card: '난투', rule: `${R_BRAWL} / ${R_BRAWL_DETAIL}` }, async (t) => {
  const g = await t.game({ players: 4, hands: { 0: ['황금 방패'], 1: ['성정', '황금칼'] }, deck: ['난투'] });
  await startBrawl(g);
  await attack(g, 1, '성정', 2);
  g.c(2).act('skip_defense');
  await g.waitFor(() => !g.p(2).isAlive, '2번 사망');
  await g.waitPhase('MAIN');
  g.c(1).act('play_tool', g.cardId(1, '황금칼'), g.c(0).id);
  const second = await within(() => targetIs(g, 0));
  t.expect(second, '난투 중에는 같은 사람이 두 번째 공격도 할 수 있어야 함');
  block(g, 0, '황금 방패');
  await g.waitPhase('MAIN');
  t.expectEq(g.room.currentTurnPlayerId, g.c(0).id, '차례는 그대로 0번');
  t.expectEq(g.hand(1), [], '두 무기 모두 사용됨');
});

scenario('난투: 차례 주인도 무기를 여러 번 쓸 수 있다', { card: '난투', rule: R_BRAWL }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정', '황금칼'], 1: ['황금 방패'], 2: ['골든 레코드'] }, deck: ['난투'] });
  await startBrawl(g);
  await attack(g, 0, '성정', 1);
  block(g, 1, '황금 방패');
  await g.waitPhase('MAIN');
  g.c(0).act('play_tool', g.cardId(0, '황금칼'), g.c(2).id);
  const ok = await within(() => targetIs(g, 2));
  t.expect(ok, '두 번째 공격 허용');
  block(g, 2, '골든 레코드');
  await g.waitPhase('MAIN');
});

scenario('난투: 두 공격이 동시에 들어오면 하나만 처리되고 다른 무기는 패에 남는다', { card: '난투', rule: R_BRAWL }, async (t) => {
  const g = await t.game({ players: 4, hands: { 1: ['성정'], 2: ['황금칼'] }, deck: ['난투'] });
  await startBrawl(g);
  g.c(1).act('play_tool', g.cardId(1, '성정'), g.c(3).id);
  g.c(2).act('play_tool', g.cardId(2, '황금칼'), g.c(0).id);
  await g.waitPhase('WAITING_FOR_DEFENSE');
  await flush(g, 1);
  await flush(g, 2);
  const first = g.indexOf(pending(g)?.initiatorId);
  const loser = first === 1 ? 2 : 1;
  t.note(`먼저 처리된 공격: ${first}번`);
  t.expectEq(g.p(loser).hand.weapons.length, 1, `거부된 ${loser}번의 무기는 패에 남아야 함`);
  const victim = g.indexOf(pending(g)?.targetId);
  g.c(victim).act('skip_defense');
  await g.waitFor(() => !g.p(victim).isAlive, '피격자 사망');
  await g.waitPhase('MAIN');
  const loserTarget = loser === 1 ? 3 : 0;
  g.c(loser).act('play_tool', g.p(loser).hand.weapons[0].id, g.c(loserTarget).id);
  const ok = await within(() => targetIs(g, loserTarget));
  t.expect(ok, '거부됐던 무기로 다시 공격할 수 있어야 함');
});

scenario('난투: 죽은 자는 무기를 쓸 수 없다', { card: '난투', rule: R_BRAWL }, async (t) => {
  const g = await t.game({ players: 3, hands: { 2: ['성정'] }, dead: [2], deck: ['난투'] });
  await startBrawl(g);
  g.c(2).act('play_tool', g.cardId(2, '성정'), g.c(1).id);
  await flush(g, 2);
  t.expectEq(g.room.phase, 'MAIN', '죽은 자 공격 거부');
  t.expect(g.p(1).isAlive, '1번 생존');
  t.expectEq(g.hand(2), ['성정'], '성정은 그대로');
});

scenario('난투: 차례 주인이 다른 생존자의 공격으로 죽으면 다음 생존자에게 차례가 넘어간다', { card: '난투', rule: R_BRAWL_DETAIL }, async (t) => {
  const g = await t.game({ players: 4, hands: { 2: ['성정'] }, deck: ['난투'] });
  await startBrawl(g);
  await attack(g, 2, '성정', 0);
  g.c(0).act('skip_defense');
  await g.waitFor(() => !g.p(0).isAlive, '0번 사망');
  const passed = await within(() => g.room.phase === 'MAIN' && g.room.currentTurnPlayerId === g.c(1).id);
  t.expect(passed, `차례가 1번에게 넘어가야 함 (현재: ${who(g, g.room.currentTurnPlayerId)})`);
});

scenario('난투: 차례가 넘어가면 다시 차례·횟수 제한이 적용된다', { card: '난투', rule: R_BRAWL_DETAIL }, async (t) => {
  const g = await t.game({ players: 3, hands: { 2: ['성정'] }, deck: ['난투'] });
  await startBrawl(g);
  g.c(0).act('end_turn');
  await g.waitFor(() => g.room.currentTurnPlayerId === g.c(1).id, '1번 차례');
  t.expect(!g.room.freeForAll, '난투 해제');
  g.c(2).act('play_tool', g.cardId(2, '성정'), g.c(0).id);
  await flush(g, 2);
  t.expectEq(g.room.phase, 'MAIN', '난투가 끝난 뒤 차례 밖 공격은 거부');
  t.expectEq(g.hand(2), ['성정'], '성정은 그대로');
});

scenario('난투: 덱이 바닥나 게임이 끝난 뒤에는 무기 공격이 일어나지 않는다', { card: '난투', rule: `${R_BRAWL_DETAIL} (게임 종료 후에는 어떤 행동도 상태를 바꾸면 안 됨)` }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['성정'] }, deck: ['난투'], filler: 0 });
  await startBrawl(g);
  g.c(0).act('draw_card'); // 덱이 비어 탈출 성공 → 게임 종료
  await g.waitFor(() => g.room.phase === 'ENDED', '게임 종료');
  await g.settle();
  t.note(`게임 종료 후 freeForAll=${g.room.freeForAll}`);
  g.check();
  g.c(1).act('play_tool', g.cardId(1, '성정'), g.c(2).id);
  await flush(g, 1);
  const phaseAfterAttack = g.room.phase;
  const handAfterAttack = g.hand(1);
  t.note(`게임 종료 후 1번의 공격 직후: phase=${phaseAfterAttack}, 1번 패=[${handAfterAttack.join(', ')}]`);
  if (phaseAfterAttack === 'WAITING_FOR_DEFENSE') {
    g.c(2).act('skip_defense');
    await within(() => g.room.phase !== 'WAITING_FOR_DEFENSE');
    await g.settle();
    t.note(
      `2번 방어 포기 후: phase=${g.room.phase}, 2번 ${g.p(2).isAlive ? '생존' : '사망'}, 현재 차례=${who(g, g.room.currentTurnPlayerId)}, game_over 수신 ${g.c(0).gameOvers.length}회`,
    );
  }
  t.expectEq(phaseAfterAttack, 'ENDED', '게임 종료 후 단계가 바뀌면 안 됨');
  t.expectEq(handAfterAttack, ['성정'], '무기가 소모되면 안 됨');
  t.expect(g.p(2).isAlive, '게임 종료 후 사망자가 생기면 안 됨');
});
