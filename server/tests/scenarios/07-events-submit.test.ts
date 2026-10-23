import { scenario, ScenarioApi } from '../harness/runner';
import type { GameCtx, GameOptions } from '../harness/game';

// 07: 카드 제출형 이벤트 — 무장해제, 면죄부, 고해성사, 룰렛, 마육검
// 규칙(card.json)대로의 동작을 단언합니다. 실패 = 현재 구현이 규칙과 다름.

// ── 규칙 원문 ────────────────────────────────────────────────────────
const R = {
  무장해제: '자신의 패에서 무기를 1장 버리면 자신의 악의를 1장 버릴 수 있습니다. 원하는 생존자는 모두 가능합니다.',
  무장해제1: '[1] 1회만 가능합니다.',
  무장해제2: '[2] 악의가 포함된 특수 도구(누군가의 뼈 등)는 단독으로 낼 수 없고, 다른 카드(무기 또는 악의)와 함께 섞어 내야 합니다.',
  뼈: '(누군가의 뼈) 이벤트(무장해제 등)에 제출 시, 이 카드 단독(무기+악의 동시 1장 취급)으로는 불가능하며 다른 무기 카드 혹은 악의 카드와 섞어서 제출해야 합니다.',
  면죄부: '자신의 패에서 보물 1장을 버리면 자신의 악의 1장을 버릴 수 있습니다. 원하는 생존자는 모두 가능합니다.',
  면죄부1: '[1] 1회만 가능합니다.',
  면죄부2: '[2] 악의가 포함된 특수 도구(누군가의 로켓 등)는 단독으로 낼 수 없고, 다른 카드(보물 또는 악의)와 함께 섞어 내야 합니다.',
  로켓: '(누군가의 로켓) 이벤트(면죄부 등)에 제출 시, 이 카드 단독(보물+악의 동시 1장 취급)으로는 불가능하며 다른 보물 카드 혹은 악의 카드와 섞어서 제출해야 합니다.',
  고해: '자신의 패에서 악의 3장을 공개하면 자신의 악의 1장을 버릴 수 있습니다. 원하는 생존자는 모두 가능합니다.',
  고해1: '1회만 가능합니다.',
  룰렛: '카드를 가진 생존자들만 참여해 자신의 패에서 원하는 카드를 1장씩 뒤집어서 냅니다. 낸 카드를 섞어 1장씩 다시 나눠갖고 무기를 가지게 된 자는 방패로 막지 못하면 죽습니다.',
  룰렛상세: '무기를 뽑게 된 것은 생존자가 카드를 확인 후 직접 말하여 공개해야 합니다.',
  마육검: '이 검을 얻고 싶은 생존자들은 동시에 악의를 공개합니다. 악의를 가장 많이 공개한 생존자가 검의 주인이 됩니다. 얻는 즉시 사용할 수 있습니다. 즉시 사용치 않으면 패에 넣고 일반 무기가 됩니다.',
  마육검상세: "획득하여 '즉시' 사용할 때만 무기 공격 횟수를 소모하지 않습니다.",
  짙은: '(짙은 악의) 이 악의는 악의 2장입니다. … 악의를 버리거나 카드를 낼 때는 1장으로 취급합니다. (패에 들고 있을 때만 악의 2장으로 산정)',
  침묵: '(침묵) 이 카드를 사용하면 한 생존자를 선택해 이번 차례에 도구를 못 내게 합니다. … 이벤트 진행 중 제출해야 하는 도구 역시 낼 수 없게 됩니다.',
  긴급: '(긴급탈출키트) 이 카드를 사용하면 이벤트를 한 개 취소합니다. … 즉시 발동하여 현재 진행 중인 이벤트의 효과를 완전히 무효화합니다.',
  황금방패: '(황금 방패) 다른 생존자가 무기로 공격할 때 차례와 관계없이 즉시 막을 수 있으며, 사용 후 버립니다.',
  눈없는: '(눈 없는 괴물) 소리를 낸 생존자는 즉시 죽습니다.',
};

// ── 도우미 ──────────────────────────────────────────────────────────

/**
 * 시나리오 러너는 불변식을 시나리오 끝에서 한 번만 검사하므로(runner.ts),
 * 이 파일에서는 5ms마다 g.check()를 돌려 중간 상태의 위반도 기록합니다.
 */
async function newGame(t: ScenarioApi, opts: GameOptions): Promise<GameCtx> {
  const g = await t.game(opts);
  const room = g.room;
  const timer = setInterval(() => {
    if (g.srv.rooms.get(g.code) !== room || room.phase === 'WAITING') {
      clearInterval(timer);
      return;
    }
    try {
      g.check();
    } catch {
      clearInterval(timer);
    }
  }, 5);
  timer.unref?.();
  return g;
}

const pa = (g: GameCtx): any => g.room.pendingAction as any;
const sorted = (a: string[]) => [...a].sort();
const inGrave = (g: GameCtx, name: string) => g.room.graveyard.some((c) => c.name === name);
const alive = (g: GameCtx) => g.clients.map((_, i) => i).filter((i) => g.p(i).isAlive);

/** i번이 카드를 뽑고 events_triggered를 받을 때까지 기다립니다. */
async function drawEvent(g: GameCtx, i = 0): Promise<void> {
  const before = g.c(i).eventsOf('events_triggered').length;
  g.c(i).act('draw_card');
  await g.waitFor(() => g.c(i).eventsOf('events_triggered').length > before, `${g.c(i).name} 이벤트 발동`);
}

async function startSubmission(g: GameCtx, event: string, drawer = 0): Promise<void> {
  g.c(drawer).act('draw_card');
  await g.waitFor(() => pa(g)?.type === 'CARD_SUBMISSION' && pa(g)?.eventName === event, `${event} 카드 제출 단계`);
}

/** i번 패의 카드 이름 목록으로 제출 (id는 제출 직전 패에서 찾음) */
function sub(g: GameCtx, i: number, names: string[]): void {
  const ids = names.map((n) => g.cardId(i, n));
  g.c(i).act('submit_cards', ids);
}

function skip(g: GameCtx, i: number): void {
  g.c(i).act('submit_cards', []);
}

async function responded(g: GameCtx, i: number): Promise<void> {
  await g.waitFor(() => !pa(g) || !!pa(g).responses?.[g.c(i).id], `${g.c(i).name} 응답 반영`);
}

/** 이벤트가 끝난 뒤 뽑은 자가 다시 뽑을 수 있어야 합니다 (이벤트는 드로우로 치지 않음). */
async function drawAgain(t: ScenarioApi, g: GameCtx, i = 0): Promise<void> {
  t.expectEq(g.room.currentTurnPlayerId, g.c(i).id, `이벤트 후에도 ${g.c(i).name}의 차례여야 함`);
  t.expect(!g.p(i).hasDrawnThisTurn, `이벤트 후 ${g.c(i).name}은(는) 아직 뽑지 않은 상태여야 함`);
  g.c(i).act('draw_card');
  await g.waitFor(() => g.p(i).hasDrawnThisTurn, `${g.c(i).name} 다시 뽑기`);
}

/** 고해성사: 뽑은 뒤 (서버가 선택 창을 연다면) choices대로 응답하고 이벤트 종료까지 대기. null = 버리지 않음 */
async function runConfession(g: GameCtx, choices: Record<number, string | null>, drawer = 0): Promise<boolean> {
  await drawEvent(g, drawer);
  await g.settle();
  const windowOpened = g.room.phase !== 'MAIN';
  if (windowOpened) {
    for (const [k, name] of Object.entries(choices)) {
      const i = Number(k);
      g.c(i).act('submit_cards', name ? [g.cardId(i, name)] : []);
    }
  }
  await g.waitPhase('MAIN', 4000);
  await g.settle();
  return windowOpened;
}

/** 룰렛 방어 단계에서 현재 피격자 번호 */
async function rouletteVictim(g: GameCtx, exclude: number[] = []): Promise<number> {
  await g.waitFor(
    () => g.room.phase === 'WAITING_FOR_DEFENSE' && !!pa(g)?.targetId && !exclude.includes(g.indexOf(pa(g).targetId)),
    '룰렛 방어 단계',
  );
  return g.indexOf(pa(g).targetId);
}

async function waitMayukChoice(g: GameCtx): Promise<number> {
  await g.waitFor(() => pa(g)?.eventName === '마육검' && pa(g)?.type === 'TARGET_SELECTION', '마육검 낙찰자 결정');
  return g.indexOf(pa(g).initiatorId);
}

function anyoneHas(g: GameCtx, name: string): boolean {
  return g.clients.some((_, i) => g.hand(i).includes(name));
}

// ══════════════════════════════════════════════════════════════════════
// 무장해제
// ══════════════════════════════════════════════════════════════════════

scenario('무장해제: 무기 1장과 악의 1장을 내면 둘 다 무덤으로 가고 악의가 줄어든다', { card: '무장해제', rule: R.무장해제 }, async (t) => {
  const g = await newGame(t, { players: 3, hands: { 1: ['성정', '시선', '코인'] }, deck: ['무장해제'] });
  await startSubmission(g, '무장해제');
  const req = g.requests(1, 'request_cards').at(-1);
  t.expectEq(req, ['무장해제', 2], '모든 생존자에게 2장 제출 요청');
  t.expectEq(g.p(1).currentMalice, 1, '전제: 악의 1점');
  sub(g, 1, ['시선', '성정']); // 악의를 먼저, 무기를 나중에 골라도 됨
  await responded(g, 1);
  skip(g, 0);
  skip(g, 2);
  await g.waitPhase('MAIN');
  t.expectEq(g.hand(1), ['코인'], '성정과 시선이 패에서 빠짐');
  t.expect(inGrave(g, '성정') && inGrave(g, '시선'), '버린 두 장은 무덤으로');
  t.expectEq(g.p(1).currentMalice, 0, '악의 0점으로 재계산');
  await drawAgain(t, g, 0);
});

