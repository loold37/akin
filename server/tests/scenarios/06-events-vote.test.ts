import { scenario, ScenarioApi } from '../harness/runner';
import type { GameCtx } from '../harness/game';
import { TestClient } from '../harness/client';

// 06: 투표/제출형 이벤트 — 천사의 심판대, 악마의 고해소, 구덩이, 미끼, 제물, 인체 연성
// 규칙(card.json)대로의 동작을 단언합니다. 실패 = 현재 구현이 규칙과 다름.

// ── 규칙 원문 ────────────────────────────────────────────────────────
const R_JUDGE =
  '천사의 심판대에 올라야만 합니다! 생존자 회의를 통해 한 명을 결정합니다. 결정된 자는 모든 패를 공개하고 그 중 악의가 1장이라도 있다면 그자는 죽게 됩니다.';
const R_JUDGE_SELF = '[1] 충분한 대화를 통해 지목할 수 있고 자기 자신을 지목하는 것도 가능합니다.';
const R_JUDGE_CHOSEN = "[2] 선택을 뽑은 자가 아닌 '회의로 선택된 자'가 죽습니다.";
const R_CONF =
  '악마의 고해소에 들어가야만 합니다! 생존자 회의를 통해 한 명을 결정합니다. 결정된 자는 모든 패를 공개하고 그 중 악의가 1장 이하라면 그자는 죽게 됩니다.';
const R_PIT =
  '생존자 모두가 힘을 합쳐 이 카드를 뽑은 자를 꺼내줘야 합니다. 투표를 진행해 한 명이라도 구출을 반대하면 구덩이에 갇혀 죽게 됩니다.';
const R_BAIT =
  '괴물이 나타났습니다! 생존자 중 한 명이 무기 1장으로 괴물을 물리치지 않는다면 생존자 회의를 통해 괴물에게 미끼로 주게 할 자를 결정합니다.';
const R_SAC =
  '모든 생존자는 힘을 합쳐 악의를 제외한 카드를 참가자 수만큼 바쳐야 합니다. 실패 시 생존자 회의를 통해 한 명을 결정해 제물로 죽여야 합니다.';
const R_SAC_1 = "[1] '힘을 합쳐'는 제출된 카드의 총합 개수를 말합니다.";
const R_TRANS = '모든 생존자가 힘을 합쳐 참가자 수만큼 악의를 제외한 카드를 버리면 죽은 자를 한 명 부활시킵니다.';
const R_TRANS_D = '죽은 자가 부활에 성공하면, 패가 0장인 초기화 상태로 부활합니다.';
const R_DICT = "[독재] 이벤트 카드 텍스트에 '생존자 회의'라는 단어가 정확히 명시되어 있는 카드(천사의 심판대, 악마의 고해소, 미끼 등)에서만 사용 가능합니다.";
const R_GOODWILL = '[선의] 이 카드를 지니고 있다면 악의를 1장 줄여 계산합니다. … (단, 이 카드만으로 악의 판정을 유리하게 우회하여 이벤트를 회피할 수는 없음)';
const R_DEEP = '[짙은 악의] 이 악의는 악의 2장입니다. … (패에 들고 있을 때만 악의 2장으로 산정)';
const R_SILENCE = '[침묵] 한 생존자를 선택해 이번 차례에 도구를 못 내게 합니다. … 이벤트 진행 중 제출해야 하는 도구 역시 낼 수 없게 됩니다.';
const R_KIT = '[긴급탈출키트] 이벤트를 한 개 취소합니다. 자신의 차례가 아니거나 이벤트가 진행 중 일지라도 사용 가능합니다. / 즉시 발동하여 현재 진행 중인 이벤트의 효과를 완전히 무효화합니다.';

// ── 헬퍼 ─────────────────────────────────────────────────────────────
const pa = (g: GameCtx): any => g.room.pendingAction as any;

async function startVote(g: GameCtx, event: string, drawer = 0): Promise<void> {
  g.c(drawer).act('draw_card');
  await g.waitFor(() => pa(g)?.type === 'VOTE' && pa(g)?.eventName === event, `${event} 투표 시작`);
}

async function startSubmission(g: GameCtx, event: string, drawer = 0): Promise<void> {
  g.c(drawer).act('draw_card');
  await g.waitFor(() => pa(g)?.type === 'CARD_SUBMISSION' && pa(g)?.eventName === event, `${event} 카드 제출 시작`);
}

function vote(g: GameCtx, voter: number, target: number | 'SAVE' | 'DROP', dict = false): void {
  const id = typeof target === 'number' ? g.c(target).id : target;
  g.c(voter).act('submit_vote', id, dict);
}

function submit(g: GameCtx, i: number, cardIds: string[]): void {
  g.c(i).act('submit_cards', cardIds);
}

/** i번 패에서 이름이 name인 카드 id 전부 */
function idsOf(g: GameCtx, i: number, name: string): string[] {
  return g.handCards(i).filter((c) => c.name === name).map((c) => c.id);
}

async function waitReveal(g: GameCtx): Promise<void> {
  await g.waitFor(() => !!pa(g)?.revealedCards, '패 공개 시작');
}

function confirmAllAlive(g: GameCtx): void {
  g.clients.forEach((c, i) => {
    if (g.p(i).isAlive) c.act('confirm_reveal');
  });
}

async function finishReveal(g: GameCtx): Promise<void> {
  await waitReveal(g);
  confirmAllAlive(g);
  await g.waitPhase('MAIN');
}

const inGrave = (g: GameCtx, name: string) => g.room.graveyard.some((c) => c.name === name);
const aliveIdx = (g: GameCtx) => g.clients.map((_, i) => i).filter((i) => g.p(i).isAlive);

async function outsider(g: GameCtx): Promise<TestClient> {
  const c = new TestClient(g.srv.url, '외부인');
  await c.connect();
  return c;
}

/** 심판대/고해소: 모든 생존자가 target에게 투표 → 패 공개 확인 → MAIN 복귀 */
async function runTrial(t: ScenarioApi, g: GameCtx, event: string, target: number, drawer = 0): Promise<void> {
  await startVote(g, event, drawer);
  for (const i of aliveIdx(g)) vote(g, i, target);
  await waitReveal(g);
  t.expectEq(pa(g)?.revealedPlayerId, g.c(target).id, `패 공개 대상은 ${g.c(target).name}`);
  confirmAllAlive(g);
  await g.waitPhase('MAIN');
}

// ══════════════════════════════════════════════════════════════════════
// 천사의 심판대
// ══════════════════════════════════════════════════════════════════════

scenario('천사의 심판대: 과반 득표자가 악의를 가지고 있으면 패 공개 후 죽는다', { card: '천사의 심판대', rule: R_JUDGE }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['시선'], 1: ['시선', '코인'], 2: ['흑역사'] }, deck: ['천사의 심판대'] });
  await startVote(g, '천사의 심판대');
  const req = g.requests(2, 'request_vote').at(-1)!;
  t.expectEq(req[0], '천사의 심판대', 'request_vote 이벤트명');
  t.expectEq([...req[1]].sort(), [g.c(0).id, g.c(1).id, g.c(2).id].sort(), '후보는 모든 생존자');
  vote(g, 0, 1);
  vote(g, 1, 2);
  vote(g, 2, 1);
  await waitReveal(g);
  t.expectEq(pa(g).revealedPlayerId, g.c(1).id, '득표 2표인 나래의 패가 공개됨');
  t.expectEq((pa(g).revealedCards as any[]).map((c) => c.name).sort(), ['시선', '코인'].sort(), '공개된 패 = 나래의 모든 패');
  t.expect(g.p(1).isAlive, '패 공개 중에는 아직 살아 있음');
  confirmAllAlive(g);
  await g.waitPhase('MAIN');
  t.expect(!g.p(1).isAlive, '악의를 가진 나래는 사망');
  t.expect(g.p(0).isAlive && g.p(2).isAlive, '나머지는 생존');
  t.expectEq(g.room.currentTurnPlayerId, g.c(0).id, '뽑은 사람의 차례 유지');
  t.expect(!g.p(0).hasDrawnThisTurn, '이벤트 후 다시 뽑아야 함');
  g.c(0).act('draw_card');
  await g.waitFor(() => g.p(0).hasDrawnThisTurn, '다시 드로우');
});

scenario('천사의 심판대: 악의가 없는 자가 선택되면 살아남는다', { card: '천사의 심판대', rule: R_JUDGE }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['시선'], 1: ['코인', '황금 방패', '성정'], 2: ['흑역사'] }, deck: ['천사의 심판대'] });
  await runTrial(t, g, '천사의 심판대', 1);
  t.expect(g.p(1).isAlive, '악의 0장 → 무죄, 생존');
  t.expectEq(g.hand(1).sort(), ['코인', '황금 방패', '성정'].sort(), '패는 공개만 되고 그대로');
});

scenario('천사의 심판대: 뽑은 자가 아니라 회의로 선택된 자가 죽는다', { card: '천사의 심판대', rule: R_JUDGE_CHOSEN }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['시선', '흑역사'], 1: ['코인'], 2: ['상처'] }, deck: ['천사의 심판대'] });
  await runTrial(t, g, '천사의 심판대', 2);
  t.expect(g.p(0).isAlive, '악의가 있어도 뽑은 자(가람)는 선택되지 않았으므로 생존');
  t.expect(!g.p(2).isAlive, '선택된 다온 사망');
});

scenario('천사의 심판대: 자기 자신을 지목할 수 있고, 뽑은 자가 죽으면 차례가 넘어간다', { card: '천사의 심판대', rule: R_JUDGE_SELF }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['시선'], 1: ['코인'], 2: ['코인'] }, deck: ['천사의 심판대'] });
  await runTrial(t, g, '천사의 심판대', 0);
  t.expect(!g.p(0).isAlive, '자기 자신에게도 투표 가능 → 가람 사망');
  t.expectEq(g.room.currentTurnPlayerId, g.c(1).id, '다음 생존자 나래의 차례');
});

scenario('천사의 심판대: 누군가의 뼈(악의 겸 무기)만 있어도 죽는다', { card: '천사의 심판대', rule: R_JUDGE + ' / [누군가의 뼈] 이 무기는 악의인 동시에 무기입니다.' }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['누군가의 뼈'] }, deck: ['천사의 심판대'] });
  await runTrial(t, g, '천사의 심판대', 1);
  t.expect(!g.p(1).isAlive, '누군가의 뼈는 악의 1장 → 사망');
});

scenario('천사의 심판대: 누군가의 로켓(악의 겸 보물)만 있어도 죽는다', { card: '천사의 심판대', rule: R_JUDGE + ' / [누군가의 로켓] 이 보물은 악의인 동시에 보물입니다.' }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['누군가의 로켓'] }, deck: ['천사의 심판대'] });
  await runTrial(t, g, '천사의 심판대', 1);
  t.expect(!g.p(1).isAlive, '누군가의 로켓은 악의 1장 → 사망');
});

scenario('천사의 심판대: 짙은 악의만 있어도 죽는다', { card: '천사의 심판대', rule: R_JUDGE + ' / ' + R_DEEP }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['짙은 악의'] }, deck: ['천사의 심판대'] });
  await runTrial(t, g, '천사의 심판대', 1);
  t.expect(!g.p(1).isAlive, '짙은 악의 → 사망');
});

scenario('천사의 심판대: 선의가 있어도 악의 1장이면 죽는다 (선의로 회피 불가)', { card: '천사의 심판대', rule: R_JUDGE + ' / ' + R_GOODWILL }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['시선', '선의'] }, deck: ['천사의 심판대'] });
  t.expectEq(g.p(1).currentMalice, 0, '전제: 선의로 악의 점수는 0');
  await runTrial(t, g, '천사의 심판대', 1);
  t.expect(!g.p(1).isAlive, '선의로 악의 판정을 우회할 수 없음 → 사망');
});

scenario('천사의 심판대: 최다 득표 동률이면 동률 후보 중에서만 정해진다', { card: '천사의 심판대', rule: R_JUDGE }, async (t) => {
  const g = await t.game({ players: 4, hands: { 0: ['시선'], 1: ['시선'], 2: ['시선'], 3: ['시선'] }, deck: ['천사의 심판대'] });
  await startVote(g, '천사의 심판대');
  vote(g, 0, 1);
  vote(g, 1, 2);
  vote(g, 2, 1);
  vote(g, 3, 2);
  await waitReveal(g);
  const chosen = g.indexOf(pa(g).revealedPlayerId);
  t.expect(chosen === 1 || chosen === 2, `동률(나래 2표, 다온 2표) 중에서 선택되어야 함 (실제: ${chosen})`);
  confirmAllAlive(g);
  await g.waitPhase('MAIN');
  const dead = [0, 1, 2, 3].filter((i) => !g.p(i).isAlive);
  t.expectEq(dead, [chosen], '선택된 1명만 사망');
  t.note(`동률 추첨 결과: ${g.c(chosen).name}`);
});

scenario('천사의 심판대: 투표하지 않은 생존자가 있어도 제한시간 후 결과가 난다', { card: '천사의 심판대', rule: R_JUDGE }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['시선'], 1: ['시선'], 2: ['시선'] }, deck: ['천사의 심판대'] });
  await startVote(g, '천사의 심판대');
  vote(g, 0, 1);
  await g.settle();
  t.expectEq(pa(g)?.type, 'VOTE', '아직 2명이 투표하지 않았으므로 투표 진행 중');
  await g.waitFor(() => !!pa(g)?.revealedCards, '제한시간 후 패 공개', 4000);
  await g.waitPhase('MAIN', 4000);
  const dead = [0, 1, 2].filter((i) => !g.p(i).isAlive);
  t.expectEq(dead.length, 1, '정확히 1명이 선택되어 사망');
  t.note(`미투표자 무작위 처리 결과 사망: ${g.c(dead[0]).name}`);
});

scenario('천사의 심판대: 죽은 플레이어의 투표로 투표가 조기 종료되지 않는다', { card: '천사의 심판대', rule: R_JUDGE + ' (생존자 회의)' }, async (t) => {
  const g = await t.game({ players: 4, dead: [3], hands: { 0: ['시선'], 1: ['코인'], 2: ['시선'], 3: [] }, deck: ['천사의 심판대'] });
  await startVote(g, '천사의 심판대');
  vote(g, 0, 2);
  vote(g, 1, 2);
  vote(g, 3, 0); // 죽은 라온
  await g.settle();
  t.expect(
    pa(g)?.type === 'VOTE',
    `생존자 다온이 아직 투표하지 않았으므로 투표가 계속되어야 함 (실제: ${pa(g)?.type ?? 'null'}${pa(g)?.revealedCards ? ' — 이미 패 공개 단계로 넘어감' : ''})`,
  );
  vote(g, 2, 0);
  await finishReveal(g);
  t.expect(!g.p(2).isAlive, '2표를 받은 다온 사망');
});

scenario('천사의 심판대: 죽은 플레이어의 패 공개 확인으로 공개가 조기 종료되지 않는다', { card: '천사의 심판대', rule: R_JUDGE }, async (t) => {
  const g = await t.game({ players: 4, dead: [3], hands: { 1: ['시선'] }, deck: ['천사의 심판대'] });
  await startVote(g, '천사의 심판대');
  for (const i of [0, 1, 2]) vote(g, i, 1);
  await waitReveal(g);
  g.c(0).act('confirm_reveal');
  g.c(1).act('confirm_reveal');
  g.c(3).act('confirm_reveal'); // 죽은 라온
  await g.settle();
  t.expect(!!pa(g)?.revealedCards, `생존자 다온이 확인하기 전에 패 공개가 끝나면 안 됨 (실제 phase=${g.room.phase})`);
  g.c(2).act('confirm_reveal');
  await g.waitPhase('MAIN');
  t.expect(!g.p(1).isAlive, '나래 사망');
});