scenario('무장해제: 원하는 생존자는 모두 각자 버릴 수 있고, 모두 응답하면 바로 끝난다', { card: '무장해제', rule: R.무장해제 }, async (t) => {
  const g = await newGame(t, {
    players: 3,
    hands: { 0: ['성정', '시선'], 1: ['황금칼', '흑역사'], 2: ['십자가#201', '상처', '코인'] },
    deck: ['무장해제'],
  });
  await startSubmission(g, '무장해제');
  sub(g, 0, ['성정', '시선']);
  sub(g, 1, ['황금칼', '흑역사']);
  sub(g, 2, ['십자가', '상처']);
  await g.waitPhase('MAIN', 1000); // 제한시간(1.5초)을 기다리지 않고 즉시 끝나야 함
  t.expectEq([g.hand(0), g.hand(1), g.hand(2)], [[], [], ['코인']], '세 명 모두 무기+악의를 버림');
  t.expectEq(g.room.graveyard.filter((c) => c.name !== '무장해제').length, 6, '버린 6장이 무덤에');
});

scenario('무장해제: 1회만 가능 — 두 번째 제출은 무시된다', { card: '무장해제', rule: R.무장해제1 }, async (t) => {
  const g = await newGame(t, { players: 3, hands: { 1: ['성정', '황금칼', '시선', '흑역사'] }, deck: ['무장해제'] });
  await startSubmission(g, '무장해제');
  sub(g, 1, ['성정', '시선']);
  await responded(g, 1);
  sub(g, 1, ['황금칼', '흑역사']);
  await g.settle();
  skip(g, 0);
  skip(g, 2);
  await g.waitPhase('MAIN');
  t.expectEq(sorted(g.hand(1)), sorted(['황금칼', '흑역사']), '두 번째 조합은 버려지지 않음');
});

scenario('무장해제: 누군가의 뼈는 단독으로 낼 수 없다', { card: '무장해제', rule: R.무장해제2 + ' / ' + R.뼈 }, async (t) => {
  const g = await newGame(t, { players: 3, hands: { 1: ['누군가의 뼈', '코인'], 2: ['누군가의 뼈'] }, deck: ['무장해제'] });
  await startSubmission(g, '무장해제');
  const bone1 = g.cardId(1, '누군가의 뼈');
  g.c(1).act('submit_cards', [bone1]); // 1장만
  g.c(2).act('submit_cards', [g.cardId(2, '누군가의 뼈'), g.cardId(2, '누군가의 뼈')]); // 같은 카드 두 번 (무기+악의 1장 취급 시도)
  skip(g, 0);
  await g.waitPhase('MAIN', 4000);
  t.expect(g.hand(1).includes('누군가의 뼈'), '나래의 누군가의 뼈는 패에 남아야 함');
  t.expect(g.hand(2).includes('누군가의 뼈'), '다온의 누군가의 뼈는 패에 남아야 함');
  t.expect(!inGrave(g, '누군가의 뼈'), '무덤에 누군가의 뼈가 없어야 함');
});

scenario('무장해제: 누군가의 뼈는 다른 무기와 섞어 낼 수 있다', { card: '무장해제', rule: R.무장해제2 + ' / ' + R.뼈 }, async (t) => {
  const g = await newGame(t, { players: 3, hands: { 1: ['성정', '누군가의 뼈', '코인'] }, deck: ['무장해제'] });
  await startSubmission(g, '무장해제');
  sub(g, 1, ['성정', '누군가의 뼈']);
  await responded(g, 1);
  skip(g, 0);
  skip(g, 2);
  await g.waitPhase('MAIN');
  t.expectEq(g.hand(1), ['코인'], '성정 + 누군가의 뼈(악의로 취급) 둘 다 버려짐');
  t.expectEq(g.p(1).currentMalice, 0, '악의 0점');
});

scenario('무장해제: 누군가의 뼈는 악의 카드와 섞어 낼 수 있다', { card: '무장해제', rule: R.무장해제2 + ' / ' + R.뼈 }, async (t) => {
  const g = await newGame(t, { players: 3, hands: { 1: ['누군가의 뼈', '시선', '코인'] }, deck: ['무장해제'] });
  await startSubmission(g, '무장해제');
  t.expectEq(g.p(1).currentMalice, 2, '전제: 악의 2점');
  sub(g, 1, ['시선', '누군가의 뼈']);
  await responded(g, 1);
  skip(g, 0);
  skip(g, 2);
  await g.waitPhase('MAIN');
  t.expectEq(g.hand(1), ['코인'], '누군가의 뼈(무기로 취급) + 시선 둘 다 버려짐');
  t.expectEq(g.p(1).currentMalice, 0, '악의 0점');
});

scenario('무장해제: 무기가 없는 조합(악의 2장, 보물 십자가+악의)은 버려지지 않는다', { card: '무장해제', rule: R.무장해제 }, async (t) => {
  const g = await newGame(t, { players: 3, hands: { 1: ['시선', '흑역사'], 2: ['십자가#502', '상처'] }, deck: ['무장해제'] });
  await startSubmission(g, '무장해제');
  sub(g, 1, ['시선', '흑역사']);
  sub(g, 2, ['십자가', '상처']);
  skip(g, 0);
  await g.waitPhase('MAIN', 4000);
  t.expectEq(sorted(g.hand(1)), sorted(['시선', '흑역사']), '악의 2장은 그대로');
  t.expectEq(sorted(g.hand(2)), sorted(['십자가', '상처']), '보물 십자가(#502)는 무기가 아니므로 그대로');
});

scenario('무장해제: 짙은 악의는 1장으로 취급되어 무기 1장과 함께 버릴 수 있다', { card: '무장해제', rule: R.무장해제 + ' / ' + R.짙은 }, async (t) => {
  const g = await newGame(t, { players: 3, hands: { 1: ['성정', '짙은 악의', '시선'] }, deck: ['무장해제'] });
  await startSubmission(g, '무장해제');
  t.expectEq([g.p(1).currentMalice, g.p(1).alignment], [3, 'EVIL'], '전제: 악의 3점 악인');
  sub(g, 1, ['성정', '짙은 악의']);
  await responded(g, 1);
  skip(g, 0);
  skip(g, 2);
  await g.waitPhase('MAIN');
  t.expectEq(g.hand(1), ['시선'], '짙은 악의 1장이 무기 1장과 함께 버려짐');
  t.expectEq([g.p(1).currentMalice, g.p(1).alignment], [1, 'GOOD'], '악의 1점, 선인으로 복귀');
  t.expect(inGrave(g, '짙은 악의'), '짙은 악의는 무덤으로');
});

scenario('무장해제: 죽은 자와 남의 카드로는 버릴 수 없고, 생존자 전원 응답 시 바로 끝난다', { card: '무장해제', rule: R.무장해제 }, async (t) => {
  const g = await newGame(t, { players: 4, dead: [3], hands: { 2: ['성정', '시선'], 3: ['황금칼', '흑역사'] }, deck: ['무장해제'] });
  await startSubmission(g, '무장해제');
  g.c(3).act('submit_cards', [g.cardId(3, '황금칼'), g.cardId(3, '흑역사')]); // 죽은 라온
  g.c(1).act('submit_cards', [g.cardId(2, '성정'), g.cardId(2, '시선')]); // 나래가 다온의 카드 id로
  await responded(g, 1);
  skip(g, 0);
  skip(g, 2);
  await g.waitPhase('MAIN', 1000);
  t.expectEq(sorted(g.hand(3)), sorted(['황금칼', '흑역사']), '죽은 라온의 패는 그대로');
  t.expectEq(sorted(g.hand(2)), sorted(['성정', '시선']), '다온의 카드는 나래가 버릴 수 없음');
});

scenario('무장해제: 아무도 응답하지 않으면 제한시간 후 끝나고 뽑은 자가 다시 뽑는다', { card: '무장해제', rule: R.무장해제 }, async (t) => {
  const g = await newGame(t, { players: 3, hands: { 1: ['성정', '시선'] }, deck: ['무장해제'] });
  await startSubmission(g, '무장해제');
  await g.settle();
  t.expectEq(g.room.phase, 'RESOLVING_EVENT', '응답 전에는 이벤트 진행 중');
  await g.waitServerMs(30000);
  await g.waitPhase('MAIN', 3000);
  t.expectEq(sorted(g.hand(1)), sorted(['성정', '시선']), '응답하지 않은 생존자의 패는 그대로');
  await drawAgain(t, g, 0);
});

scenario('무장해제: 침묵에 걸린 생존자는 무기(도구)를 낼 수 없다', { card: '무장해제', rule: R.무장해제 + ' / ' + R.침묵 }, async (t) => {
  const g = await newGame(t, { players: 3, hands: { 0: ['황금칼', '성정', '시선'], 1: [], 2: ['침묵'] }, deck: ['무장해제'] });
  // 가람이 뽑기 전에 나래를 공격 → 다온이 침묵으로 무효화 → 가람은 이번 차례 침묵 상태
  g.c(0).act('play_tool', g.cardId(0, '황금칼'), g.c(1).id);
  await g.waitPhase('WAITING_FOR_DEFENSE');
  g.c(2).act('interrupt_action', g.cardId(2, '침묵'), g.c(0).id);
  await g.waitPhase('MAIN');
  t.expect(g.p(0).isSilenced, '전제: 가람이 침묵 상태');
  await startSubmission(g, '무장해제');
  sub(g, 0, ['성정', '시선']);
  await responded(g, 0);
  skip(g, 1);
  skip(g, 2);
  await g.waitPhase('MAIN', 4000);
  t.expectEq(sorted(g.hand(0)), sorted(['성정', '시선']), '침묵 상태에서는 무기를 제출할 수 없어 패가 그대로여야 함');
});

scenario('무장해제: 잘못된 조합을 내면 기회를 잃는가, 다시 낼 수 있는가', {
  card: '무장해제',
  rule: R.무장해제 + ' ' + R.무장해제1,
  ambiguous: '무장해제에서 규칙에 맞지 않는 조합(예: 무기+보물)을 냈을 때, 그것을 "1회"로 보고 기회를 잃게 하나요, 아니면 거절하고 올바른 조합으로 다시 낼 수 있게 하나요?',
}, async (t) => {
  const g = await newGame(t, { players: 3, hands: { 1: ['성정', '코인', '시선'] }, deck: ['무장해제'] });
  await startSubmission(g, '무장해제');
  sub(g, 1, ['성정', '코인']);
  await g.settle();
  t.note(`잘못된 조합 제출 직후: 응답 기록=${JSON.stringify(pa(g)?.responses?.[g.c(1).id] ?? null)}, 알림="${g.msgs(1).filter((m) => m.includes('무장해제')).at(-1) ?? ''}"`);
  sub(g, 1, ['성정', '시선']);
  await g.settle();
  skip(g, 0);
  skip(g, 2);
  await g.waitPhase('MAIN', 4000);
  t.note(`올바른 조합 재제출 후 나래 패: [${g.hand(1).join(', ')}]`);
  t.expectEq(g.hand(1), ['코인'], '재제출이 받아들여졌다면 성정+시선이 버려짐');
});

scenario('무장해제: 긴급탈출키트로 취소하면 이미 버린 카드도 되돌아오는가', {
  card: '무장해제',
  rule: R.무장해제 + ' / ' + R.긴급,
  ambiguous: '무장해제 도중 누군가 이미 무기+악의를 버린 뒤 다른 생존자가 긴급탈출키트로 이벤트를 취소하면, 이미 버린 카드도 패로 되돌아오나요(완전히 무효화), 아니면 버린 것은 그대로인가요?',
}, async (t) => {
  const g = await newGame(t, { players: 3, hands: { 1: ['성정', '시선'], 2: ['긴급탈출키트'] }, deck: ['무장해제'] });
  await startSubmission(g, '무장해제');
  sub(g, 1, ['성정', '시선']);
  await responded(g, 1);
  g.c(2).act('interrupt_action', g.cardId(2, '긴급탈출키트'));
  await g.waitPhase('MAIN');
  await g.settle();
  t.note(`키트 사용 후 나래 패: [${g.hand(1).join(', ')}], 무덤: [${g.room.graveyard.map((c) => c.name).join(', ')}]`);
  t.expectEq(sorted(g.hand(1)), sorted(['성정', '시선']), '완전히 무효화된다면 버린 카드가 돌아옴');
});

// ══════════════════════════════════════════════════════════════════════
// 면죄부
// ══════════════════════════════════════════════════════════════════════

scenario('면죄부: 보물 1장과 악의 1장을 내면 둘 다 무덤으로 가고 악의가 줄어든다', { card: '면죄부', rule: R.면죄부 }, async (t) => {
  const g = await newGame(t, { players: 3, hands: { 1: ['코인', '시선', '성정'] }, deck: ['면죄부'] });
  await startSubmission(g, '면죄부');
  t.expectEq(g.requests(2, 'request_cards').at(-1), ['면죄부', 2], '모든 생존자에게 2장 제출 요청');
  sub(g, 1, ['코인', '시선']);
  await responded(g, 1);
  skip(g, 0);
  skip(g, 2);
  await g.waitPhase('MAIN');
  t.expectEq(g.hand(1), ['성정'], '코인과 시선이 패에서 빠짐');
  t.expect(inGrave(g, '코인') && inGrave(g, '시선'), '버린 두 장은 무덤으로');
  t.expectEq(g.p(1).currentMalice, 0, '악의 0점');
  await drawAgain(t, g, 0);
});

scenario('면죄부: 원하는 생존자는 모두 가능하고 각자 1회만 가능하다', { card: '면죄부', rule: R.면죄부 + ' ' + R.면죄부1 }, async (t) => {
  const g = await newGame(t, { players: 3, hands: { 0: ['성배', '흑역사'], 1: ['코인', '시선', '복권', '상처'] }, deck: ['면죄부'] });
  await startSubmission(g, '면죄부');
  sub(g, 0, ['흑역사', '성배']);
  sub(g, 1, ['코인', '시선']);
  await responded(g, 1);
  sub(g, 1, ['복권', '상처']); // 두 번째 시도
  await g.settle();
  skip(g, 2);
  await g.waitPhase('MAIN', 1000);
  t.expectEq(g.hand(0), [], '가람은 성배+흑역사를 버림');
  t.expectEq(sorted(g.hand(1)), sorted(['복권', '상처']), '나래는 1회만 버릴 수 있음');
});

scenario('면죄부: 누군가의 로켓은 단독으로 낼 수 없다', { card: '면죄부', rule: R.면죄부2 + ' / ' + R.로켓 }, async (t) => {
  const g = await newGame(t, { players: 3, hands: { 1: ['누군가의 로켓', '성정'], 2: ['누군가의 로켓'] }, deck: ['면죄부'] });
  await startSubmission(g, '면죄부');
  g.c(1).act('submit_cards', [g.cardId(1, '누군가의 로켓')]);
  g.c(2).act('submit_cards', [g.cardId(2, '누군가의 로켓'), g.cardId(2, '누군가의 로켓')]);
  skip(g, 0);
  await g.waitPhase('MAIN', 4000);
  t.expect(g.hand(1).includes('누군가의 로켓'), '나래의 로켓은 패에 남아야 함');
  t.expect(g.hand(2).includes('누군가의 로켓'), '다온의 로켓은 패에 남아야 함');
});

scenario('면죄부: 누군가의 로켓은 다른 보물과 섞어 낼 수 있다', { card: '면죄부', rule: R.면죄부2 + ' / ' + R.로켓 }, async (t) => {
  const g = await newGame(t, { players: 3, hands: { 1: ['코인', '누군가의 로켓', '성정'] }, deck: ['면죄부'] });
  await startSubmission(g, '면죄부');
  sub(g, 1, ['코인', '누군가의 로켓']);
  await responded(g, 1);
  skip(g, 0);
  skip(g, 2);
  await g.waitPhase('MAIN');
  t.expectEq(g.hand(1), ['성정'], '코인 + 누군가의 로켓(악의로 취급) 둘 다 버려짐');
  t.expectEq(g.p(1).currentMalice, 0, '악의 0점');
});

scenario('면죄부: 누군가의 로켓은 악의 카드와 섞어 낼 수 있다', { card: '면죄부', rule: R.면죄부2 + ' / ' + R.로켓 }, async (t) => {
  const g = await newGame(t, { players: 3, hands: { 1: ['누군가의 로켓', '시선', '성정'] }, deck: ['면죄부'] });
  await startSubmission(g, '면죄부');
  sub(g, 1, ['시선', '누군가의 로켓']);
  await responded(g, 1);
  skip(g, 0);
  skip(g, 2);
  await g.waitPhase('MAIN');
  t.expectEq(g.hand(1), ['성정'], '누군가의 로켓(보물로 취급) + 시선 둘 다 버려짐');
  t.expectEq(g.p(1).currentMalice, 0, '악의 0점');
});

scenario('면죄부: 보물 십자가(#502)는 낼 수 있고 무기 십자가(#201)·악의만으로는 낼 수 없다', { card: '면죄부', rule: R.면죄부 }, async (t) => {
  const g = await newGame(t, {
    players: 3,
    hands: { 0: ['시선', '흑역사'], 1: ['십자가#502', '상처'], 2: ['십자가#201', '빈상자'] },
    deck: ['면죄부'],
  });
  await startSubmission(g, '면죄부');
  sub(g, 0, ['시선', '흑역사']);
  sub(g, 1, ['십자가', '상처']);
  sub(g, 2, ['십자가', '빈상자']);
  await g.waitPhase('MAIN', 4000);
  t.expectEq(sorted(g.hand(0)), sorted(['시선', '흑역사']), '악의 2장으로는 면죄부 불가');
  t.expectEq(g.hand(1), [], '보물 십자가 + 상처는 버려짐');
  t.expectEq(sorted(g.hand(2)), sorted(['십자가', '빈상자']), '무기 십자가는 보물이 아님');
});

scenario('면죄부: 짙은 악의는 1장으로 취급되어 보물 1장과 함께 버릴 수 있다', { card: '면죄부', rule: R.면죄부 + ' / ' + R.짙은 }, async (t) => {
  const g = await newGame(t, { players: 3, hands: { 1: ['코인', '짙은 악의', '시선'] }, deck: ['면죄부'] });
  await startSubmission(g, '면죄부');
  sub(g, 1, ['코인', '짙은 악의']);
  await responded(g, 1);
  skip(g, 0);
  skip(g, 2);
  await g.waitPhase('MAIN');
  t.expectEq(g.hand(1), ['시선'], '짙은 악의 1장이 보물 1장과 함께 버려짐');
  t.expectEq([g.p(1).currentMalice, g.p(1).alignment], [1, 'GOOD'], '악의 1점, 선인으로 복귀');
});

// ══════════════════════════════════════════════════════════════════════
// 고해성사
// ══════════════════════════════════════════════════════════════════════

scenario('고해성사: 악의 3장을 가진 생존자가 원하면 악의 1장을 버린다', { card: '고해성사', rule: R.고해 }, async (t) => {
  const g = await newGame(t, { players: 3, hands: { 1: ['시선', '흑역사', '상처'] }, deck: ['고해성사'] });
  t.expectEq(g.p(1).alignment, 'EVIL', '전제: 악의 3점 악인');
  const opened = await runConfession(g, { 1: '상처' });
  t.note(`선택 창(요청) 열림: ${opened}`);
  t.expectEq(g.p(1).hand.malices.length, 2, '악의 1장이 버려짐');
  t.expectEq([g.p(1).currentMalice, g.p(1).alignment], [2, 'GOOD'], '악의 2점, 선인으로 복귀');
  await drawAgain(t, g, 0);
});

scenario('고해성사: 버리는 것은 선택 사항이다 — 원하지 않는 생존자는 악의를 유지한다', { card: '고해성사', rule: R.고해 }, async (t) => {
  const g = await newGame(t, { players: 3, hands: { 1: ['시선', '흑역사', '상처'], 2: ['계시', '암전', '탐욕'] }, deck: ['고해성사'] });
  // 나래는 명시적으로 거절, 다온은 응답하지 않음 (악인으로 남고 싶은 경우)
  const opened = await runConfession(g, { 1: null });
  t.note(`선택 창(요청) 열림: ${opened}, 나래 요청 수: ${g.requests(1, 'request_cards').length}`);
  t.expectEq(sorted(g.hand(1)), sorted(['시선', '흑역사', '상처']), '거절한 나래의 악의는 그대로');
  t.expectEq(sorted(g.hand(2)), sorted(['계시', '암전', '탐욕']), '응답하지 않은 다온의 악의는 그대로');
});