scenario('천사의 심판대: 투표 중 긴급탈출키트로 취소하면 아무도 죽지 않는다', { card: '천사의 심판대', rule: R_KIT }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['시선'], 2: ['긴급탈출키트'] }, deck: ['천사의 심판대'] });
  await startVote(g, '천사의 심판대');
  vote(g, 0, 1);
  g.c(2).act('interrupt_action', g.cardId(2, '긴급탈출키트'));
  await g.waitPhase('MAIN');
  await g.settle();
  t.expect([0, 1, 2].every((i) => g.p(i).isAlive), '이벤트 무효 → 모두 생존');
  t.expect(inGrave(g, '긴급탈출키트'), '긴급탈출키트는 무덤으로');
  t.expect(!g.p(0).hasDrawnThisTurn, '뽑은 사람은 다시 뽑아야 함');
});

scenario('천사의 심판대: 패 공개 중(확인한 사람이 있어도) 긴급탈출키트로 처형을 취소할 수 있다', { card: '천사의 심판대', rule: R_KIT }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['시선'], 2: ['긴급탈출키트'] }, deck: ['천사의 심판대'] });
  await startVote(g, '천사의 심판대');
  for (const i of [0, 1, 2]) vote(g, i, 1);
  await waitReveal(g);
  g.c(0).act('confirm_reveal'); // 한 명이 이미 "확인"을 누름
  await g.settle();
  g.c(2).act('interrupt_action', g.cardId(2, '긴급탈출키트'));
  await g.waitPhase('MAIN');
  await g.settle();
  t.expect(g.p(1).isAlive, '이벤트가 무효화되어 나래 생존');
  t.expect(inGrave(g, '긴급탈출키트'), '긴급탈출키트는 무덤으로');
});

scenario('천사의 심판대: 2인 게임에서 선택된 자가 죽으면 게임이 끝난다', { card: '천사의 심판대', rule: R_JUDGE }, async (t) => {
  const g = await t.game({ players: 2, hands: { 1: ['시선'] }, deck: ['천사의 심판대'] });
  await startVote(g, '천사의 심판대');
  vote(g, 0, 1);
  vote(g, 1, 1);
  await waitReveal(g);
  confirmAllAlive(g);
  await g.waitPhase('ENDED');
  await g.settle();
  t.expect(!g.p(1).isAlive && g.p(0).isAlive, '나래 사망, 가람 최후 1인');
  t.expect(g.c(0).gameOvers.length === 1, 'game_over 1회 전송');
});

scenario('천사의 심판대: 투표 중 kill_bait_monster(미끼 전용)는 무시된다', { card: '천사의 심판대', rule: R_BAIT }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['성정'] }, deck: ['천사의 심판대'] });
  await startVote(g, '천사의 심판대');
  g.c(1).act('kill_bait_monster', g.cardId(1, '성정'));
  await g.settle();
  t.expectEq(pa(g)?.type, 'VOTE', '심판대 투표는 그대로 진행');
  t.expectEq(g.hand(1), ['성정'], '무기는 패에 그대로');
});

// ══════════════════════════════════════════════════════════════════════
// 악마의 고해소
// ══════════════════════════════════════════════════════════════════════

scenario('악마의 고해소: 악의가 0장인 선택된 자는 죽는다', { card: '악마의 고해소', rule: R_CONF }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['시선'], 1: ['코인', '황금 방패'], 2: [] }, deck: ['악마의 고해소'] });
  await startVote(g, '악마의 고해소');
  t.expectEq([...g.requests(1, 'request_vote').at(-1)![1]].sort(), [g.c(0).id, g.c(1).id, g.c(2).id].sort(), '후보는 모든 생존자');
  for (const i of [0, 1, 2]) vote(g, i, 1);
  await waitReveal(g);
  t.expectEq((pa(g).revealedCards as any[]).map((c) => c.name).sort(), ['코인', '황금 방패'].sort(), '선택된 자의 모든 패 공개');
  confirmAllAlive(g);
  await g.waitPhase('MAIN');
  t.expect(!g.p(1).isAlive, '악의 0장 → 사망');
  t.expect(g.p(0).isAlive && g.p(2).isAlive, '나머지 생존');
});

scenario('악마의 고해소: 악의가 정확히 1장이면 죽는다', { card: '악마의 고해소', rule: R_CONF }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['시선', '코인'] }, deck: ['악마의 고해소'] });
  await runTrial(t, g, '악마의 고해소', 1);
  t.expect(!g.p(1).isAlive, '악의 1장 → 사망');
});

scenario('악마의 고해소: 악의가 2장이면 살아남는다', { card: '악마의 고해소', rule: R_CONF }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['시선', '흑역사'] }, deck: ['악마의 고해소'] });
  await runTrial(t, g, '악마의 고해소', 1);
  t.expect(g.p(1).isAlive, '악의 2장 → 생존');
  t.expectEq(g.hand(1).sort(), ['시선', '흑역사'].sort(), '패는 그대로');
});

scenario('악마의 고해소: 짙은 악의 1장(악의 2장으로 산정)만 있으면 살아남는다', { card: '악마의 고해소', rule: R_CONF + ' / ' + R_DEEP }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['짙은 악의'] }, deck: ['악마의 고해소'] });
  await runTrial(t, g, '악마의 고해소', 1);
  t.expect(g.p(1).isAlive, '패에 든 짙은 악의는 악의 2장 → 생존');
});

scenario('악마의 고해소: 누군가의 방패 + 악의 1장이면 악의 2장으로 살아남는다', { card: '악마의 고해소', rule: R_CONF + ' / [누군가의 방패] 이 방패는 악의인 동시에 방패입니다.' }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['누군가의 방패', '상처'] }, deck: ['악마의 고해소'] });
  await runTrial(t, g, '악마의 고해소', 1);
  t.expect(g.p(1).isAlive, '누군가의 방패(악의 1) + 상처(악의 1) = 2장 → 생존');
});

scenario('악마의 고해소: 자기 자신을 지목할 수 있고, 뽑은 자가 죽으면 차례가 넘어간다', { card: '악마의 고해소', rule: R_JUDGE_SELF + ' (고해소 동일)' }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['코인'], 1: ['시선'], 2: ['시선'] }, deck: ['악마의 고해소'] });
  await runTrial(t, g, '악마의 고해소', 0);
  t.expect(!g.p(0).isAlive, '자기 지목 → 악의 0장 가람 사망');
  t.expectEq(g.room.currentTurnPlayerId, g.c(1).id, '다음 생존자 나래의 차례');
});

scenario('악마의 고해소: 선의를 가진 자의 악의 2장은 1장으로 계산되는가', {
  card: '악마의 고해소',
  rule: R_CONF + ' / ' + R_GOODWILL,
  ambiguous:
    '악마의 고해소에서 악의 카드 2장 + 선의를 가진 자가 선택되면, 선의 효과(악의 1장 감소)가 적용되어 악의 1장으로 계산되어 죽습니까? 아니면 공개된 악의 카드 2장 그대로 계산되어 살아남습니까? (선의의 단서는 "유리하게 우회"만 금지하는데, 고해소에서 악의를 줄이는 것은 불리한 쪽입니다)',
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['시선', '흑역사', '선의'] }, deck: ['악마의 고해소'] });
  t.note(`전제: 나래의 악의 점수(currentMalice) = ${g.p(1).currentMalice}`);
  await runTrial(t, g, '악마의 고해소', 1);
  t.note(`현재 동작: 나래 ${g.p(1).isAlive ? '생존 (선의 무시, 악의 카드 2장으로 계산)' : '사망 (선의 적용, 악의 1장으로 계산)'}`);
});

// ══════════════════════════════════════════════════════════════════════
// 구덩이
// ══════════════════════════════════════════════════════════════════════

scenario('구덩이: 모두 살린다에 투표하면 뽑은 자는 구출된다', { card: '구덩이', rule: R_PIT }, async (t) => {
  const g = await t.game({ players: 3, deck: ['구덩이'] });
  await startVote(g, '구덩이');
  const req = g.requests(1, 'request_vote').at(-1)!;
  t.expectEq(req[1], ['SAVE', 'DROP'], '구덩이 투표 선택지는 SAVE/DROP');
  t.expectEq(req[2], g.c(0).id, '구덩이에 빠진 사람 = 뽑은 가람');
  for (const i of [0, 1, 2]) vote(g, i, 'SAVE');
  await g.waitPhase('MAIN');
  t.expect(g.p(0).isAlive, '가람 구출');
  t.expectEq(g.room.currentTurnPlayerId, g.c(0).id, '가람 차례 유지');
  t.expect(!g.p(0).hasDrawnThisTurn, '다시 뽑아야 함');
});

scenario('구덩이: 한 명이라도 구출을 반대하면 뽑은 자가 죽고 차례가 넘어간다', { card: '구덩이', rule: R_PIT }, async (t) => {
  const g = await t.game({ players: 3, deck: ['구덩이'] });
  await startVote(g, '구덩이');
  vote(g, 0, 'SAVE');
  vote(g, 1, 'SAVE');
  vote(g, 2, 'DROP');
  await g.waitPhase('MAIN');
  t.expect(!g.p(0).isAlive, '반대 1표 → 가람 사망');
  t.expect(g.p(1).isAlive && g.p(2).isAlive, '나머지 생존');
  t.expectEq(g.room.currentTurnPlayerId, g.c(1).id, '다음 생존자 나래의 차례');
});

scenario('구덩이: 투표하지 않은 생존자는 살린다로 처리된다', { card: '구덩이', rule: R_PIT }, async (t) => {
  const g = await t.game({ players: 3, deck: ['구덩이'] });
  await startVote(g, '구덩이');
  vote(g, 1, 'SAVE');
  await g.settle();
  t.expectEq(pa(g)?.type, 'VOTE', '모두 투표하기 전에는 진행 중');
  await g.waitServerMs(30000);
  await g.waitPhase('MAIN');
  t.expect(g.p(0).isAlive, '반대표가 없으므로 가람 구출');
});

scenario('구덩이: 죽은 플레이어의 반대 투표는 반영되지 않는다', { card: '구덩이', rule: R_PIT + ' (생존자 모두)' }, async (t) => {
  const g = await t.game({ players: 4, dead: [3], deck: ['구덩이'] });
  await startVote(g, '구덩이');
  vote(g, 3, 'DROP'); // 죽은 라온
  vote(g, 0, 'SAVE');
  vote(g, 1, 'SAVE');
  vote(g, 2, 'SAVE');
  await g.waitPhase('MAIN');
  t.expect(g.p(0).isAlive, '죽은 자의 반대표는 무효 → 가람 생존');
});

scenario('구덩이: 죽은 플레이어의 투표로 투표가 조기 종료되어 생존자의 반대표가 묻히지 않는다', { card: '구덩이', rule: R_PIT }, async (t) => {
  const g = await t.game({ players: 4, dead: [3], deck: ['구덩이'] });
  await startVote(g, '구덩이');
  vote(g, 0, 'SAVE');
  vote(g, 1, 'SAVE');
  vote(g, 3, 'SAVE'); // 죽은 라온
  await g.settle();
  const stillVoting = pa(g)?.type === 'VOTE';
  t.note(`죽은 라온 투표 직후 투표 진행 중? ${stillVoting} (phase=${g.room.phase})`);
  vote(g, 2, 'DROP'); // 생존자 다온의 반대표
  await g.waitFor(() => g.room.phase === 'MAIN', 'MAIN 복귀', 4000);
  t.expect(!g.p(0).isAlive, '생존자 다온이 구출을 반대했으므로 가람은 죽어야 함 (죽은 자의 투표로 투표가 먼저 끝나 반대표가 무시됨)');
});

scenario('구덩이: 방에 없는 소켓의 투표로 투표가 조기 종료되지 않는다', { card: '구덩이', rule: R_PIT }, async (t) => {
  const g = await t.game({ players: 3, deck: ['구덩이'] });
  const x = await outsider(g);
  try {
    await startVote(g, '구덩이');
    vote(g, 0, 'SAVE');
    vote(g, 1, 'SAVE');
    x.raw('submit_vote', g.code, 'SAVE'); // 방에 참가하지 않은 소켓
    await g.settle();
    t.note(`외부 소켓 투표 직후 투표 진행 중? ${pa(g)?.type === 'VOTE'} / 응답 수 ${pa(g) ? Object.keys(pa(g).responses).length : '-'}`);
    vote(g, 2, 'DROP');
    await g.waitFor(() => g.room.phase === 'MAIN', 'MAIN 복귀', 4000);
    t.expect(!g.p(0).isAlive, '생존자 다온이 반대했으므로 가람은 죽어야 함 (외부 소켓 투표로 투표가 먼저 끝나 반대표가 무시됨)');
  } finally {
    x.close();
  }
});

scenario('구덩이: 2인 게임에서 반대표로 뽑은 자가 죽으면 게임이 끝난다', { card: '구덩이', rule: R_PIT }, async (t) => {
  const g = await t.game({ players: 2, deck: ['구덩이'] });
  await startVote(g, '구덩이');
  vote(g, 0, 'SAVE');
  vote(g, 1, 'DROP');
  await g.waitPhase('ENDED');
  await g.settle();
  t.expect(!g.p(0).isAlive && g.p(1).isAlive, '가람 사망, 나래 최후 1인');
  t.expect(g.c(1).gameOvers.length === 1, 'game_over 1회 전송');
});

scenario('구덩이: 독재는 적용되지 않는다 (생존자 회의가 아님)', { card: '구덩이', rule: R_PIT + ' / ' + R_DICT }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['독재'] }, deck: ['구덩이'] });
  await startVote(g, '구덩이');
  vote(g, 0, 'SAVE');
  vote(g, 1, 'SAVE', true); // 독재 사용 시도
  vote(g, 2, 'DROP');
  await g.waitPhase('MAIN');
  t.expect(!g.p(0).isAlive, '독재로 반대표를 덮을 수 없음 → 가람 사망');
  t.expectEq(g.hand(1), ['독재'], '독재 카드는 소모되지 않음');
});

// ══════════════════════════════════════════════════════════════════════
// 미끼
// ══════════════════════════════════════════════════════════════════════

scenario('미끼: 생존자가 무기 1장으로 괴물을 물리치면 아무도 죽지 않고 무기는 버려진다', { card: '미끼', rule: R_BAIT }, async (t) => {
  const g = await t.game({ players: 3, hands: { 2: ['성정', '코인'] }, deck: ['미끼'] });
  await startVote(g, '미끼');
  t.expectEq([...g.requests(0, 'request_vote').at(-1)![1]].sort(), [g.c(0).id, g.c(1).id, g.c(2).id].sort(), '미끼 후보는 모든 생존자');
  g.c(2).act('kill_bait_monster', g.cardId(2, '성정'));
  await g.waitPhase('MAIN');
  t.expect([0, 1, 2].every((i) => g.p(i).isAlive), '모두 생존');
  t.expectEq(g.hand(2), ['코인'], '사용한 무기만 버려짐');
  t.expect(inGrave(g, '성정'), '성정은 무덤으로');
  t.expectEq(g.room.currentTurnPlayerId, g.c(0).id, '뽑은 사람 차례 유지');
  t.expect(!g.p(0).hasDrawnThisTurn, '다시 뽑아야 함');
});