scenario('고해성사: 버릴 악의는 본인이 고른다', { card: '고해성사', rule: R.고해 + " ('자신의 악의 1장')" }, async (t) => {
  const g = await newGame(t, { players: 3, hands: { 1: ['시선', '흑역사', '상처'] }, deck: ['고해성사'] });
  await runConfession(g, { 1: '시선' });
  t.expectEq(sorted(g.hand(1)), sorted(['흑역사', '상처']), '나래가 고른 시선이 버려져야 함');
});

scenario('고해성사: 버린 악의는 무덤으로 간다', { card: '고해성사', rule: R.고해 }, async (t) => {
  const g = await newGame(t, { players: 3, hands: { 1: ['시선', '흑역사', '상처'] }, deck: ['고해성사'] });
  await runConfession(g, { 1: '상처' });
  const left = g.hand(1);
  const gone = ['시선', '흑역사', '상처'].filter((n) => !left.includes(n));
  t.expectEq(gone.length, 1, '1장 버려짐');
  t.expect(inGrave(g, gone[0]), `버린 [${gone[0]}]이(가) 무덤에 있어야 함 (무덤: ${g.room.graveyard.map((c) => c.name).join(', ')})`);
});

scenario('고해성사: 악의가 2장 이하인 생존자는 버릴 수 없다', { card: '고해성사', rule: R.고해 }, async (t) => {
  const g = await newGame(t, { players: 3, hands: { 1: ['시선', '흑역사'], 2: ['상처'] }, deck: ['고해성사'] });
  await runConfession(g, { 1: '시선', 2: '상처' });
  t.expectEq(sorted(g.hand(1)), sorted(['시선', '흑역사']), '악의 2장은 그대로');
  t.expectEq(g.hand(2), ['상처'], '악의 1장은 그대로');
});

scenario('고해성사: 1회만 — 악의가 5장이어도 1장만 버린다', { card: '고해성사', rule: R.고해1 }, async (t) => {
  const g = await newGame(t, { players: 3, hands: { 1: ['시선', '흑역사', '상처', '계시', '암전'] }, deck: ['고해성사'] });
  await runConfession(g, { 1: '암전' });
  t.expectEq(g.p(1).hand.malices.length, 4, '1장만 버려짐');
});

scenario('고해성사: 여러 생존자가 각자 1장씩 버릴 수 있고 죽은 자는 참여하지 않는다', { card: '고해성사', rule: R.고해 }, async (t) => {
  const g = await newGame(t, {
    players: 4,
    dead: [3],
    hands: { 0: ['시선', '흑역사', '상처'], 1: ['계시', '암전', '탐욕'], 2: ['질투'], 3: ['빈상자', '코즈믹 호러', '어제의 동료'] },
    deck: ['고해성사'],
  });
  await runConfession(g, { 0: '상처', 1: '탐욕' });
  t.expectEq(g.p(0).hand.malices.length, 2, '가람(뽑은 자)도 1장 버림');
  t.expectEq(g.p(1).hand.malices.length, 2, '나래도 1장 버림');
  t.expectEq(g.p(3).hand.malices.length, 3, '죽은 라온은 참여하지 않음');
});

scenario('고해성사: 짙은 악의를 버리면 1장으로 취급되어 악의 2점이 줄어든다', { card: '고해성사', rule: R.고해 + ' / ' + R.짙은 }, async (t) => {
  const g = await newGame(t, { players: 3, hands: { 1: ['시선', '흑역사', '짙은 악의'] }, deck: ['고해성사'] });
  t.expectEq(g.p(1).currentMalice, 4, '전제: 악의 4점');
  await runConfession(g, { 1: '짙은 악의' });
  t.expectEq(sorted(g.hand(1)), sorted(['시선', '흑역사']), '짙은 악의 1장이 버려짐');
  t.expectEq([g.p(1).currentMalice, g.p(1).alignment], [2, 'GOOD'], '악의 2점, 선인으로 복귀');
});

scenario('고해성사: 짙은 악의 + 악의 1장은 "악의 3장"인가', {
  card: '고해성사',
  rule: R.고해 + ' / ' + R.짙은,
  ambiguous: '짙은 악의(패에서 악의 2장으로 산정) 1장과 일반 악의 1장, 총 2장의 카드를 가진 생존자는 고해성사의 "악의 3장을 공개"를 충족하나요? (공개는 "낼 때"에 해당해 1장으로 세나요, 패 안의 산정처럼 2장으로 세나요?)',
}, async (t) => {
  const g = await newGame(t, { players: 3, hands: { 1: ['짙은 악의', '시선'] }, deck: ['고해성사'] });
  await runConfession(g, { 1: '시선' });
  t.note(`현재 동작: 나래 패 [${g.hand(1).join(', ')}] (서버는 악의 카드 장수(hand.malices.length)로만 판단 → 2장이라 대상 아님)`);
  t.expectEq(g.hand(1), ['짙은 악의'], '짙은 악의를 2장으로 센다면 시선을 버릴 수 있음');
});

scenario('고해성사: 누군가의 뼈·로켓 등 악의 겸 도구도 "악의 3장"에 포함되는가', {
  card: '고해성사',
  rule: R.고해 + ' / (누군가의 뼈) 이 무기는 악의인 동시에 무기입니다.',
  ambiguous: '악의 카드 2장 + 누군가의 뼈(악의인 동시에 무기) 1장을 가진 생존자는 고해성사의 "악의 3장을 공개"를 충족하나요? 충족한다면 버릴 수 있는 "악의 1장"에 누군가의 뼈도 포함되나요?',
}, async (t) => {
  const g = await newGame(t, { players: 3, hands: { 1: ['시선', '흑역사', '누군가의 뼈'] }, deck: ['고해성사'] });
  t.expectEq(g.p(1).currentMalice, 3, '전제: 악의 3점');
  await runConfession(g, { 1: '시선' });
  t.note(`현재 동작: 나래 패 [${g.hand(1).join(', ')}] (서버는 hand.malices만 셈 → 누군가의 뼈 제외 2장)`);
  t.expectEq(sorted(g.hand(1)), sorted(['흑역사', '누군가의 뼈']), '포함된다면 시선을 버릴 수 있음');
});

// ══════════════════════════════════════════════════════════════════════
// 룰렛
// ══════════════════════════════════════════════════════════════════════

scenario('룰렛: 카드를 가진 생존자만 1장씩 내고, 모두 내면 섞어서 1장씩 돌려받는다', { card: '룰렛', rule: R.룰렛 }, async (t) => {
  const g = await newGame(t, { players: 3, hands: { 0: ['코인', '성배'], 1: ['시선'] }, deck: ['룰렛'] });
  await startSubmission(g, '룰렛');
  t.expectEq(g.requests(1, 'request_cards').at(-1), ['룰렛', 1], '1장 제출 요청');
  sub(g, 0, ['코인']);
  sub(g, 1, ['시선']);
  // 다온은 카드가 없으므로 참여하지 않음 → 기다리지 않고 바로 분배
  await g.waitPhase('MAIN', 1000);
  t.expectEq(g.hand(0).length, 2, '가람: 성배 + 받은 1장');
  t.expectEq(g.hand(1).length, 1, '나래: 받은 1장');
  t.expectEq(g.hand(2).length, 0, '다온: 참여하지 않음');
  const got = [...g.hand(0).filter((n) => n !== '성배'), ...g.hand(1)];
  t.expectEq(sorted(got), sorted(['코인', '시선']), '낸 카드가 1장씩 재분배됨');
  // 뒤집어서 낸 카드 — 받은 사람 외에는 무엇을 받았는지 알림을 받지 않아야 함
  const coinOwner = g.hand(0).includes('코인') ? 0 : 1;
  const leaked = [0, 1, 2].filter((i) => i !== coinOwner && g.msgs(i).some((m) => m.includes('[코인]')));
  t.expectEq(leaked, [], '코인을 받지 않은 사람에게 [코인] 알림이 가지 않아야 함');
  await drawAgain(t, g, 0);
});

scenario('룰렛: 여러 장을 보내도 1장만 제출된다', { card: '룰렛', rule: R.룰렛 }, async (t) => {
  const g = await newGame(t, { players: 3, hands: { 0: ['코인', '성배', '복권'], 1: ['시선'] }, deck: ['룰렛'] });
  await startSubmission(g, '룰렛');
  sub(g, 0, ['코인', '성배']);
  await responded(g, 0);
  t.expectEq((pa(g).responses[g.c(0).id] as any[]).length, 1, '제출은 1장');
  t.expect(g.hand(0).includes('성배') && g.hand(0).includes('복권'), '나머지 카드는 패에 남음');
  sub(g, 1, ['시선']);
  await g.waitPhase('MAIN', 1000);
  t.expectEq(g.hand(0).length + g.hand(1).length, 4, '카드 수 보존 (가람 3 + 나래 1)');
});

scenario('룰렛: 무기를 받은 생존자는 방패로 막지 못하면 죽는다', { card: '룰렛', rule: R.룰렛 }, async (t) => {
  const g = await newGame(t, { players: 3, hands: { 0: ['성정'], 1: ['코인'], 2: ['시선'] }, deck: ['룰렛'] });
  await startSubmission(g, '룰렛');
  sub(g, 0, ['성정']);
  sub(g, 1, ['코인']);
  sub(g, 2, ['시선']);
  const v = await rouletteVictim(g);
  t.note(`성정을 받은 사람: ${g.c(v).name}`);
  t.expect(g.p(v).isAlive, '방어 단계 동안은 살아 있음');
  g.c(v).act('skip_defense');
  await g.waitFor(() => !g.p(v).isAlive, '피격자 사망');
  await g.waitPhase('MAIN');
  const others = [0, 1, 2].filter((i) => i !== v);
  t.expect(others.every((i) => g.p(i).isAlive), '나머지는 생존');
  t.expectEq(sorted(others.flatMap((i) => g.hand(i))), sorted(['코인', '시선']), '나머지 두 장은 나머지 두 사람에게');
});