scenario('미끼: 이미 투표한 생존자도 무기로 괴물을 물리칠 수 있다', { card: '미끼', rule: R_BAIT }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['십자가#201'] }, deck: ['미끼'] });
  await startVote(g, '미끼');
  vote(g, 0, 2);
  vote(g, 1, 2);
  g.c(1).act('kill_bait_monster', g.cardId(1, '십자가'));
  await g.waitPhase('MAIN');
  t.expect([0, 1, 2].every((i) => g.p(i).isAlive), '괴물 처치 → 모두 생존');
  t.expect(inGrave(g, '십자가'), '십자가는 무덤으로');
});

scenario('미끼: 무기가 아닌 카드로는 괴물을 물리칠 수 없다', { card: '미끼', rule: R_BAIT }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['황금 방패', '코인'] }, deck: ['미끼'] });
  await startVote(g, '미끼');
  g.c(1).act('kill_bait_monster', g.cardId(1, '황금 방패'));
  g.c(1).act('kill_bait_monster', g.cardId(1, '코인'));
  await g.settle();
  t.expectEq(pa(g)?.type, 'VOTE', '투표 계속 진행');
  t.expectEq(g.hand(1).sort(), ['황금 방패', '코인'].sort(), '카드는 패에 그대로');
});

scenario('미끼: 죽은 플레이어는 무기로 괴물을 물리칠 수 없다', { card: '미끼', rule: R_BAIT + ' (생존자 중 한 명)' }, async (t) => {
  const g = await t.game({ players: 4, dead: [3], hands: { 3: ['성정'] }, deck: ['미끼'] });
  await startVote(g, '미끼');
  g.c(3).act('kill_bait_monster', g.cardId(3, '성정'));
  await g.settle();
  t.expectEq(pa(g)?.type, 'VOTE', '투표 계속 진행');
  t.expectEq(g.hand(3), ['성정'], '죽은 자의 무기는 그대로');
});

scenario('미끼: 아무도 괴물을 물리치지 않으면 회의로 선택된 자가 (방패가 있어도) 죽는다', { card: '미끼', rule: R_BAIT }, async (t) => {
  const g = await t.game({ players: 3, hands: { 2: ['황금 방패'] }, deck: ['미끼'] });
  await startVote(g, '미끼');
  vote(g, 0, 2);
  vote(g, 1, 2);
  vote(g, 2, 0);
  await g.waitPhase('MAIN');
  t.expect(!g.p(2).isAlive, '2표를 받은 다온이 미끼가 되어 사망');
  t.expect(g.p(0).isAlive && g.p(1).isAlive, '나머지 생존');
});

scenario('미끼: 아무도 투표하지 않아도 제한시간 후 한 명이 미끼가 된다', { card: '미끼', rule: R_BAIT }, async (t) => {
  const g = await t.game({ players: 3, deck: ['미끼'] });
  await startVote(g, '미끼');
  await g.waitServerMs(30000);
  await g.waitPhase('MAIN');
  const dead = [0, 1, 2].filter((i) => !g.p(i).isAlive);
  t.expectEq(dead.length, 1, '정확히 1명 사망');
  t.note(`무작위 결과 사망: ${g.c(dead[0]).name}`);
});

scenario('미끼: 생존자 회의이므로 독재를 쓸 수 있다', { card: '미끼', rule: R_DICT }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['독재'] }, deck: ['미끼'] });
  await startVote(g, '미끼');
  vote(g, 0, 0);
  vote(g, 2, 0);
  vote(g, 1, 2, true);
  await g.waitPhase('MAIN');
  t.expect(!g.p(2).isAlive, '독재로 지목된 다온 사망');
  t.expect(g.p(0).isAlive, '다수표를 받은 가람은 생존');
  t.expectEq(g.hand(1), [], '독재는 사용 후 버려짐');
  t.expect(inGrave(g, '독재'), '독재는 무덤으로');
});

scenario('미끼: 이번 차례에 이미 무기로 공격한 뽑은 자도 다른 무기로 괴물을 물리칠 수 있다', { card: '미끼', rule: R_BAIT }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정', '황금칼'], 1: ['황금 방패'] }, deck: ['미끼'] });
  g.c(0).act('play_tool', g.cardId(0, '성정'), g.c(1).id);
  await g.waitPhase('WAITING_FOR_DEFENSE');
  g.c(1).act('play_shield', g.cardId(1, '황금 방패'));
  await g.waitFor(() => g.room.phase === 'MAIN' && g.p(0).hasUsedWeaponThisTurn, '공격 종료');
  await startVote(g, '미끼');
  g.c(0).act('kill_bait_monster', g.cardId(0, '황금칼'));
  await g.waitPhase('MAIN');
  t.expect([0, 1, 2].every((i) => g.p(i).isAlive), '괴물 처치 (생존자 공격이 아니므로 공격 횟수와 무관) → 모두 생존');
  t.expect(inGrave(g, '황금칼'), '황금칼은 무덤으로');
});

scenario('미끼: 이번 차례에 침묵당한 생존자는 무기로 괴물을 물리칠 수 없다', { card: '미끼', rule: R_SILENCE }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정', '황금칼'], 2: ['침묵'] }, deck: ['미끼'] });
  // 가람이 나래를 공격 → 다온이 침묵으로 무효화 (가람은 이번 차례 침묵 상태)
  g.c(0).act('play_tool', g.cardId(0, '성정'), g.c(1).id);
  await g.waitPhase('WAITING_FOR_DEFENSE');
  g.c(2).act('interrupt_action', g.cardId(2, '침묵'));
  await g.waitFor(() => g.room.phase === 'MAIN' && g.p(0).isSilenced, '가람 침묵');
  await startVote(g, '미끼');
  t.expect(g.p(0).isSilenced, '전제: 가람은 여전히 침묵 상태');
  g.c(0).act('kill_bait_monster', g.cardId(0, '황금칼'));
  await g.settle();
  t.expect(pa(g)?.type === 'VOTE' && pa(g)?.eventName === '미끼', `침묵 상태에서는 무기를 낼 수 없으므로 미끼 투표가 계속되어야 함 (실제 phase=${g.room.phase})`);
  t.expectEq(g.hand(0), ['황금칼'], '황금칼은 패에 그대로');
});

// ══════════════════════════════════════════════════════════════════════
// 제물
// ══════════════════════════════════════════════════════════════════════

scenario('제물: 생존자들이 합쳐서 참가자 수만큼 바치면 아무도 죽지 않는다', { card: '제물', rule: R_SAC + ' / ' + R_SAC_1 }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['코인', '성배'], 1: ['황금 방패', '시선'], 2: ['성정'] }, deck: ['제물'] });
  await startSubmission(g, '제물');
  t.expect(g.requests(2, 'request_cards').some((a) => a[0] === '제물'), '모두에게 제물 제출 요청');
  submit(g, 0, [g.cardId(0, '코인'), g.cardId(0, '성배')]);
  submit(g, 1, [g.cardId(1, '황금 방패')]);
  await g.waitPhase('MAIN');
  await g.settle();
  t.expect([0, 1, 2].every((i) => g.p(i).isAlive), '모두 생존');
  t.expect(g.requests(0, 'request_vote').length === 0, '투표 없음');
  t.expect(['코인', '성배', '황금 방패'].every((n) => inGrave(g, n)), '바친 카드는 무덤으로');
  t.expectEq(g.hand(1), ['시선'], '나래는 시선만 남음');
  t.expectEq(g.hand(2), ['성정'], '다온은 그대로');
  t.expect(!g.p(0).hasDrawnThisTurn, '뽑은 사람은 다시 뽑아야 함');
});