scenario('룰렛: 무기를 받은 생존자가 방패로 막으면 산다', { card: '룰렛', rule: R.룰렛 + ' / ' + R.황금방패 }, async (t) => {
  const g = await newGame(t, {
    players: 3,
    hands: { 0: ['성정', '황금 방패'], 1: ['코인', '황금 방패'], 2: ['시선', '황금 방패'] },
    deck: ['룰렛'],
  });
  await startSubmission(g, '룰렛');
  sub(g, 0, ['성정']);
  sub(g, 1, ['코인']);
  sub(g, 2, ['시선']);
  const v = await rouletteVictim(g);
  g.c(v).act('play_shield', g.cardId(v, '황금 방패'));
  await g.waitPhase('MAIN');
  t.expect([0, 1, 2].every((i) => g.p(i).isAlive), '모두 생존');
  t.expect(!g.hand(v).includes('황금 방패'), '사용한 방패는 버려짐');
});

scenario('룰렛: 제한시간 안에 내지 않은 생존자는 무작위 1장이 자동 제출된다', { card: '룰렛', rule: R.룰렛 }, async (t) => {
  const g = await newGame(t, { players: 3, hands: { 0: ['코인'], 1: ['시선'] }, deck: ['룰렛'] });
  await startSubmission(g, '룰렛');
  sub(g, 0, ['코인']);
  await responded(g, 0);
  await g.settle();
  t.expectEq(g.room.phase, 'RESOLVING_EVENT', '나래가 내기 전에는 대기');
  await g.waitServerMs(30000);
  await g.waitPhase('MAIN', 3000);
  t.expectEq([g.hand(0).length, g.hand(1).length], [1, 1], '두 사람 모두 1장씩 받음');
  t.expectEq(sorted([...g.hand(0), ...g.hand(1)]), sorted(['코인', '시선']), '나래의 시선이 자동 제출되어 섞임');
});

scenario('룰렛: 죽은 자는 참여할 수 없다', { card: '룰렛', rule: R.룰렛 }, async (t) => {
  const g = await newGame(t, { players: 3, dead: [2], hands: { 0: ['코인'], 1: ['흑역사'], 2: ['시선'] }, deck: ['룰렛'] });
  await startSubmission(g, '룰렛');
  sub(g, 2, ['시선']);
  sub(g, 0, ['코인']);
  sub(g, 1, ['흑역사']);
  await g.waitPhase('MAIN', 1000);
  t.expectEq(g.hand(2), ['시선'], '죽은 다온의 패는 그대로');
  t.expectEq(sorted([...g.hand(0), ...g.hand(1)]), sorted(['코인', '흑역사']), '생존자 둘끼리만 섞임');
});

scenario('룰렛: 카드를 가진 생존자가 아무도 없으면 기다리지 않고 바로 끝난다', { card: '룰렛', rule: R.룰렛 }, async (t) => {
  const g = await newGame(t, { players: 3, deck: ['룰렛'] });
  await drawEvent(g, 0);
  await g.settle();
  const quick = g.room.phase === 'MAIN';
  t.note(`발동 직후 단계: ${g.room.phase}`);
  await g.waitPhase('MAIN', 4000);
  t.expect(quick, '참여할 생존자가 없으면 제한시간(30초)을 기다리지 않고 바로 끝나야 함');
});

scenario('룰렛: 같은 생존자가 두 번 제출해도 카드가 사라지지 않는다', { card: '룰렛', rule: R.룰렛 + ' (1장씩)' }, async (t) => {
  const g = await newGame(t, { players: 3, hands: { 0: ['코인', '성배'], 1: ['시선'] }, deck: ['룰렛'] });
  await startSubmission(g, '룰렛');
  sub(g, 0, ['코인']);
  await responded(g, 0);
  sub(g, 0, ['성배']); // 두 번째 제출
  await g.settle();
  sub(g, 1, ['시선']);
  await g.waitPhase('MAIN', 4000);
  const all = [...g.hand(0), ...g.hand(1), ...g.hand(2)];
  t.note(`분배 후: 가람 [${g.hand(0).join(', ')}], 나래 [${g.hand(1).join(', ')}]`);
  t.expectEq(sorted(all), sorted(['코인', '성배', '시선']), '세 장 모두 누군가의 패에 있어야 함 (두 번째 제출은 거절)');
});

scenario('룰렛: 무기를 2장 받으면 차례로 방어 단계가 열린다', { card: '룰렛', rule: R.룰렛 }, async (t) => {
  const g = await newGame(t, {
    players: 3,
    hands: { 0: ['성정', '황금 방패'], 1: ['황금칼', '황금 방패'], 2: ['코인', '황금 방패'] },
    deck: ['룰렛'],
  });
  await startSubmission(g, '룰렛');
  sub(g, 0, ['성정']);
  sub(g, 1, ['황금칼']);
  sub(g, 2, ['코인']);
  const v1 = await rouletteVictim(g);
  g.c(v1).act('skip_defense');
  await g.waitFor(() => !g.p(v1).isAlive, '첫 피격자 사망');
  const v2 = await rouletteVictim(g, [v1]);
  t.expect(v2 !== v1, '두 번째 피격자는 다른 사람');
  g.c(v2).act('play_shield', g.cardId(v2, '황금 방패'));
  await g.waitPhase('MAIN');
  t.expectEq([0, 1, 2].filter((i) => !g.p(i).isAlive), [v1], '첫 피격자만 사망');
  t.expect(g.p(g.indexOf(g.room.currentTurnPlayerId)).isAlive, '차례는 살아 있는 사람에게');
});

scenario('룰렛: 2인전에서 두 사람 모두 무기를 받아 첫 사망으로 게임이 끝나면 더 이상 진행되지 않는다', { card: '룰렛', rule: R.룰렛 }, async (t) => {
  const g = await newGame(t, { players: 2, hands: { 0: ['성정'], 1: ['황금칼'] }, deck: ['룰렛'] });
  await startSubmission(g, '룰렛');
  sub(g, 0, ['성정']);
  await responded(g, 0);
  sub(g, 1, ['황금칼']);
  const v1 = await rouletteVictim(g);
  const v2 = 1 - v1;
  g.c(v1).act('skip_defense');
  await g.waitFor(() => g.c(0).gameOvers.length > 0, 'game_over 수신');
  await g.settle();
  const phaseRightAfter = g.room.phase;
  const defenseAfterEnd = g.room.phase === 'WAITING_FOR_DEFENSE' ? g.c(g.indexOf(pa(g)?.targetId)).name : null;
  await g.waitServerMs(30000); // 혹시 열린 방어 단계가 시간 초과될 만큼
  await g.settle();
  t.note(`첫 사망 직후 단계=${phaseRightAfter}, 종료 후 열린 방어 대상=${defenseAfterEnd ?? '없음'}, 최종 단계=${g.room.phase}, ${g.c(v2).name} 생존=${g.p(v2).isAlive}, game_over 수신 횟수=${g.c(0).gameOvers.length}`);
  t.expectEq(phaseRightAfter, 'ENDED', '게임 종료 후 단계는 ENDED로 유지');
  t.expect(g.p(v2).isAlive, `최후의 1인 ${g.c(v2).name}은(는) 게임 종료 후 죽지 않아야 함`);
  t.expectEq(g.c(0).gameOvers.length, 1, 'game_over는 한 번만');
});

scenario('룰렛: 3인 모두 무기를 받아 두 번째 사망으로 게임이 끝나면 세 번째 방어는 열리지 않는다', { card: '룰렛', rule: R.룰렛 }, async (t) => {
  const g = await newGame(t, { players: 3, hands: { 0: ['성정'], 1: ['황금칼'], 2: ['십자가#201'] }, deck: ['룰렛'] });
  await startSubmission(g, '룰렛');
  sub(g, 0, ['성정']);
  sub(g, 1, ['황금칼']);
  sub(g, 2, ['십자가']);
  const v1 = await rouletteVictim(g);
  g.c(v1).act('skip_defense');
  await g.waitFor(() => !g.p(v1).isAlive, '첫 피격자 사망');
  const v2 = await rouletteVictim(g, [v1]);
  g.c(v2).act('skip_defense');
  await g.waitFor(() => g.c(0).gameOvers.length > 0, 'game_over 수신');
  await g.settle();
  const v3 = [0, 1, 2].find((i) => i !== v1 && i !== v2)!;
  const phaseRightAfter = g.room.phase;
  await g.waitServerMs(30000);
  await g.settle();
  t.note(`두 번째 사망 직후 단계=${phaseRightAfter}, 최종 단계=${g.room.phase}, ${g.c(v3).name} 생존=${g.p(v3).isAlive}, game_over 수신 횟수=${g.c(0).gameOvers.length}`);
  t.expectEq(phaseRightAfter, 'ENDED', '게임 종료 후 단계는 ENDED로 유지');
  t.expect(g.p(v3).isAlive, `최후의 1인 ${g.c(v3).name}은(는) 게임 종료 후 죽지 않아야 함`);
  t.expectEq(g.c(0).gameOvers.length, 1, 'game_over는 한 번만');
});

scenario('룰렛: 방패로 막아낸 무기는 받은 사람의 패에 남는가', {
  card: '룰렛',
  rule: R.룰렛 + ' / ' + R.룰렛상세,
  ambiguous: '룰렛에서 무기를 받은 생존자가 방패로 공격을 막아냈다면, 그 무기는 "나눠가진" 카드로서 패에 남나요, 아니면 공격에 쓰였으므로 버려지나요?',
}, async (t) => {
  const g = await newGame(t, { players: 3, hands: { 0: ['성정', '황금 방패'], 1: ['코인', '황금 방패'] }, deck: ['룰렛'] });
  await startSubmission(g, '룰렛');
  sub(g, 0, ['성정']);
  sub(g, 1, ['코인']);
  const v = await rouletteVictim(g);
  g.c(v).act('play_shield', g.cardId(v, '황금 방패'));
  await g.waitPhase('MAIN');
  t.note(`막아낸 ${g.c(v).name}의 패: [${g.hand(v).join(', ')}], 성정 위치: ${inGrave(g, '성정') ? '무덤' : anyoneHas(g, '성정') ? '패' : '?'}`);
  t.expect(g.hand(v).includes('성정'), '나눠가진 카드라면 막아낸 뒤 패에 남음');
});

scenario('룰렛: 긴급탈출키트로 취소하면 제출한 카드가 돌아온다', { card: '룰렛', rule: R.룰렛 + ' / ' + R.긴급 }, async (t) => {
  const g = await newGame(t, { players: 3, hands: { 0: ['성정'], 1: ['시선'], 2: ['긴급탈출키트'] }, deck: ['룰렛'] });
  await startSubmission(g, '룰렛');
  sub(g, 0, ['성정']);
  await responded(g, 0);
  g.c(2).act('interrupt_action', g.cardId(2, '긴급탈출키트'));
  await g.waitPhase('MAIN');
  t.expectEq(g.hand(0), ['성정'], '제출했던 성정이 돌아옴');
  t.expectEq(g.hand(1), ['시선'], '나래 패 그대로');
  t.expect(inGrave(g, '긴급탈출키트'), '키트는 사용 후 버려짐');
  t.expect([0, 1, 2].every((i) => g.p(i).isAlive), '아무도 죽지 않음');
});

scenario('룰렛: 잘못된 형식의 제출(cardIds=null)로 서버가 죽지 않는다', { card: '룰렛', rule: R.룰렛 }, async (t) => {
  const g = await newGame(t, { players: 3, hands: { 0: ['코인'], 1: ['시선'] }, deck: ['룰렛'] });
  await startSubmission(g, '룰렛');
  g.c(1).act('submit_cards', null);
  await g.settle();
  sub(g, 0, ['코인']);
  sub(g, 1, ['시선']);
  await g.waitPhase('MAIN', 4000);
  t.expectEq(g.hand(0).length + g.hand(1).length, 2, '정상 제출 후 분배');
});

scenario('룰렛: 뽑은 자가 무기를 받아 죽으면 다음 생존자의 차례가 된다', { card: '룰렛', rule: R.룰렛 }, async (t) => {
  // 카드를 가진 사람이 가람뿐 → 자기 성정을 그대로 돌려받음
  const g = await newGame(t, { players: 3, hands: { 0: ['성정'] }, deck: ['룰렛'] });
  await startSubmission(g, '룰렛');
  sub(g, 0, ['성정']);
  const v = await rouletteVictim(g);
  t.expectEq(v, 0, '유일한 참가자 가람이 성정을 받음');
  g.c(0).act('skip_defense');
  await g.waitFor(() => !g.p(0).isAlive, '가람 사망');
  await g.waitPhase('MAIN');
  t.expectEq(g.room.currentTurnPlayerId, g.c(1).id, '다음 생존자 나래의 차례');
  t.expect(!g.p(1).hasDrawnThisTurn, '나래는 새 차례에서 뽑을 수 있음');
});

scenario('룰렛: 첫 번째 피격자가 방어 중에 나가도 두 번째 피격자의 방어 단계는 진행된다', { card: '룰렛', rule: R.룰렛 }, async (t) => {
  // 뽑은 가람은 카드가 없어 불참 → 나래·다온·라온 중 무기 2장을 받은 두 명이 피격자
  const g = await newGame(t, { players: 4, hands: { 1: ['성정'], 2: ['황금칼'], 3: ['코인'] }, deck: ['룰렛'] });
  await startSubmission(g, '룰렛');
  sub(g, 1, ['성정']);
  sub(g, 2, ['황금칼']);
  sub(g, 3, ['코인']);
  const v1 = await rouletteVictim(g);
  const v1id = g.c(v1).id;
  g.c(v1).act('leave_room');
  await g.waitFor(() => !g.room.players.some((p) => p.id === v1id), '첫 피격자 퇴장');
  await g.settle();
  const coinHolder = [1, 2, 3].filter((i) => i !== v1).find((i) => g.hand(i).includes('코인'));
  const v2 = [1, 2, 3].find((i) => i !== v1 && i !== coinHolder)!;
  t.note(`첫 피격자 ${g.c(v1).name} 퇴장 후 단계=${g.room.phase}, 방어 대상=${pa(g)?.targetId ? g.c(g.indexOf(pa(g).targetId)).name : '없음'}, 두 번째로 무기를 받은 사람=${g.c(v2).name}`);
  t.expect(g.room.phase === 'WAITING_FOR_DEFENSE' && pa(g)?.targetId === g.c(v2).id, `무기를 받은 ${g.c(v2).name}의 방어 단계가 열려야 함`);
});

scenario('룰렛: 제출한 생존자가 죽어도 아직 내지 않은 생존자는 직접 고를 기회를 가진다', { card: '룰렛', rule: R.룰렛 + ' / ' + R.눈없는 }, async (t) => {
  const g = await newGame(t, { players: 3, hands: { 0: ['코인'], 1: ['시선'], 2: ['성배', '복권'] }, deck: ['룰렛'] });
  (g.room as any).silenceMode = true; // 눈 없는 괴물 진행 중
  await startSubmission(g, '룰렛');
  sub(g, 0, ['코인']);
  sub(g, 1, ['시선']);
  await responded(g, 1);
  g.c(1).act('send_chat', '…'); // 나래 사망
  await g.waitFor(() => !g.p(1).isAlive, '나래 사망');
  await g.settle();
  const stillOpen = pa(g)?.eventName === '룰렛' && pa(g)?.type === 'CARD_SUBMISSION';
  t.note(`나래 사망 직후 룰렛 진행 중=${stillOpen}, 단계=${g.room.phase}, 다온 패=[${g.hand(2).join(', ')}], 죽은 나래 패=[${g.hand(1).join(', ')}]`);
  t.expect(stillOpen, '다온이 아직 카드를 고르지 않았으므로 제출 단계가 유지되어야 함');
  sub(g, 2, ['성배']);
  await g.waitPhase('MAIN', 4000);
  t.expect(g.hand(2).includes('복권'), '다온이 고르지 않은 복권은 패에 남음');
});

scenario('룰렛: 받은 필멸의 창을 방패로 막으면 오른쪽 생존자에게 넘어가는가', {
  card: '룰렛',
  rule: R.룰렛 + ' / (필멸의 창) 이 창으로 공격당한 자가 방패로 막으면 오른쪽 생존자로 향합니다. 이 창은 자신에게도 돌아오며 누군가 죽을 때까지 반복해야 합니다.',
  ambiguous: '룰렛에서 필멸의 창을 받은 생존자가 방패로 막으면, 필멸의 창의 효과대로 창이 오른쪽 생존자에게 넘어가 누군가 죽을 때까지 반복되나요, 아니면 룰렛 공격은 한 번 막으면 끝나나요?',
}, async (t) => {
  const g = await newGame(t, {
    players: 3,
    hands: { 0: ['필멸의 창', '황금 방패'], 1: ['코인', '황금 방패'], 2: ['시선', '황금 방패'] },
    deck: ['룰렛'],
  });
  await startSubmission(g, '룰렛');
  sub(g, 0, ['필멸의 창']);
  sub(g, 1, ['코인']);
  sub(g, 2, ['시선']);
  const v = await rouletteVictim(g);
  g.c(v).act('play_shield', g.cardId(v, '황금 방패'));
  await g.settle();
  const next = g.room.phase === 'WAITING_FOR_DEFENSE' ? g.c(g.indexOf(pa(g)?.targetId)).name : '없음';
  t.note(`${g.c(v).name}이(가) 막은 뒤 단계=${g.room.phase}, 다음 방어 대상=${next}`);
  t.expectEq(g.room.phase, 'WAITING_FOR_DEFENSE', '필멸의 창 효과가 적용된다면 오른쪽 생존자에게 넘어감');
  if (g.room.phase === 'WAITING_FOR_DEFENSE') {
    await g.waitServerMs(30000);
  }
});

// ══════════════════════════════════════════════════════════════════════
// 마육검
// ══════════════════════════════════════════════════════════════════════

scenario('마육검: 즉시 공격을 거울 방패로 반사하면 낙찰자가 공격받는다', { card: '마육검', rule: R.마육검 + ' / (거울 방패) 다른 생존자가 당신을 공격할 때 사용하면 그대로 그 공격을 당신을 공격한 생존자에게 돌려줍니다.' }, async (t) => {
  const g = await newGame(t, { players: 3, hands: { 0: ['시선'], 1: ['거울 방패'] }, deck: ['마육검'] });
  await startSubmission(g, '마육검');
  sub(g, 0, ['시선']);
  skip(g, 1);
  skip(g, 2);
  await waitMayukChoice(g);
  g.c(0).act('use_mayuk_sword_now', g.c(1).id);
  await g.waitPhase('WAITING_FOR_DEFENSE');
  g.c(1).act('play_shield', g.cardId(1, '거울 방패'));
  await g.waitFor(() => pa(g)?.targetId === g.c(0).id, '공격이 가람에게 반사됨');
  g.c(0).act('skip_defense');
  await g.waitFor(() => !g.p(0).isAlive, '가람 사망');
  await g.waitPhase('MAIN');
  t.expect(g.p(1).isAlive, '반사한 나래는 생존');
  t.expectEq(g.room.currentTurnPlayerId, g.c(1).id, '뽑은 가람이 죽었으므로 나래의 차례');
});

scenario('마육검: 악의를 가장 많이 공개한 생존자가 주인이 되고, 공개한 악의는 패에 남는다', { card: '마육검', rule: R.마육검 }, async (t) => {
  const g = await newGame(t, { players: 3, hands: { 0: ['코인'], 1: ['흑역사', '상처', '성배'], 2: ['시선'] }, deck: ['마육검'] });
  await startSubmission(g, '마육검');
  t.expectEq(g.requests(2, 'request_cards').at(-1)?.[0], '마육검', '모든 생존자에게 입찰 요청');
  skip(g, 0);
  sub(g, 1, ['흑역사', '상처']);
  sub(g, 2, ['시선']);
  const w = await waitMayukChoice(g);
  t.expectEq(w, 1, '악의 2장을 공개한 나래가 낙찰');
  const req = g.requests(1, 'request_mayuk_choice').at(-1);
  t.expectEq(sorted((req?.[1] ?? []) as string[]), sorted([g.c(0).id, g.c(2).id]), '즉시 공격 대상 후보는 나머지 생존자');
  t.expectEq(sorted(g.hand(1)), sorted(['흑역사', '상처', '성배']), '공개한 악의는 나래 패에 그대로');
  t.expectEq(g.hand(2), ['시선'], '진 입찰자의 악의도 패로 돌아옴');
  t.expectEq([g.p(1).currentMalice, g.p(2).currentMalice], [2, 1], '악의 점수 그대로');
  g.c(1).act('store_mayuk_sword');
  await g.waitPhase('MAIN');
  await drawAgain(t, g, 0);
});