scenario('제물: 한 명이 혼자 참가자 수만큼 바쳐도 성공한다', { card: '제물', rule: R_SAC_1 }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['코인', '성배', '복권'] }, deck: ['제물'] });
  await startSubmission(g, '제물');
  submit(g, 1, g.handCards(1).map((c) => c.id));
  await g.waitPhase('MAIN');
  await g.settle();
  t.expect([0, 1, 2].every((i) => g.p(i).isAlive), '모두 생존');
  t.expectEq(g.hand(1), [], '나래 패 3장 모두 바침');
});

scenario('제물: 악의 카드는 제물로 바칠 수 없다', { card: '제물', rule: R_SAC }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['시선'], 1: ['코인'], 2: ['코인'] }, deck: ['제물'] });
  await startSubmission(g, '제물');
  submit(g, 0, [g.cardId(0, '시선')]);
  submit(g, 1, [g.cardId(1, '코인')]);
  submit(g, 2, [g.cardId(2, '코인')]);
  await g.waitFor(() => pa(g)?.type === 'VOTE' || g.room.phase === 'MAIN', '제물 판정', 4000);
  t.expect(!inGrave(g, '시선'), '악의 카드(시선)가 제물로 무덤에 가면 안 됨');
  t.expect(g.hand(0).includes('시선'), '시선은 가람의 패에 남아 있어야 함');
  t.expect(pa(g)?.type === 'VOTE', `악의를 뺀 제물은 2장 < 3명 → 실패하여 생존자 회의(투표)가 열려야 함 (실제 phase=${g.room.phase})`);
});

scenario('제물: 실패하면 바친 카드를 돌려받고 생존자 회의로 선택된 자가 죽는다', { card: '제물', rule: R_SAC }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['코인'], 1: ['성배'], 2: ['황금 방패'] }, deck: ['제물'] });
  await startSubmission(g, '제물');
  submit(g, 0, [g.cardId(0, '코인')]);
  submit(g, 1, []);
  submit(g, 2, []);
  await g.waitFor(() => pa(g)?.type === 'VOTE' && pa(g)?.eventName === '제물', '제물 실패 → 투표');
  t.expectEq(g.hand(0), ['코인'], '실패 시 바친 코인을 돌려받음');
  t.expect(!inGrave(g, '코인'), '코인은 무덤에 없음');
  const req = g.requests(1, 'request_vote').at(-1)!;
  t.expectEq([...req[1]].sort(), [g.c(0).id, g.c(1).id, g.c(2).id].sort(), '후보는 모든 생존자');
  vote(g, 0, 2);
  vote(g, 1, 2);
  vote(g, 2, 1);
  await g.waitPhase('MAIN');
  t.expect(!g.p(2).isAlive, '2표를 받은 다온이 제물로 사망 (방패가 있어도)');
  t.expect(g.p(0).isAlive && g.p(1).isAlive, '나머지 생존');
});

scenario('제물: 아무도 바치지 않으면 제한시간 후 투표로 넘어간다', { card: '제물', rule: R_SAC }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['코인'], 1: ['코인'], 2: ['코인'] }, deck: ['제물'] });
  await startSubmission(g, '제물');
  await g.waitFor(() => pa(g)?.type === 'VOTE' && pa(g)?.eventName === '제물', '제한시간 후 투표', 4000);
  t.expect([0, 1, 2].every((i) => g.hand(i).length === 1), '자동 제출 없음 — 패 그대로');
  for (const i of [0, 1, 2]) vote(g, i, 1);
  await g.waitPhase('MAIN');
  t.expect(!g.p(1).isAlive, '나래 사망');
});

scenario('제물: 죽은 플레이어는 제물을 바칠 수 없다', { card: '제물', rule: R_SAC + ' (모든 생존자)' }, async (t) => {
  const g = await t.game({ players: 4, dead: [3], hands: { 3: ['코인', '성배', '복권'] }, deck: ['제물'] });
  await startSubmission(g, '제물');
  submit(g, 3, g.handCards(3).map((c) => c.id));
  await g.settle();
  t.expectEq(g.hand(3).length, 3, '죽은 라온의 카드는 그대로');
  t.expect(pa(g)?.type === 'CARD_SUBMISSION', '제물 제출이 계속 진행 중');
});

scenario('제물: 같은 생존자가 두 번 제출해도 먼저 낸 카드가 사라지지 않는다', { card: '제물', rule: R_SAC + ' / ' + R_SAC_1, allowViolations: ['CARD_LOST'] }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['복권', '성배'] }, deck: ['제물'] });
  await startSubmission(g, '제물');
  const lottoId = g.cardId(1, '복권');
  const grailId = g.cardId(1, '성배');
  submit(g, 1, [lottoId]);
  await g.settle();
  submit(g, 1, [grailId]);
  await g.settle();
  t.note(`두 번째 제출 직후 나래의 제출 기록: ${JSON.stringify((pa(g)?.responses?.[g.c(1).id] ?? []).map((c: any) => c.name))}`);
  submit(g, 0, []);
  submit(g, 2, []);
  await g.waitFor(() => pa(g)?.type === 'VOTE', '제물 실패 → 투표', 4000);
  const where = (id: string) =>
    g.handCards(1).some((c) => c.id === id) ? '나래 패' : g.room.graveyard.some((c) => c.id === id) ? '무덤' : g.room.deck.some((c) => c.id === id) ? '덱' : '어디에도 없음';
  t.expect(
    where(lottoId) === '나래 패' && where(grailId) === '나래 패',
    `제물 실패(바친 카드 < 3장)이므로 나래가 낸 복권·성배를 모두 돌려받아야 함 (실제: 복권=${where(lottoId)}, 성배=${where(grailId)})`,
  );
});

scenario('제물: 긴급탈출키트로 취소하면 바친 카드를 돌려받는다', { card: '제물', rule: R_KIT }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['코인'], 2: ['긴급탈출키트'] }, deck: ['제물'] });
  await startSubmission(g, '제물');
  submit(g, 0, [g.cardId(0, '코인')]);
  await g.settle();
  g.c(2).act('interrupt_action', g.cardId(2, '긴급탈출키트'));
  await g.waitPhase('MAIN');
  await g.settle();
  t.expectEq(g.hand(0), ['코인'], '바친 코인을 돌려받음');
  t.expect([0, 1, 2].every((i) => g.p(i).isAlive), '모두 생존');
});

// 2026-10-23 확인: "참가자 수"는 사망자를 포함한 전체 참가 인원.
scenario('제물: 4인 게임에서 1명이 죽었어도 4장을 바쳐야 하며 3장이면 실패한다', {
  card: '제물',
  rule: R_SAC,
}, async (t) => {
  const g = await t.game({ players: 4, dead: [3], hands: { 0: ['코인'], 1: ['코인'], 2: ['코인'] }, deck: ['제물'] });
  await startSubmission(g, '제물');
  for (const i of [0, 1, 2]) submit(g, i, [g.cardId(i, '코인')]);
  await g.waitFor(() => pa(g)?.type === 'VOTE' || g.room.phase === 'MAIN', '제물 판정', 4000);
  t.note(
    pa(g)?.type === 'VOTE'
      ? '현재 동작: 3장(생존자 3명) 제출 → 실패, 투표 진행 (전체 참가자 4명 기준)'
      : '현재 동작: 3장(생존자 3명) 제출 → 성공 (생존자 수 기준)',
  );
  t.expectEq(pa(g)?.type, 'VOTE', '참가자 4명 기준이므로 3장은 실패 → 제물 투표');
});

scenario('제물/인체 연성: 누군가의 뼈(악의 겸 무기)를 악의가 아닌 카드로 단독 제출할 수 있는가', {
  card: '제물',
  rule: R_SAC + ' / [누군가의 뼈] 악의를 제외한 카드로 사용 가능합니다. 이벤트(무장해제 등)에 제출 시, 이 카드 단독(무기+악의 동시 1장 취급)으로는 불가능하며 다른 무기 카드 혹은 악의 카드와 섞어서 제출해야 합니다.',
  ambiguous:
    "누군가의 뼈/방패/로켓(악의 겸 도구)은 제물·인체 연성에 '악의를 제외한 카드'로 바칠 수 있습니까? 바칠 수 있다면, '단독으로는 불가능' 규칙에 따라 한 사람이 그 카드 1장만 내는 것은 거부되어야 합니까?",
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['코인'], 1: ['누군가의 뼈'], 2: ['코인'] }, deck: ['제물'] });
  await startSubmission(g, '제물');
  submit(g, 1, [g.cardId(1, '누군가의 뼈')]);
  submit(g, 0, [g.cardId(0, '코인')]);
  submit(g, 2, [g.cardId(2, '코인')]);
  await g.waitFor(() => pa(g)?.type === 'VOTE' || g.room.phase === 'MAIN', '제물 판정', 4000);
  t.note(`제물: 누군가의 뼈 단독 제출 → ${inGrave(g, '누군가의 뼈') ? '받아들여져 3장으로 성공' : '거부'} (phase=${g.room.phase}, 대기=${pa(g)?.type ?? '없음'})`);

  const h = await t.game({ players: 3, dead: [2], hands: { 0: ['누군가의 뼈'], 1: ['코인'] }, deck: ['인체 연성'] });
  await startSubmission(h, '인체 연성');
  submit(h, 0, [h.cardId(0, '누군가의 뼈')]);
  submit(h, 1, [h.cardId(1, '코인')]);
  await h.waitFor(() => pa(h)?.type === 'VOTE' || h.room.phase === 'MAIN', '인체 연성 판정', 4000);
  t.note(`인체 연성: 누군가의 뼈 단독 제출 → ${inGrave(h, '누군가의 뼈') ? '받아들여져 2장으로 성공(부활 투표)' : '거부'} (대기=${pa(h)?.type ?? '없음'})`);
});

scenario('제물: cardIds 없이 submit_cards를 보내도 서버가 죽지 않는다', { card: '제물', rule: R_SAC }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['코인'] }, deck: ['제물'] });
  await startSubmission(g, '제물');
  g.c(1).act('submit_cards'); // cardIds = undefined (조작된 클라이언트)
  g.c(2).act('submit_cards', null);
  await g.settle();
  t.expect(pa(g)?.eventName === '제물', '제물 이벤트는 계속 진행');
  await g.waitFor(() => pa(g)?.type === 'VOTE', '제한시간 후 투표', 4000);
});

// ══════════════════════════════════════════════════════════════════════
// 인체 연성
// ══════════════════════════════════════════════════════════════════════

scenario('인체 연성: 죽은 자가 없으면 아무 일도 없고 뽑은 자가 다시 뽑는다', { card: '인체 연성', rule: R_TRANS }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['코인'] }, deck: ['인체 연성'] });
  g.c(0).act('draw_card');
  await g.waitFor(() => g.msgs(0).some((m) => m.includes('인체 연성')), '인체 연성 발동');
  await g.waitPhase('MAIN');
  await g.settle();
  t.expect(!g.requests(1, 'request_cards').some((a) => a[0] === '인체 연성'), '제출 요청 없음');
  t.expectEq(g.hand(0), ['코인'], '패 그대로');
  t.expect(!g.p(0).hasDrawnThisTurn, '다시 뽑아야 함');
  g.c(0).act('draw_card');
  await g.waitFor(() => g.p(0).hasDrawnThisTurn, '다시 드로우');
});

scenario('인체 연성: 생존자가 합쳐 충분히 바치면 투표로 고른 죽은 자가 빈 패로 부활한다', { card: '인체 연성', rule: R_TRANS + ' / ' + R_TRANS_D }, async (t) => {
  const g = await t.game({ players: 3, dead: [2], hands: { 0: ['코인', '성배', '시선'], 1: ['황금 방패'], 2: ['시선', '성정'] }, deck: ['인체 연성'] });
  await startSubmission(g, '인체 연성');
  t.expect(g.requests(1, 'request_cards').some((a) => a[0] === '인체 연성'), '인체 연성 제출 요청');
  submit(g, 0, [g.cardId(0, '코인'), g.cardId(0, '성배')]);
  submit(g, 1, [g.cardId(1, '황금 방패')]);
  await g.waitFor(() => pa(g)?.type === 'VOTE' && pa(g)?.eventName === '인체 연성', '부활 투표 시작');
  const req = g.requests(0, 'request_vote').at(-1)!;
  t.expectEq(req[1], [g.c(2).id], '후보는 죽은 자(다온)');
  t.expect(['코인', '성배', '황금 방패'].every((n) => inGrave(g, n)), '바친 카드는 무덤으로');
  vote(g, 0, 2);
  vote(g, 1, 2);
  await g.waitPhase('MAIN');
  t.expect(g.p(2).isAlive, '다온 부활');
  t.expectEq(g.hand(2), [], '부활한 자의 패는 0장');
  t.expectEq(g.p(2).currentMalice, 0, '악의 0');
  t.expectEq(g.hand(0), ['시선'], '가람은 시선만 남음');
  // 부활한 자도 차례를 받는다
  t.expect(!g.p(0).hasDrawnThisTurn, '뽑은 사람은 다시 뽑아야 함');
  g.c(0).act('draw_card');
  await g.waitFor(() => g.p(0).hasDrawnThisTurn, '가람 드로우');
  g.c(0).act('end_turn');
  await g.waitFor(() => g.room.currentTurnPlayerId === g.c(1).id, '나래 차례');
  g.c(1).act('draw_card');
  await g.waitFor(() => g.p(1).hasDrawnThisTurn, '나래 드로우');
  g.c(1).act('end_turn');
  await g.waitFor(() => g.room.currentTurnPlayerId === g.c(2).id, '부활한 다온의 차례');
});

scenario('인체 연성: 부활한 자의 이전 패는 무덤으로 간다', { card: '인체 연성', rule: R_TRANS_D, allowViolations: ['CARD_LOST'] }, async (t) => {
  const g = await t.game({ players: 3, dead: [2], hands: { 0: ['코인', '성배', '복권'], 2: ['시선', '성정'] }, deck: ['인체 연성'] });
  await startSubmission(g, '인체 연성');
  submit(g, 0, g.handCards(0).map((c) => c.id));
  submit(g, 1, []);
  await g.waitFor(() => pa(g)?.type === 'VOTE', '부활 투표 시작');
  vote(g, 0, 2);
  vote(g, 1, 2);
  await g.waitPhase('MAIN');
  t.expect(g.p(2).isAlive, '다온 부활');
  t.expectEq(g.hand(2), [], '빈 패');
  t.expect(inGrave(g, '시선') && inGrave(g, '성정'), `다온이 죽을 때 들고 있던 시선/성정은 무덤으로 가야 함 (무덤: ${g.room.graveyard.map((c) => c.name).join(', ')})`);
});

scenario('인체 연성: 부족하면 실패하고 바친 카드를 돌려받는다', { card: '인체 연성', rule: R_TRANS }, async (t) => {
  const g = await t.game({ players: 3, dead: [2], hands: { 0: ['코인'], 1: ['성배'] }, deck: ['인체 연성'] });
  await startSubmission(g, '인체 연성');
  submit(g, 0, [g.cardId(0, '코인')]);
  submit(g, 1, []);
  await g.waitPhase('MAIN');
  await g.settle();
  t.expect(!g.p(2).isAlive, '부활 실패');
  t.expectEq(g.hand(0), ['코인'], '코인 반환');
  t.expectEq(g.hand(1), ['성배'], '성배 그대로');
  t.expect(g.requests(0, 'request_vote').length === 0, '투표 없음');
});