scenario('마육검: 동률이면 먼저 공개한 생존자가 이긴다', { card: '마육검', rule: R.마육검 + ' (동률 시 먼저 공개한 자)' }, async (t) => {
  const g = await newGame(t, { players: 3, hands: { 1: ['시선'], 2: ['흑역사'] }, deck: ['마육검'] });
  await startSubmission(g, '마육검');
  sub(g, 2, ['흑역사']); // 다온이 먼저
  await responded(g, 2);
  await t.sleep(20);
  sub(g, 1, ['시선']);
  await responded(g, 1);
  skip(g, 0);
  const w = await waitMayukChoice(g);
  t.expectEq(w, 2, '좌석 순서와 관계없이 먼저 공개한 다온이 낙찰');
});

scenario('마육검: 악의가 아닌 카드는 입찰 점수에 포함되지 않고 그대로 돌아온다', { card: '마육검', rule: R.마육검 }, async (t) => {
  const g = await newGame(t, { players: 3, hands: { 0: ['코인', '성배', '황금 방패'], 1: ['시선'] }, deck: ['마육검'] });
  await startSubmission(g, '마육검');
  sub(g, 0, ['코인', '성배', '황금 방패']);
  await responded(g, 0);
  sub(g, 1, ['시선']);
  skip(g, 2);
  const w = await waitMayukChoice(g);
  t.expectEq(w, 1, '악의 1장의 나래가 낙찰 (가람의 도구 3장은 0점)');
  t.expectEq(sorted(g.hand(0)), sorted(['코인', '성배', '황금 방패']), '가람이 낸 카드는 모두 돌아옴');
});

scenario('마육검: 아무도 악의를 공개하지 않으면 검은 사라진다', { card: '마육검', rule: R.마육검 }, async (t) => {
  const g = await newGame(t, { players: 3, hands: { 0: ['코인'], 1: ['시선'] }, deck: ['마육검'] });
  await startSubmission(g, '마육검');
  sub(g, 0, ['코인']);
  skip(g, 1);
  skip(g, 2);
  await g.waitPhase('MAIN');
  t.expect(!anyoneHas(g, '마육검'), '누구의 패에도 마육검이 없어야 함');
  t.expectEq([g.hand(0), g.hand(1)], [['코인'], ['시선']], '패는 그대로');
  await drawAgain(t, g, 0);
});

scenario('마육검: 즉시 사용하면 공격 횟수를 소모하지 않는다', { card: '마육검', rule: R.마육검 + ' / ' + R.마육검상세 }, async (t) => {
  const g = await newGame(t, { players: 4, hands: { 0: ['시선', '성정'] }, deck: ['마육검'] });
  await startSubmission(g, '마육검');
  sub(g, 0, ['시선']);
  skip(g, 1);
  skip(g, 2);
  skip(g, 3);
  t.expectEq(await waitMayukChoice(g), 0, '가람 낙찰');
  g.c(0).act('use_mayuk_sword_now', g.c(1).id);
  await g.waitPhase('WAITING_FOR_DEFENSE');
  t.expectEq([g.indexOf(pa(g).initiatorId), g.indexOf(pa(g).targetId)], [0, 1], '가람 → 나래 공격');
  g.c(1).act('skip_defense');
  await g.waitFor(() => !g.p(1).isAlive, '나래 사망');
  await g.waitPhase('MAIN');
  t.expect(!g.p(0).hasUsedWeaponThisTurn, '즉시 사용은 무기 사용으로 치지 않음');
  t.expect(!anyoneHas(g, '마육검'), '즉시 사용한 마육검은 패에 남지 않음');
  g.c(0).act('play_tool', g.cardId(0, '성정'), g.c(2).id);
  await g.waitPhase('WAITING_FOR_DEFENSE');
  t.expectEq(g.indexOf(pa(g).targetId), 2, '같은 차례에 다른 무기로 또 공격 가능');
});

scenario('마육검: 차례가 아닌 낙찰자도 얻는 즉시 사용할 수 있고, 끝나면 뽑은 자의 차례가 이어진다', { card: '마육검', rule: R.마육검 }, async (t) => {
  const g = await newGame(t, { players: 4, hands: { 1: ['시선', '흑역사'] }, deck: ['마육검'] });
  await startSubmission(g, '마육검');
  sub(g, 1, ['시선', '흑역사']);
  skip(g, 0);
  skip(g, 2);
  skip(g, 3);
  t.expectEq(await waitMayukChoice(g), 1, '나래 낙찰');
  g.c(1).act('use_mayuk_sword_now', g.c(2).id);
  await g.waitPhase('WAITING_FOR_DEFENSE');
  g.c(2).act('skip_defense');
  await g.waitFor(() => !g.p(2).isAlive, '다온 사망');
  await g.waitPhase('MAIN');
  t.expect(!g.p(1).hasUsedWeaponThisTurn, '나래의 무기 사용 기록 없음');
  await drawAgain(t, g, 0);
});

scenario('마육검: 이미 무기를 쓴 차례에도 즉시 사용할 수 있다', { card: '마육검', rule: R.마육검상세 }, async (t) => {
  const g = await newGame(t, { players: 3, hands: { 0: ['성정', '시선'], 1: ['황금 방패'] }, deck: ['마육검'] });
  g.c(0).act('play_tool', g.cardId(0, '성정'), g.c(1).id);
  await g.waitPhase('WAITING_FOR_DEFENSE');
  g.c(1).act('play_shield', g.cardId(1, '황금 방패'));
  await g.waitPhase('MAIN');
  t.expect(g.p(0).hasUsedWeaponThisTurn, '전제: 이번 차례에 무기 사용함');
  await startSubmission(g, '마육검');
  sub(g, 0, ['시선']);
  skip(g, 1);
  skip(g, 2);
  await waitMayukChoice(g);
  g.c(0).act('use_mayuk_sword_now', g.c(2).id);
  await g.waitPhase('WAITING_FOR_DEFENSE');
  g.c(2).act('skip_defense');
  await g.waitFor(() => !g.p(2).isAlive, '다온 사망');
});

scenario('마육검: 즉시 공격도 방패로 막을 수 있다', { card: '마육검', rule: R.마육검 + ' / ' + R.황금방패 }, async (t) => {
  const g = await newGame(t, { players: 3, hands: { 0: ['시선'], 1: ['황금 방패'] }, deck: ['마육검'] });
  await startSubmission(g, '마육검');
  sub(g, 0, ['시선']);
  skip(g, 1);
  skip(g, 2);
  await waitMayukChoice(g);
  g.c(0).act('use_mayuk_sword_now', g.c(1).id);
  await g.waitPhase('WAITING_FOR_DEFENSE');
  g.c(1).act('play_shield', g.cardId(1, '황금 방패'));
  await g.waitPhase('MAIN');
  t.expect(g.p(1).isAlive, '방패로 막은 나래는 생존');
});

scenario('마육검: 보관하면 패에 일반 무기로 들어가고, 나중에 쓰면 공격 횟수를 소모한다', { card: '마육검', rule: R.마육검 + ' / ' + R.마육검상세 }, async (t) => {
  const g = await newGame(t, { players: 3, hands: { 0: ['시선'] }, deck: ['마육검'] });
  await startSubmission(g, '마육검');
  sub(g, 0, ['시선']);
  skip(g, 1);
  skip(g, 2);
  await waitMayukChoice(g);
  g.c(0).act('store_mayuk_sword');
  await g.waitPhase('MAIN');
  t.expect(g.p(0).hand.weapons.some((c) => c.name === '마육검'), '마육검이 무기 칸에 들어감');
  t.expectEq(g.p(0).currentMalice, 1, '마육검은 악의가 아님');
  g.c(0).act('play_tool', g.cardId(0, '마육검'), g.c(1).id);
  await g.waitPhase('WAITING_FOR_DEFENSE');
  t.expect(g.p(0).hasUsedWeaponThisTurn, '보관 후 사용은 일반 무기처럼 공격 횟수 소모');
  g.c(1).act('skip_defense');
  await g.waitFor(() => !g.p(1).isAlive, '나래 사망');
  t.expect(!anyoneHas(g, '마육검'), '사용한 마육검은 버려짐');
});

scenario('마육검: 낙찰자가 시간 안에 고르지 않으면 패에 보관된다', { card: '마육검', rule: R.마육검 + ' (즉시 사용치 않으면 패에 넣고 일반 무기)' }, async (t) => {
  const g = await newGame(t, { players: 3, hands: { 1: ['시선'] }, deck: ['마육검'] });
  await startSubmission(g, '마육검');
  sub(g, 1, ['시선']);
  skip(g, 0);
  skip(g, 2);
  await waitMayukChoice(g);
  await g.waitServerMs(30000);
  await g.waitPhase('MAIN', 3000);
  t.expect(g.p(1).hand.weapons.some((c) => c.name === '마육검'), '나래 패에 마육검 보관');
  t.expect([0, 1, 2].every((i) => g.p(i).isAlive), '아무도 공격받지 않음');
});