scenario('인체 연성: 제출하지 않은 생존자가 있어도 제한시간 후 판정된다', { card: '인체 연성', rule: R_TRANS }, async (t) => {
  const g = await t.game({ players: 3, dead: [2], hands: { 0: ['코인', '성배', '복권'], 1: ['황금 방패'] }, deck: ['인체 연성'] });
  await startSubmission(g, '인체 연성');
  submit(g, 0, g.handCards(0).map((c) => c.id));
  await g.settle();
  t.expectEq(pa(g)?.type, 'CARD_SUBMISSION', '나래 미제출 → 제출 대기 중');
  await g.waitFor(() => pa(g)?.type === 'VOTE', '제한시간 후 성공 → 투표', 4000);
  t.expectEq(g.hand(1), ['황금 방패'], '미제출자의 카드는 자동 제출되지 않음');
  await g.waitFor(() => g.room.phase === 'MAIN', '투표 제한시간 후 판정', 4000);
  t.expect(g.p(2).isAlive, '유일한 사망자 다온 부활');
});

scenario('인체 연성: 악의 카드는 바칠 수 없다', { card: '인체 연성', rule: R_TRANS }, async (t) => {
  const g = await t.game({ players: 3, dead: [2], hands: { 0: ['시선', '코인'], 1: ['흑역사'] }, deck: ['인체 연성'] });
  await startSubmission(g, '인체 연성');
  submit(g, 0, [g.cardId(0, '시선'), g.cardId(0, '코인')]);
  submit(g, 1, [g.cardId(1, '흑역사')]);
  await g.waitFor(() => g.room.phase === 'MAIN' || pa(g)?.type === 'VOTE', '판정', 4000);
  await g.settle();
  t.expect(!inGrave(g, '시선') && !inGrave(g, '흑역사'), '악의 카드는 무덤으로 가지 않음');
  t.expect(g.room.phase === 'MAIN' && !g.p(2).isAlive, '악의를 뺀 제물 1장 < 필요 수 → 실패');
  t.expectEq(g.hand(0).sort(), ['시선', '코인'].sort(), '가람 패 복구');
  t.expectEq(g.hand(1), ['흑역사'], '나래 패 그대로');
});

scenario('인체 연성: 독재는 적용되지 않는다 (생존자 회의 문구 없음)', { card: '인체 연성', rule: R_TRANS + ' / ' + R_DICT }, async (t) => {
  const g = await t.game({ players: 4, dead: [2, 3], hands: { 0: ['독재', '코인', '코인'], 1: ['코인', '코인'] }, deck: ['인체 연성'] });
  await startSubmission(g, '인체 연성');
  submit(g, 0, idsOf(g, 0, '코인'));
  submit(g, 1, idsOf(g, 1, '코인'));
  await g.waitFor(() => pa(g)?.type === 'VOTE' && pa(g)?.eventName === '인체 연성', '부활 투표 시작');
  vote(g, 0, 2, true); // 독재 사용 시도
  vote(g, 1, 3);
  await g.waitPhase('MAIN');
  await g.settle();
  t.note(`부활: ${[2, 3].filter((i) => g.p(i).isAlive).map((i) => g.c(i).name).join(', ')}`);
  t.expectEq(g.hand(0), ['독재'], "'생존자 회의'가 없는 인체 연성에서는 독재가 발동/소모되지 않아야 함");
});

scenario('인체 연성: 죽은 플레이어의 투표로 부활 투표가 조기 종료되지 않는다', { card: '인체 연성', rule: R_TRANS + ' (모든 생존자가 힘을 합쳐)' }, async (t) => {
  const g = await t.game({ players: 4, dead: [2, 3], hands: { 0: ['코인', '코인'], 1: ['코인', '코인'] }, deck: ['인체 연성'] });
  await startSubmission(g, '인체 연성');
  submit(g, 0, idsOf(g, 0, '코인'));
  submit(g, 1, idsOf(g, 1, '코인'));
  await g.waitFor(() => pa(g)?.type === 'VOTE' && pa(g)?.eventName === '인체 연성', '부활 투표 시작');
  vote(g, 0, 2);
  vote(g, 3, 3); // 죽은 라온이 자기 자신에게
  await g.settle();
  t.expect(
    pa(g)?.type === 'VOTE',
    `생존자 나래가 아직 투표하지 않았으므로 투표가 계속되어야 함 (실제 phase=${g.room.phase}, 부활: ${[2, 3].filter((i) => g.p(i).isAlive).map((i) => g.c(i).name).join(', ') || '없음'})`,
  );
  vote(g, 1, 2);
  await g.waitPhase('MAIN');
  t.expect(g.p(2).isAlive && !g.p(3).isAlive, '생존자 2표를 받은 다온만 부활');
});

scenario('인체 연성: 죽은 자는 제물을 바칠 수 없다', { card: '인체 연성', rule: R_TRANS + ' (모든 생존자가)' }, async (t) => {
  const g = await t.game({ players: 3, dead: [2], hands: { 2: ['코인', '성배', '복권'] }, deck: ['인체 연성'] });
  await startSubmission(g, '인체 연성');
  submit(g, 2, g.handCards(2).map((c) => c.id));
  await g.settle();
  t.expectEq(g.hand(2).length, 3, '죽은 다온의 카드는 그대로');
  t.expectEq(pa(g)?.type, 'CARD_SUBMISSION', '제출 대기 계속');
});

// 2026-10-23 확인: "참가자 수"는 사망자를 포함한 전체 참가 인원.
scenario('인체 연성: 3인 게임에서 1명이 죽었으면 3장을 바쳐야 하며 2장이면 실패한다', {
  card: '인체 연성',
  rule: R_TRANS,
}, async (t) => {
  const g = await t.game({ players: 3, dead: [2], hands: { 0: ['코인'], 1: ['코인'] }, deck: ['인체 연성'] });
  await startSubmission(g, '인체 연성');
  submit(g, 0, [g.cardId(0, '코인')]);
  submit(g, 1, [g.cardId(1, '코인')]);
  await g.waitFor(() => pa(g)?.type === 'VOTE' || g.room.phase === 'MAIN', '판정', 4000);
  t.note(
    pa(g)?.type === 'VOTE'
      ? '현재 동작: 2장(생존자 2명) 제출 → 성공, 부활 투표 진행 (생존자 수 기준)'
      : '현재 동작: 2장 제출 → 실패 (전체 참가자 3명 기준)',
  );
  t.expect(pa(g)?.type !== 'VOTE', '참가자 3명 기준이므로 2장은 실패 → 부활 투표가 열리면 안 됨');
});

scenario('인체 연성: 긴급탈출키트로 취소하면 바친 카드를 돌려받는다', { card: '인체 연성', rule: R_KIT }, async (t) => {
  const g = await t.game({ players: 3, dead: [2], hands: { 0: ['코인', '성배'], 1: ['긴급탈출키트'] }, deck: ['인체 연성'] });
  await startSubmission(g, '인체 연성');
  submit(g, 0, g.handCards(0).map((c) => c.id));
  await g.settle();
  g.c(1).act('interrupt_action', g.cardId(1, '긴급탈출키트'));
  await g.waitPhase('MAIN');
  await g.settle();
  t.expectEq(g.hand(0).sort(), ['코인', '성배'].sort(), '바친 카드 반환');
  t.expect(!g.p(2).isAlive, '부활 없음');
});

scenario('인체 연성: cardIds 없이 submit_cards를 보내도 서버가 죽지 않는다', { card: '인체 연성', rule: R_TRANS }, async (t) => {
  const g = await t.game({ players: 3, dead: [2], hands: { 0: ['코인', '성배'] }, deck: ['인체 연성'] });
  await startSubmission(g, '인체 연성');
  g.c(1).act('submit_cards'); // cardIds = undefined (조작된 클라이언트)
  await g.settle();
  t.expect(pa(g)?.eventName === '인체 연성', '인체 연성 계속 진행');
  await g.waitFor(() => g.room.phase === 'MAIN', '제한시간 후 판정', 4000);
});