scenario('마육검: 낙찰자가 아니면 사용/보관을 고를 수 없고, 자기 자신·죽은 자는 공격할 수 없다', { card: '마육검', rule: R.마육검 }, async (t) => {
  const g = await newGame(t, { players: 4, dead: [3], hands: { 0: ['시선'] }, deck: ['마육검'] });
  await startSubmission(g, '마육검');
  sub(g, 0, ['시선']);
  skip(g, 1);
  skip(g, 2);
  await waitMayukChoice(g);
  g.c(1).act('store_mayuk_sword');
  g.c(1).act('use_mayuk_sword_now', g.c(2).id);
  g.c(0).act('use_mayuk_sword_now', g.c(0).id);
  g.c(0).act('use_mayuk_sword_now', g.c(3).id);
  await g.settle();
  t.expectEq([pa(g)?.eventName, pa(g)?.type], ['마육검', 'TARGET_SELECTION'], '여전히 낙찰자의 선택 대기');
  t.expect(!anyoneHas(g, '마육검'), '아무도 마육검을 보관하지 않음');
  t.expect(g.p(0).isAlive && g.p(2).isAlive, '아무도 공격받지 않음');
  g.c(0).act('store_mayuk_sword');
  await g.waitPhase('MAIN');
  t.expect(g.hand(0).includes('마육검'), '낙찰자는 보관 가능');
});

scenario('마육검: 죽은 자는 입찰할 수 없다', { card: '마육검', rule: R.마육검 + ' (생존자들은)' }, async (t) => {
  const g = await newGame(t, { players: 4, dead: [3], hands: { 1: ['시선'], 3: ['흑역사', '상처', '계시'] }, deck: ['마육검'] });
  await startSubmission(g, '마육검');
  sub(g, 3, ['흑역사', '상처', '계시']);
  skip(g, 0);
  sub(g, 1, ['시선']);
  skip(g, 2);
  const w = await waitMayukChoice(g);
  t.expectEq(w, 1, '생존자 중 최다인 나래가 낙찰');
  t.expectEq(g.p(3).hand.malices.length, 3, '죽은 라온의 패는 그대로');
});

scenario('마육검: 2인전에서 즉시 공격으로 상대가 죽으면 게임이 한 번만 끝난다', { card: '마육검', rule: R.마육검 }, async (t) => {
  const g = await newGame(t, { players: 2, hands: { 0: ['시선'] }, deck: ['마육검'] });
  await startSubmission(g, '마육검');
  sub(g, 0, ['시선']);
  skip(g, 1);
  await waitMayukChoice(g);
  g.c(0).act('use_mayuk_sword_now', g.c(1).id);
  await g.waitPhase('WAITING_FOR_DEFENSE');
  g.c(1).act('skip_defense');
  await g.waitFor(() => g.c(0).gameOvers.length > 0, 'game_over 수신');
  await g.waitServerMs(30000);
  await g.settle();
  t.expectEq(g.room.phase, 'ENDED', '게임 종료');
  t.expect(g.p(0).isAlive, '가람 생존');
  t.expectEq(g.c(0).gameOvers.length, 1, 'game_over 1회');
});

scenario('마육검: 긴급탈출키트로 경매를 취소하면 공개한 카드가 돌아온다', { card: '마육검', rule: R.마육검 + ' / ' + R.긴급 }, async (t) => {
  const g = await newGame(t, { players: 3, hands: { 0: ['시선', '흑역사'], 1: ['긴급탈출키트'] }, deck: ['마육검'] });
  await startSubmission(g, '마육검');
  sub(g, 0, ['시선', '흑역사']);
  await responded(g, 0);
  g.c(1).act('interrupt_action', g.cardId(1, '긴급탈출키트'));
  await g.waitPhase('MAIN');
  t.expectEq(sorted(g.hand(0)), sorted(['시선', '흑역사']), '입찰한 악의가 돌아옴');
  t.expect(!anyoneHas(g, '마육검'), '마육검은 아무도 얻지 못함');
});

scenario('마육검: 다시 입찰해도 먼저 공개한 악의가 사라지지 않는다', { card: '마육검', rule: R.마육검 + ' (공개한 악의는 패에 남음)' }, async (t) => {
  const g = await newGame(t, { players: 3, hands: { 1: ['시선', '흑역사'] }, deck: ['마육검'] });
  await startSubmission(g, '마육검');
  sub(g, 1, ['시선', '흑역사']);
  await responded(g, 1);
  g.c(1).act('submit_cards', []); // 두 번째 입찰 (0장)
  await g.settle();
  skip(g, 0);
  skip(g, 2);
  await g.waitFor(() => g.room.phase === 'MAIN' || pa(g)?.type === 'TARGET_SELECTION', '경매 종료', 4000);
  t.note(`경매 종료 후 나래 패: [${g.hand(1).join(', ')}], 악의 ${g.p(1).currentMalice}점, 단계 ${g.room.phase}/${pa(g)?.type ?? '-'}`);
  t.expectEq(sorted(g.hand(1)), sorted(['시선', '흑역사']), '공개했던 악의 2장이 패에 남아 있어야 함');
});

scenario('마육검: 경매 중 죽은 입찰자가 공개한 악의는 사라지지 않는다', { card: '마육검', rule: R.마육검 + ' / ' + R.눈없는 }, async (t) => {
  const g = await newGame(t, { players: 3, hands: { 2: ['흑역사', '상처'] }, deck: ['마육검'] });
  (g.room as any).silenceMode = true; // 눈 없는 괴물 진행 중
  await startSubmission(g, '마육검');
  sub(g, 2, ['흑역사', '상처']);
  await responded(g, 2);
  g.c(2).act('send_chat', '…'); // 소리를 내서 사망
  await g.waitFor(() => !g.p(2).isAlive, '다온 사망');
  skip(g, 0);
  skip(g, 1);
  await g.waitPhase('MAIN', 4000);
  await g.settle();
  const where = ['흑역사', '상처'].map((n) => `${n}:${g.hand(2).includes(n) ? '다온 패' : inGrave(g, n) ? '무덤' : anyoneHas(g, n) ? '다른 패' : '없음'}`);
  t.note(`경매 후 위치 — ${where.join(', ')}`);
  t.expect(['흑역사', '상처'].every((n) => g.hand(2).includes(n) || inGrave(g, n)), '죽은 다온이 공개한 악의는 다온의 패나 무덤에 있어야 함');
  t.expect(!anyoneHas(g, '마육검'), '죽은 자는 낙찰받지 못함');
});

scenario('마육검: 경매 중 입찰자가 죽어도 남은 생존자 전원이 입찰할 때까지 기다린다', { card: '마육검', rule: R.마육검 + ' (원하는 생존자들은 동시에 악의를 공개)' }, async (t) => {
  const g = await newGame(t, { players: 3, hands: { 1: ['시선'], 2: ['흑역사'] }, deck: ['마육검'] });
  (g.room as any).silenceMode = true;
  await startSubmission(g, '마육검');
  sub(g, 2, ['흑역사']);
  await responded(g, 2);
  g.c(2).act('send_chat', '…');
  await g.waitFor(() => !g.p(2).isAlive, '다온 사망');
  skip(g, 0);
  await responded(g, 0);
  await g.settle();
  const stillOpen = pa(g)?.eventName === '마육검' && pa(g)?.type === 'CARD_SUBMISSION';
  t.note(`가람 입찰 직후 경매 진행 중=${stillOpen}, 단계=${g.room.phase}`);
  t.expect(stillOpen, '나래가 아직 입찰하지 않았으므로 경매가 계속되어야 함');
  sub(g, 1, ['시선']);
  t.expectEq(await waitMayukChoice(g), 1, '나래 낙찰');
});

scenario('마육검: 경매 중 뽑은 자가 나가도 다른 생존자가 공개한 악의는 사라지지 않는다', { card: '마육검', rule: R.마육검 + ' (공개한 악의는 패에 남음)' }, async (t) => {
  const g = await newGame(t, { players: 3, turn: 2, hands: { 0: ['시선', '흑역사'] }, deck: ['마육검'] });
  await startSubmission(g, '마육검', 2);
  sub(g, 0, ['시선', '흑역사']);
  await responded(g, 0);
  g.c(2).act('leave_room');
  await g.waitFor(() => g.room.players.length === 2, '다온 퇴장');
  await g.settle();
  if (pa(g)?.eventName === '마육검' && pa(g)?.type === 'CARD_SUBMISSION') skip(g, 1);
  await g.waitFor(() => g.room.phase === 'MAIN' || pa(g)?.type === 'TARGET_SELECTION', '경매 종료', 4000);
  if (pa(g)?.type === 'TARGET_SELECTION') {
    g.c(0).act('store_mayuk_sword');
    await g.waitPhase('MAIN');
  }
  t.note(`다온 퇴장 후 가람 패: [${g.hand(0).join(', ')}]`);
  t.expect(g.hand(0).includes('시선') && g.hand(0).includes('흑역사'), '가람이 공개한 시선·흑역사가 패에 남아 있어야 함');
});

scenario('마육검: 짙은 악의를 공개하면 몇 장으로 세는가', {
  card: '마육검',
  rule: R.마육검 + ' / ' + R.짙은,
  ambiguous: '마육검 경매에서 짙은 악의 1장을 공개하면 "악의 2장"으로 세나요, 아니면 "카드를 낼 때는 1장으로 취급"이므로 1장으로 세나요? (짙은 악의 1장 vs 일반 악의 2장이면 누가 이기나요?)',
}, async (t) => {
  const g = await newGame(t, { players: 3, hands: { 1: ['짙은 악의'], 2: ['시선', '흑역사'] }, deck: ['마육검'] });
  await startSubmission(g, '마육검');
  sub(g, 1, ['짙은 악의']); // 먼저 공개
  await responded(g, 1);
  await t.sleep(20);
  sub(g, 2, ['시선', '흑역사']);
  skip(g, 0);
  const w = await waitMayukChoice(g);
  t.note(`현재 동작: ${g.c(w).name} 낙찰 (서버는 짙은 악의를 2점으로 세어 동률 → 먼저 공개한 나래 승)`);
  t.expectEq(w, 2, '짙은 악의를 1장으로 센다면 악의 2장의 다온이 낙찰');
});

scenario('마육검: 잘못된 형식의 입찰(cardIds=null)로 서버가 죽지 않는다', { card: '마육검', rule: R.마육검 }, async (t) => {
  const g = await newGame(t, { players: 3, hands: { 1: ['시선'] }, deck: ['마육검'] });
  await startSubmission(g, '마육검');
  g.c(1).act('submit_cards', null);
  await g.settle();
  sub(g, 1, ['시선']);
  skip(g, 0);
  skip(g, 2);
  t.expectEq(await waitMayukChoice(g), 1, '정상 입찰 후 나래 낙찰');
});
