import { scenario } from '../harness/runner';
import type { GameCtx } from '../harness/game';
import type { ScenarioApi } from '../harness/runner';

// 08: 기타 이벤트 — 엑스칼리버, 예언, 무소유, 난투, 눈 없는 괴물, 화살 함정
// 규칙(card.json)대로의 동작을 단언합니다. 실패 = 현재 구현이 규칙과 다름.

const RULE = {
  엑스: '이 검은 모든 방패를 뚫을 수 있습니다. 이 검을 얻고 싶다면 악의가 0장인 채로 가장 빠르게 자신의 모든 패를 공개해야 합니다.',
  엑스상세: "패에 성공적으로 추가하면 일반 도구 카드인 '특수 무기'로 취급됩니다.",
  누군가: '(누군가의 뼈/방패/로켓) 이 무기(방패·보물)는 악의인 동시에 무기(방패·보물)입니다.',
  선의: '(선의) 이 카드를 지니고 있다면 악의를 1장 줄여 계산합니다. … (단, 이 카드만으로 악의 판정을 유리하게 우회하여 이벤트를 회피할 수는 없음)',
  예언: '이 카드를 뽑은 자는 카드를 참가자 수만큼 뽑아 미리 봅니다. 그 후 카드를 원하는 순서대로 바꿔 올려놓습니다.',
  무소유: '모든 생존자는 이 카드를 뽑은 자의 패를 순서대로 1장씩 뒷면으로 뽑아갑니다. 패가 전부 사라질 때까지 반복합니다.',
  난투: '큰 싸움이 벌어졌습니다! 지금은 자신의 차례가 아닐지라도 누구나 무기를 사용할 수 있습니다. 무기의 사용 횟수 제한도 없습니다.',
  난투상세: '이벤트가 진행되는 동안 모든 생존자가 차례 제약 없이 난투를 벌일 수 있습니다.',
  괴물: '숨을 죽여야 합니다! 소리를 낸 생존자는 괴물에게 들켜 죽게 됩니다. 이 괴물에게 누군가가 죽거나 이 카드를 뽑은 자의 차례가 돌아오면 괴물이 돌아갑니다.',
  괴물상세: '카드를 공개하고 읽어주는 기본 진행 행위로는 소리를 낸 것으로 취급하지 않아 죽지 않습니다.',
  화살: '당신은 함정의 작동 장치를 밟았습니다! 날아오는 화살들을 생존자 중 한 명이 방패로 막지 않는다면 이 카드를 뽑은 자는 죽게 됩니다.',
  화살상세: "자신이 방패가 없더라도 다른 생존자가 '방패'를 사용하여 대신 막아줄 수 있습니다.",
  수호천사: '(수호천사) 타인이 공격받는 상황(이벤트의 화살 함정 포함)에서 차례를 무시하고 개입하여 방어해 줄 수 있습니다.',
  인간방패: '(인간 방패) 이 카드를 사용하면 다른 생존자를 방패로 사용해 희생시킵니다. 단 방패로 선택된 자도 방패를 사용해 공격을 막을 수 있습니다.',
  긴급: '(긴급탈출키트) 이 카드를 사용하면 이벤트를 한 개 취소합니다. 자신의 차례가 아니거나 이벤트가 진행 중 일지라도 사용 가능합니다.',
  인체연성: '(인체 연성) 모든 생존자가 힘을 합쳐 참가자 수만큼 악의를 제외한 카드를 버리면 죽은 자를 한 명 부활시킵니다.',
};

// ── 도우미 ──────────────────────────────────────────────────────────

const sorted = (a: string[]) => [...a].sort();
const pa = (g: GameCtx): any => g.room.pendingAction as any;
const inGrave = (g: GameCtx, name: string) => g.room.graveyard.some((c) => c.name === name);

/** i번이 카드를 뽑고 events_triggered를 받을 때까지 기다립니다. */
async function drawEvent(g: GameCtx, i = 0): Promise<void> {
  const before = g.c(i).eventsOf('events_triggered').length;
  g.c(i).act('draw_card');
  await g.waitFor(() => g.c(i).eventsOf('events_triggered').length > before, `${g.c(i).name} 이벤트 발동`);
}

/** i번이 일반 카드를 뽑습니다 (이벤트가 아닌 카드가 나와야 함). */
async function drawNormal(g: GameCtx, i: number): Promise<void> {
  g.c(i).act('draw_card');
  await g.waitFor(() => g.p(i).hasDrawnThisTurn, `${g.c(i).name} 드로우`);
}

async function endTurnTo(g: GameCtx, from: number, to: number): Promise<void> {
  g.c(from).act('end_turn');
  await g.waitFor(() => g.room.currentTurnPlayerId === g.c(to).id && g.room.phase === 'MAIN', `${g.c(to).name}의 차례`);
}

/** 이벤트가 끝난 뒤 뽑은 자가 다시 뽑을 수 있어야 합니다 (이벤트는 드로우로 치지 않음). */
async function drawAgain(t: ScenarioApi, g: GameCtx, i = 0): Promise<void> {
  t.expectEq(g.room.currentTurnPlayerId, g.c(i).id, `이벤트 후에도 ${g.c(i).name}의 차례여야 함`);
  t.expect(!g.p(i).hasDrawnThisTurn, `이벤트 후 ${g.c(i).name}은(는) 아직 뽑지 않은 상태여야 함`);
  const n = g.hand(i).length;
  g.c(i).act('draw_card');
  await g.waitFor(() => g.p(i).hasDrawnThisTurn, `${g.c(i).name} 다시 뽑기`);
  t.expectEq(g.hand(i).length, n + 1, '다시 뽑은 카드가 패에 들어와야 함');
}

function hasExcalibur(g: GameCtx, i: number): boolean {
  return g.p(i).hand.weapons.some((c) => c.name === '엑스칼리버');
}

function excaliburCount(g: GameCtx): number {
  return g.clients.reduce((n, _, i) => n + g.p(i).hand.weapons.filter((c) => c.name === '엑스칼리버').length, 0);
}

async function startExcalibur(g: GameCtx, drawer = 0): Promise<void> {
  await drawEvent(g, drawer);
  await g.waitFor(() => pa(g)?.eventName === '엑스칼리버', '엑스칼리버 레이스 시작');
}

function lastMsg(g: GameCtx, i: number, includes: string): boolean {
  return g.msgs(i).some((m) => m.includes(includes));
}

async function startProphecy(g: GameCtx, drawer = 0): Promise<any[]> {
  await drawEvent(g, drawer);
  await g.waitFor(() => g.requests(drawer, 'request_prophecy').length > 0, '예언 요청');
  const r = g.requests(drawer, 'request_prophecy');
  return r[r.length - 1][1] as any[];
}

/** 덱 맨 위부터 n장의 이름 (다음 드로우 순서). */
function deckTop(g: GameCtx, n: number): string[] {
  return g.room.deck.slice(-n).reverse().map((c) => c.name);
}

async function waitMusoyu(g: GameCtx): Promise<void> {
  await g.waitFor(() => g.room.phase === 'MAIN' && !g.room.pendingAction, '무소유 분배 완료');
}

/** attacker가 weaponName으로 target을 공격하고 방어 단계까지 기다립니다. */
async function attack(g: GameCtx, attacker: number, weaponName: string, target: number): Promise<void> {
  g.c(attacker).act('play_tool', g.cardId(attacker, weaponName), g.c(target).id);
  await g.waitFor(() => g.room.phase === 'WAITING_FOR_DEFENSE' && pa(g)?.targetId === g.c(target).id, `${g.c(attacker).name}→${g.c(target).name} 공격`);
}

async function attackAndKill(g: GameCtx, attacker: number, weaponName: string, target: number): Promise<void> {
  await attack(g, attacker, weaponName, target);
  g.c(target).act('skip_defense');
  await g.waitFor(() => !g.p(target).isAlive, `${g.c(target).name} 사망`);
  await g.waitFor(() => g.room.phase !== 'WAITING_FOR_DEFENSE', '방어 단계 종료');
}

async function startArrow(g: GameCtx, drawer = 0): Promise<void> {
  await drawEvent(g, drawer);
  await g.waitPhase('WAITING_FOR_DEFENSE');
  if (pa(g)?.eventName !== '화살 함정') throw new Error('화살 함정 방어 단계가 아님');
}

// ════════════════════════════════════════════════════════════════════
// 엑스칼리버
// ════════════════════════════════════════════════════════════════════

scenario('엑스칼리버: 모든 생존자에게 획득 요청이 가고 악의 0장인 생존자가 공개하면 엑스칼리버를 얻는다', {
  card: '엑스칼리버',
  rule: `${RULE.엑스} / ${RULE.엑스상세}`,
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['황금 방패', '성배'] }, deck: ['엑스칼리버'] });
  await startExcalibur(g, 0);
  await g.waitFor(() => [0, 1, 2].every((i) => g.requests(i, 'request_excalibur').length > 0), '모든 생존자에게 엑스칼리버 요청');
  t.expectEq(g.room.phase, 'RESOLVING_EVENT', '엑스칼리버 레이스 중');
  g.c(1).act('claim_excalibur');
  await g.waitFor(() => hasExcalibur(g, 1), '나래가 엑스칼리버 획득');
  await g.waitPhase('MAIN');
  await g.settle();
  t.expectEq(sorted(g.hand(1)), sorted(['황금 방패', '성배', '엑스칼리버']), '공개한 패는 그대로 두고 엑스칼리버가 무기로 추가됨');
  const ex = g.p(1).hand.weapons.find((c) => c.name === '엑스칼리버') as any;
  t.expectEq(ex?.category, 'TOOL', '엑스칼리버는 도구 카드');
  t.expectEq(ex?.toolType, 'WEAPON', '엑스칼리버는 무기');
  t.expectEq(g.p(1).currentMalice, 0, '엑스칼리버는 악의가 아님');
  t.expectEq(g.room.pendingAction, null, '이벤트 종료');
  await drawAgain(t, g, 0);
});

scenario('엑스칼리버: 가장 먼저 공개한 한 명만 얻는다', {
  card: '엑스칼리버',
  rule: RULE.엑스,
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['성배'], 2: ['복권'] }, deck: ['엑스칼리버'] });
  await startExcalibur(g, 0);
  g.c(2).act('claim_excalibur');
  g.c(1).act('claim_excalibur');
  g.c(0).act('claim_excalibur');
  await g.waitFor(() => hasExcalibur(g, 2), '다온이 엑스칼리버 획득');
  await g.settle();
  t.expect(!hasExcalibur(g, 1), '두 번째로 공개한 나래는 얻지 못해야 함');
  t.expect(!hasExcalibur(g, 0), '세 번째로 공개한 가람은 얻지 못해야 함');
  t.expectEq(excaliburCount(g), 1, '엑스칼리버는 방 전체에 1자루');
});

scenario('엑스칼리버: 악의 카드를 가진 생존자는 선의가 있어도 얻을 수 없고 레이스는 계속된다', {
  card: '엑스칼리버',
  rule: `${RULE.엑스} / ${RULE.선의}`,
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['시선', '선의'], 2: ['성배'] }, deck: ['엑스칼리버'] });
  t.expectEq(g.p(1).currentMalice, 0, '전제: 선의로 악의 점수 0');
  await startExcalibur(g, 0);
  g.c(1).act('claim_excalibur');
  await g.settle();
  t.expect(!hasExcalibur(g, 1), '악의(시선)를 가진 나래는 얻을 수 없음');
  t.expectEq(pa(g)?.eventName, '엑스칼리버', '레이스는 계속 진행 중');
  t.expect(lastMsg(g, 1, '엑스칼리버를 획득할 수 없습니다'), '거절 안내를 받아야 함');
  g.c(2).act('claim_excalibur');
  await g.waitFor(() => hasExcalibur(g, 2), '다온이 엑스칼리버 획득');
});

scenario('엑스칼리버: 누군가의 뼈만 가진 생존자는 얻을 수 없다', {
  card: '엑스칼리버',
  rule: `${RULE.엑스} / ${RULE.누군가}`,
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['누군가의 뼈'] }, deck: ['엑스칼리버'] });
  await startExcalibur(g, 0);
  g.c(1).act('claim_excalibur');
  await g.settle();
  t.expect(!hasExcalibur(g, 1), '악의 겸 무기를 가진 나래는 얻을 수 없음');
  t.expectEq(pa(g)?.eventName, '엑스칼리버', '레이스는 계속 진행 중');
});

scenario('엑스칼리버: 누군가의 뼈를 가진 생존자는 선의로 악의 점수가 0이어도 얻을 수 없다', {
  card: '엑스칼리버',
  rule: `${RULE.엑스} / ${RULE.누군가} / ${RULE.선의}`,
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['누군가의 뼈', '선의'] }, deck: ['엑스칼리버'] });
  t.expectEq(g.p(1).currentMalice, 0, '전제: 선의로 악의 점수 0');
  await startExcalibur(g, 0);
  g.c(1).act('claim_excalibur');
  await g.settle();
  t.note(`claim 후 나래 패: ${g.hand(1).join(', ')} / 단계: ${g.room.phase}`);
  t.expect(!hasExcalibur(g, 1), '누군가의 뼈(악의 1장)를 가진 나래는 엑스칼리버를 얻을 수 없어야 함');
  t.expectEq(pa(g)?.eventName, '엑스칼리버', '레이스는 계속 진행 중이어야 함');
});

scenario('엑스칼리버: 누군가의 방패·누군가의 로켓을 가진 생존자는 선의로 악의 점수가 0이어도 얻을 수 없다', {
  card: '엑스칼리버',
  rule: `${RULE.엑스} / ${RULE.누군가} / ${RULE.선의}`,
}, async (t) => {
  const granted: string[] = [];
  for (const tool of ['누군가의 방패', '누군가의 로켓']) {
    const g = await t.game({ players: 3, hands: { 1: [tool, '선의'] }, deck: ['엑스칼리버'] });
    await startExcalibur(g, 0);
    g.c(1).act('claim_excalibur');
    await g.settle();
    t.note(`${tool}+선의: 악의 점수 ${g.p(1).currentMalice}, claim 후 엑스칼리버 보유=${hasExcalibur(g, 1)}`);
    if (hasExcalibur(g, 1)) granted.push(tool);
  }
  t.expectEq(granted, [], '악의 겸 도구(악의 1장)를 가진 생존자는 엑스칼리버를 얻을 수 없어야 함 — 얻은 경우');
});

scenario('엑스칼리버: 모든 생존자가 포기하면 엑스칼리버는 사라지고 뽑은 자가 다시 뽑는다', {
  card: '엑스칼리버',
  rule: RULE.엑스,
}, async (t) => {
  const g = await t.game({ players: 3, deck: ['엑스칼리버'] });
  await startExcalibur(g, 0);
  g.c(0).act('skip_excalibur');
  g.c(1).act('skip_excalibur');
  await g.settle();
  t.expectEq(pa(g)?.eventName, '엑스칼리버', '아직 한 명이 남아 있으면 계속 진행');
  g.c(2).act('skip_excalibur');
  await g.waitPhase('MAIN');
  await g.settle();
  t.expectEq(excaliburCount(g), 0, '아무도 엑스칼리버를 갖지 않음');
  await drawAgain(t, g, 0);
});

scenario('엑스칼리버: 아무도 공개하지 않고 시간이 지나면 사라진다', {
  card: '엑스칼리버',
  rule: RULE.엑스,
}, async (t) => {
  const g = await t.game({ players: 3, deck: ['엑스칼리버'] });
  await startExcalibur(g, 0);
  await g.waitServerMs(30000);
  await g.waitPhase('MAIN');
  t.expectEq(excaliburCount(g), 0, '아무도 엑스칼리버를 갖지 않음');
  await drawAgain(t, g, 0);
});

scenario('엑스칼리버: 죽은 자는 공개해도 얻을 수 없고 포기도 인원수에 들어가지 않는다', {
  card: '엑스칼리버',
  rule: RULE.엑스,
}, async (t) => {
  const g = await t.game({ players: 4, dead: [3], deck: ['엑스칼리버'] });
  await startExcalibur(g, 0);
  await g.settle();
  t.note(`죽은 라온이 받은 request_excalibur: ${g.requests(3, 'request_excalibur').length}회`);
  g.c(3).act('claim_excalibur');
  await g.settle();
  t.expect(!hasExcalibur(g, 3), '죽은 라온은 얻을 수 없음');
  g.c(3).act('skip_excalibur');
  g.c(0).act('skip_excalibur');
  g.c(1).act('skip_excalibur');
  await g.settle();
  t.expectEq(pa(g)?.eventName, '엑스칼리버', '살아 있는 다온이 아직 결정하지 않았으므로 계속 진행');
  g.c(2).act('skip_excalibur');
  await g.waitPhase('MAIN');
});

scenario('엑스칼리버: 이벤트가 없을 때의 획득 요청은 무시된다', {
  card: '엑스칼리버',
  rule: RULE.엑스,
}, async (t) => {
  const g = await t.game({ players: 3 });
  g.c(1).act('claim_excalibur');
  g.c(1).act('skip_excalibur');
  await g.settle();
  t.expectEq(excaliburCount(g), 0, '엑스칼리버가 생기면 안 됨');
  t.expectEq(g.room.phase, 'MAIN', '단계 변화 없음');
});

scenario('엑스칼리버: 얻은 엑스칼리버는 일반·거울·수호천사 방패로 막을 수 없다', {
  card: '엑스칼리버',
  rule: RULE.엑스,
}, async (t) => {
  const g = await t.game({ players: 4, hands: { 1: ['황금 방패', '거울 방패'], 2: ['수호천사'] }, deck: ['엑스칼리버'] });
  await startExcalibur(g, 0);
  g.c(0).act('claim_excalibur');
  await g.waitFor(() => hasExcalibur(g, 0), '가람이 엑스칼리버 획득');
  await g.waitPhase('MAIN');
  await attack(g, 0, '엑스칼리버', 1);
  t.expectEq(pa(g)?.weaponCard?.name, '엑스칼리버', '공격 무기는 엑스칼리버');
  g.c(1).act('play_shield', g.cardId(1, '황금 방패'));
  g.c(1).act('play_shield', g.cardId(1, '거울 방패'));
  g.c(2).act('play_shield', g.cardId(2, '수호천사'));
  await g.settle();
  t.expectEq(g.room.phase, 'WAITING_FOR_DEFENSE', '방패가 통하지 않아 방어 단계 유지');
  t.expectEq(sorted(g.hand(1)), sorted(['황금 방패', '거울 방패']), '막지 못한 방패는 패에 남아야 함');
  t.expectEq(g.hand(2), ['수호천사'], '수호천사도 패에 남아야 함');
  g.c(1).act('skip_defense');
  g.c(2).act('skip_defense');
  await g.waitFor(() => !g.p(1).isAlive, '나래 사망');
  await g.waitPhase('MAIN');
  t.expect(g.p(0).isAlive && g.p(2).isAlive, '가람과 다온은 생존');
  t.expect(inGrave(g, '엑스칼리버'), '사용한 엑스칼리버는 무덤으로');
});

scenario('엑스칼리버: 얻은 엑스칼리버는 일반 무기처럼 차례당 1회 공격에 포함된다', {
  card: '엑스칼리버',
  rule: RULE.엑스상세,
}, async (t) => {
  const g = await t.game({ players: 4, hands: { 0: ['성정'] }, deck: ['엑스칼리버'] });
  await startExcalibur(g, 0);
  g.c(0).act('claim_excalibur');
  await g.waitFor(() => hasExcalibur(g, 0), '가람이 엑스칼리버 획득');
  await g.waitPhase('MAIN');
  await attackAndKill(g, 0, '엑스칼리버', 1);
  await g.waitPhase('MAIN');
  t.expect(inGrave(g, '엑스칼리버'), '사용한 엑스칼리버는 무덤으로');
  g.c(0).act('play_tool', g.cardId(0, '성정'), g.c(2).id);
  await g.settle();
  t.expectEq(g.room.phase, 'MAIN', '같은 차례에 두 번째 무기는 쓸 수 없음');
  t.expectEq(g.hand(0), ['성정'], '성정은 패에 남음');
});

scenario('엑스칼리버: (조작 클라이언트) submit_cards로 낸 카드는 사라지지 않는다', {
  card: '엑스칼리버',
  rule: `${RULE.엑스} — 패를 "공개"하는 것이지 버리는 것이 아님`,
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['황금 방패', '성배'] }, deck: ['엑스칼리버'] });
  await startExcalibur(g, 0);
  g.c(1).act('submit_cards', g.handCards(1).map((c) => c.id));
  await g.settle();
  await g.waitServerMs(30000);
  await g.waitPhase('MAIN');
  await g.settle();
  g.check();
  t.note(`submit_cards 후 나래 패: ${g.hand(1).join(', ') || '없음'} / 무덤: ${g.room.graveyard.map((c) => c.name).join(', ')}`);
  for (const name of ['황금 방패', '성배']) {
    t.expect(g.hand(1).includes(name) || inGrave(g, name), `${name}이(가) 나래의 패(또는 최소한 무덤)에 있어야 함 — 게임에서 증발함`);
  }
  t.expect(g.hand(1).includes('황금 방패') && g.hand(1).includes('성배'), '공개만 한 카드는 나래의 패로 돌아와야 함');
});

scenario('엑스칼리버: (조작 클라이언트) 악의를 submit_cards로 내버린 뒤 공개해도 얻을 수 없다', {
  card: '엑스칼리버',
  rule: RULE.엑스,
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['시선', '황금 방패'] }, deck: ['엑스칼리버'] });
  await startExcalibur(g, 0);
  g.c(1).act('submit_cards', [g.cardId(1, '시선')]);
  await g.settle();
  t.note(`submit_cards 후 나래 패: ${g.hand(1).join(', ')} / 악의 ${g.p(1).currentMalice}`);
  g.c(1).act('claim_excalibur');
  await g.settle();
  await g.waitServerMs(30000);
  await g.settle();
  g.check();
  t.note(`claim 후 나래 패: ${g.hand(1).join(', ')} / 단계 ${g.room.phase}`);
  t.expect(!hasExcalibur(g, 1), '악의(시선)를 가지고 있던 나래는 엑스칼리버를 얻을 수 없어야 함');
  t.expect(g.hand(1).includes('시선'), '시선(악의)은 나래의 패에 남아 있어야 함 (악의 세탁 불가)');
});

scenario('엑스칼리버: 획득자의 패가 다른 생존자에게 실제로 공개되는가', {
  card: '엑스칼리버',
  rule: RULE.엑스,
  ambiguous: '엑스칼리버를 얻으려면 "자신의 모든 패를 공개"해야 하는데, 온라인에서는 획득자의 패 내용을 다른 생존자에게 보여줘야 하나요? (현재: 서버가 악의 여부만 검사하고 패 내용은 다른 사람에게 보여주지 않음)',
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['황금 방패', '성배'] }, deck: ['엑스칼리버'] });
  const since = Date.now();
  await startExcalibur(g, 0);
  g.c(1).act('claim_excalibur');
  await g.waitFor(() => hasExcalibur(g, 1), '나래가 엑스칼리버 획득');
  await g.settle();
  const states = g.c(2).eventsOf('game_state_update', since).map((e) => e.args[0]);
  const revealed = states.some((s: any) => s?.revealedCardsInfo?.playerId === g.c(1).id);
  const mentioned = g.msgs(2, since).some((m) => m.includes('황금 방패') || m.includes('성배'));
  t.note(`다온에게 나래의 패가 공개됨: revealedCardsInfo=${revealed}, 메시지에 카드명=${mentioned}`);
  t.expect(revealed || mentioned, '다른 생존자가 획득자의 패 내용을 볼 수 있어야 함');
});

// ════════════════════════════════════════════════════════════════════
// 예언
// ════════════════════════════════════════════════════════════════════

scenario('예언: 뽑은 자에게만 참가자 수만큼 덱 맨 위 카드가 뽑힐 순서대로 보인다', {
  card: '예언',
  rule: RULE.예언,
}, async (t) => {
  const g = await t.game({ players: 3, deck: ['예언', '황금 방패', '성정', '성배', '복권'] });
  const cards = await startProphecy(g, 0);
  await g.settle();
  t.expectEq(cards.map((c) => c.name), ['황금 방패', '성정', '성배'], '참가자 수(3)만큼, 다음에 뽑힐 순서대로');
  t.expectEq(g.requests(1, 'request_prophecy').length + g.requests(2, 'request_prophecy').length, 0, '다른 사람에게는 보이지 않음');
  t.expectEq(g.room.phase, 'RESOLVING_EVENT', '순서 결정 대기 중');
  t.expectEq(deckTop(g, 4), ['황금 방패', '성정', '성배', '복권'], '미리 보기만 하고 덱에서 빼지 않음');
});

scenario('예언: 순서를 바꿔 제출하면 그 순서대로 뽑힌다', {
  card: '예언',
  rule: RULE.예언,
}, async (t) => {
  const g = await t.game({ players: 3, deck: ['예언', '황금 방패', '성정', '성배', '복권'] });
  const cards = await startProphecy(g, 0);
  const byName = (n: string) => cards.find((c) => c.name === n).id;
  const deckLen = g.room.deck.length;
  g.c(0).act('submit_prophecy', [byName('성배'), byName('황금 방패'), byName('성정')]);
  await g.waitPhase('MAIN');
  await g.settle();
  t.expectEq(g.room.deck.length, deckLen, '덱 장수는 그대로');
  t.expectEq(deckTop(g, 4), ['성배', '황금 방패', '성정', '복권'], '바꾼 순서대로 올려놓고 그 아래는 그대로');
  await drawAgain(t, g, 0);
  t.expect(g.hand(0).includes('성배'), '가람이 다시 뽑은 카드는 맨 위로 올린 성배');
  g.c(0).act('end_turn');
  await g.waitFor(() => g.room.currentTurnPlayerId === g.c(1).id, '나래 차례');
  await drawNormal(g, 1);
  t.expect(g.hand(1).includes('황금 방패'), '다음 사람은 두 번째로 올린 황금 방패를 뽑음');
});

scenario('예언: 일부 id만 내거나 엉뚱한 id를 섞으면 나머지는 원래 순서로 뒤에 붙는다', {
  card: '예언',
  rule: RULE.예언,
}, async (t) => {
  const g = await t.game({ players: 3, deck: ['예언', '황금 방패', '성정', '성배', '복권'] });
  const cards = await startProphecy(g, 0);
  const byName = (n: string) => cards.find((c) => c.name === n).id;
  const deckLen = g.room.deck.length;
  g.c(0).act('submit_prophecy', ['없는-카드', byName('성배'), g.room.deck[0].id]);
  await g.waitPhase('MAIN');
  await g.settle();
  t.expectEq(g.room.deck.length, deckLen, '덱 장수는 그대로');
  t.expectEq(deckTop(g, 4), ['성배', '황금 방패', '성정', '복권'], '지정한 성배가 맨 위, 나머지는 원래 순서, 덱 깊은 곳 카드는 끌려오지 않음');
});

scenario('예언: (조작 클라이언트) 같은 id를 여러 번 보내도 카드가 복제되지 않는다', {
  card: '예언',
  rule: RULE.예언,
}, async (t) => {
  const g = await t.game({ players: 3, deck: ['예언', '황금 방패', '성정', '수호천사', '복권'] });
  const cards = await startProphecy(g, 0);
  const angel = cards.find((c) => c.name === '수호천사').id;
  const deckLen = g.room.deck.length;
  g.c(0).act('submit_prophecy', [angel, angel, angel, angel]);
  await g.waitPhase('MAIN');
  await g.settle();
  g.check();
  const angels = g.room.deck.filter((c) => c.name === '수호천사').length;
  t.note(`제출 후 덱 장수 ${deckLen} → ${g.room.deck.length}, 덱 안 수호천사 ${angels}장, 맨 위 6장: ${deckTop(g, 6).join(', ')}`);
  t.expectEq(g.room.deck.length, deckLen, '덱 장수는 그대로여야 함');
  t.expectEq(angels, 1, '수호천사는 1장뿐이어야 함');
});

scenario('예언: (조작 클라이언트) 배열이 아닌 값을 보내도 서버가 죽지 않는다', {
  card: '예언',
  rule: RULE.예언,
}, async (t) => {
  const g = await t.game({ players: 3, deck: ['예언', '황금 방패', '성정', '성배'] });
  await startProphecy(g, 0);
  g.c(0).act('submit_prophecy', null);
  await g.settle();
  await g.waitServerMs(30000);
  await g.waitPhase('MAIN');
  t.expectEq(deckTop(g, 3), ['황금 방패', '성정', '성배'], '잘못된 입력이면 원래 순서 유지');
});

scenario('예언: 뽑은 자가 아닌 사람의 순서 제출은 무시된다', {
  card: '예언',
  rule: RULE.예언,
}, async (t) => {
  const g = await t.game({ players: 3, deck: ['예언', '황금 방패', '성정', '성배'] });
  const cards = await startProphecy(g, 0);
  const byName = (n: string) => cards.find((c) => c.name === n).id;
  g.c(1).act('submit_prophecy', [byName('성배'), byName('성정'), byName('황금 방패')]);
  await g.settle();
  t.expectEq(g.room.phase, 'RESOLVING_EVENT', '다른 사람의 제출로 끝나지 않음');
  t.expectEq(deckTop(g, 3), ['황금 방패', '성정', '성배'], '덱 순서 그대로');
  g.c(0).act('submit_prophecy', [byName('성정'), byName('성배'), byName('황금 방패')]);
  await g.waitPhase('MAIN');
  t.expectEq(deckTop(g, 3), ['성정', '성배', '황금 방패'], '뽑은 자의 제출은 반영');
});

scenario('예언: 시간이 지나면 원래 순서 그대로 두고 뽑은 자가 다시 뽑는다', {
  card: '예언',
  rule: RULE.예언,
}, async (t) => {
  const g = await t.game({ players: 3, deck: ['예언', '황금 방패', '성정', '성배'] });
  await startProphecy(g, 0);
  await g.waitServerMs(30000);
  await g.waitPhase('MAIN');
  t.expectEq(deckTop(g, 3), ['황금 방패', '성정', '성배'], '덱 순서 그대로');
  await drawAgain(t, g, 0);
  t.expect(g.hand(0).includes('황금 방패'), '원래 맨 위 카드를 뽑음');
});

scenario('예언: 덱이 참가자 수보다 적으면 남은 카드만 보여준다', {
  card: '예언',
  rule: RULE.예언,
}, async (t) => {
  const g = await t.game({ players: 3, deck: ['예언', '황금 방패', '성정'], filler: 0 });
  const cards = await startProphecy(g, 0);
  t.expectEq(cards.map((c) => c.name), ['황금 방패', '성정'], '남은 2장만');
  g.c(0).act('submit_prophecy', [cards[1].id, cards[0].id]);
  await g.waitPhase('MAIN');
  t.expectEq(deckTop(g, 2), ['성정', '황금 방패'], '바꾼 순서 반영');
  t.expectEq(g.room.deck.length, 2, '덱 장수 그대로');
});

// 2026-10-23 확인: "참가자 수"는 사망자를 포함한 전체 참가 인원.
scenario('예언: 죽은 참가자도 "참가자 수"에 들어간다', {
  card: '예언',
  rule: RULE.예언,
}, async (t) => {
  const g = await t.game({ players: 4, dead: [3], deck: ['예언', '황금 방패', '성정', '성배', '복권', '골든 레코드'] });
  const cards = await startProphecy(g, 0);
  t.note(`4명 중 1명 사망 상태에서 예언으로 본 카드 ${cards.length}장: ${cards.map((c) => c.name).join(', ')}`);
  t.expectEq(cards.length, 4, '참가 인원(4명)만큼 보여주는 해석');
});

// ════════════════════════════════════════════════════════════════════
// 무소유
// ════════════════════════════════════════════════════════════════════

scenario('무소유: 뽑은 자의 패가 다른 생존자들에게 1장씩 모두 나뉘고 뽑은 자는 빈손이 된다', {
  card: '무소유',
  rule: RULE.무소유,
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['시선', '황금 방패', '성배', '성정'], 1: ['복권'] }, deck: ['무소유'] });
  const originalIds = g.handCards(0).map((c) => c.id);
  await drawEvent(g, 0);
  await waitMusoyu(g);
  await g.settle();
  t.expectEq(g.hand(0), [], '뽑은 자의 패는 모두 사라짐');
  t.expectEq(g.hand(1).length, 3, '나래: 원래 1장 + 2장');
  t.expectEq(g.hand(2).length, 2, '다온: 2장');
  const received = [...g.handCards(1), ...g.handCards(2)].map((c) => c.id);
  for (const id of originalIds) t.expect(received.includes(id), `가람의 카드 ${id}가 다른 생존자에게 있어야 함`);
  const holder = [1, 2].find((i) => g.hand(i).includes('시선'))!;
  t.expectEq(g.p(holder).currentMalice, 1, '시선을 받은 사람의 악의가 갱신됨');
  t.expectEq(g.p(0).currentMalice, 0, '가람의 악의 0');
  await drawAgain(t, g, 0);
});

scenario('무소유: 죽은 자는 카드를 받지 않는다', {
  card: '무소유',
  rule: RULE.무소유,
}, async (t) => {
  const g = await t.game({ players: 4, dead: [3], hands: { 0: ['시선', '황금 방패', '성배', '성정'], 3: ['복권'] }, deck: ['무소유'] });
  await drawEvent(g, 0);
  await waitMusoyu(g);
  await g.settle();
  t.expectEq(g.hand(0), [], '가람 빈손');
  t.expectEq(g.hand(1).length, 2, '나래 2장');
  t.expectEq(g.hand(2).length, 2, '다온 2장');
  t.expectEq(g.hand(3), ['복권'], '죽은 라온의 패는 그대로');
});

scenario('무소유: 뽑은 자의 패가 비어 있으면 아무 일 없이 끝나고 다시 뽑는다', {
  card: '무소유',
  rule: RULE.무소유,
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['복권'] }, deck: ['무소유'] });
  await drawEvent(g, 0);
  await waitMusoyu(g);
  await g.settle();
  t.expectEq(g.hand(1), ['복권'], '다른 사람 패 변화 없음');
  t.expectEq(g.hand(2), [], '다른 사람 패 변화 없음');
  await drawAgain(t, g, 0);
});

scenario('무소유: 분배는 뽑은 자 다음 차례의 생존자부터 시작하는가', {
  card: '무소유',
  rule: RULE.무소유,
  ambiguous: '무소유의 "순서대로"는 뽑은 자의 다음 차례 생존자부터 시작하나요, 아니면 좌석 맨 앞(첫 번째 플레이어)부터인가요? 카드가 생존자 수로 나누어떨어지지 않으면 누가 1장 더 받는지가 달라집니다. (현재: 좌석 0번부터 분배)',
}, async (t) => {
  const g = await t.game({ players: 4, turn: 2, hands: { 2: ['시선', '황금 방패', '성배', '성정'] }, deck: ['무소유'] });
  await drawEvent(g, 2);
  await waitMusoyu(g);
  await g.settle();
  const counts = [0, 1, 3].map((i) => `${g.c(i).name}=${g.hand(i).length}`).join(', ');
  t.note(`다온(2번)이 4장을 분배: ${counts}`);
  t.expectEq(g.hand(3).length, 2, '다온 다음 차례인 라온부터 받으면 라온이 2장');
});

scenario('무소유: (조작 클라이언트) submit_cards로 낸 카드가 사라지지 않는다', {
  card: '무소유',
  rule: RULE.무소유,
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성배'], 1: ['시선', '복권'] }, deck: ['무소유'] });
  await drawEvent(g, 0);
  g.c(1).act('submit_cards', [g.cardId(1, '시선')]);
  await waitMusoyu(g);
  await g.settle();
  g.check();
  t.note(`무소유 후 나래 패: ${g.hand(1).join(', ')} / 악의 ${g.p(1).currentMalice}`);
  t.expect(g.hand(1).includes('시선'), '무소유와 관계없는 나래의 시선(악의)은 패에 남아 있어야 함');
});

// ════════════════════════════════════════════════════════════════════
// 난투
// ════════════════════════════════════════════════════════════════════

scenario('난투: 차례가 아닌 생존자도 무기를 쓸 수 있다', {
  card: '난투',
  rule: `${RULE.난투} / ${RULE.난투상세}`,
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['성정'] }, deck: ['난투'] });
  await drawEvent(g, 0);
  await g.waitPhase('MAIN');
  t.expect(g.room.freeForAll, '난투 상태');
  await attackAndKill(g, 1, '성정', 2);
  await g.waitPhase('MAIN');
  t.expectEq(g.room.currentTurnPlayerId, g.c(0).id, '차례는 그대로 가람');
  t.expect(inGrave(g, '성정'), '사용한 무기는 무덤으로');
  await drawAgain(t, g, 0);
});

scenario('난투: 차례가 아닌 생존자도 무기를 횟수 제한 없이 쓸 수 있다', {
  card: '난투',
  rule: RULE.난투,
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['성정', '황금칼', '십자가#201'], 2: ['황금 방패', '골든 레코드'] }, deck: ['난투'] });
  await drawEvent(g, 0);
  await g.waitPhase('MAIN');
  await attack(g, 1, '성정', 2);
  g.c(2).act('play_shield', g.cardId(2, '황금 방패'));
  await g.waitPhase('MAIN');
  await attack(g, 1, '황금칼', 2);
  g.c(2).act('play_shield', g.cardId(2, '골든 레코드'));
  await g.waitPhase('MAIN');
  await attackAndKill(g, 1, '십자가', 2);
  t.expectEq(g.hand(1), [], '세 무기 모두 사용됨');
});

scenario('난투: 차례 주인도 한 차례에 무기를 여러 번 쓸 수 있다', {
  card: '난투',
  rule: RULE.난투,
}, async (t) => {
  const g = await t.game({ players: 4, hands: { 0: ['성정', '황금칼'] }, deck: ['난투'] });
  await drawEvent(g, 0);
  await g.waitPhase('MAIN');
  await attackAndKill(g, 0, '성정', 1);
  await g.waitPhase('MAIN');
  await attackAndKill(g, 0, '황금칼', 2);
  await g.waitPhase('MAIN');
  t.expect(g.p(0).isAlive && g.p(3).isAlive, '가람·라온 생존');
});

scenario('난투: 죽은 자는 무기를 쓸 수 없고 자신·죽은 자·없는 카드로는 공격할 수 없다', {
  card: '난투',
  rule: RULE.난투상세,
}, async (t) => {
  const g = await t.game({ players: 4, dead: [3], hands: { 1: ['성정'], 3: ['황금칼'] }, deck: ['난투'] });
  await drawEvent(g, 0);
  await g.waitPhase('MAIN');
  g.c(3).act('play_tool', g.cardId(3, '황금칼'), g.c(1).id);
  g.c(1).act('play_tool', g.cardId(1, '성정'), g.c(1).id);
  g.c(1).act('play_tool', g.cardId(1, '성정'), g.c(3).id);
  g.c(1).act('play_tool', 'no-such-card', g.c(2).id);
  g.c(2).act('play_tool', g.cardId(1, '성정'), g.c(0).id);
  await g.settle();
  t.expectEq(g.room.phase, 'MAIN', '모든 잘못된 공격은 거부');
  t.expectEq(g.hand(1), ['성정'], '나래의 성정 그대로');
  t.expectEq(g.hand(3), ['황금칼'], '라온의 황금칼 그대로');
  t.expect([0, 1, 2].every((i) => g.p(i).isAlive), '아무도 죽지 않음');
});

scenario('난투: 난투는 언제까지 지속되는가', {
  card: '난투',
  rule: `${RULE.난투} / ${RULE.난투상세}`,
  ambiguous: '난투("이벤트가 진행되는 동안")는 언제 끝나나요? (a) 뽑은 자의 차례가 끝날 때 (b) 한 바퀴 돌아 뽑은 자의 차례가 다시 올 때 (c) 그 밖의 시점. 현재는 뽑은 자의 차례가 끝나는 순간(nextTurn) 해제됩니다.',
}, async (t) => {
  const g = await t.game({ players: 4, hands: { 2: ['성정', '황금칼'] }, deck: ['난투'] });
  await drawEvent(g, 0);
  await g.waitPhase('MAIN');
  await attack(g, 2, '성정', 3);
  g.c(3).act('skip_defense');
  await g.waitPhase('MAIN');
  t.note(`뽑은 자 차례 중: 다온의 차례 밖 공격 성공=${!g.p(3).isAlive}`);
  await drawNormal(g, 0);
  await endTurnTo(g, 0, 1);
  t.note(`가람 차례 종료 후 freeForAll=${g.room.freeForAll}`);
  g.c(2).act('play_tool', g.cardId(2, '황금칼'), g.c(1).id);
  await g.settle();
  t.note(`나래 차례에 다온의 차례 밖 공격: ${g.room.phase === 'WAITING_FOR_DEFENSE' ? '허용' : '거부'}`);
  t.expect(g.room.freeForAll, '한 바퀴 동안 유지된다는 해석 (b)');
});

scenario('난투: 게임이 끝난 뒤에는 난투 중이었어도 무기를 쓸 수 없다', {
  card: '난투',
  rule: `${RULE.난투상세} (게임 종료 후에는 이벤트가 진행되지 않음)`,
}, async (t) => {
  // 턴 제한시간을 짧게(서버 40초 = 실제 2초) 두어, 종료 후 되살아난 MAIN 단계에서 턴 타이머가 어떻게 되는지도 기록합니다.
  const g = await t.game({ players: 3, hands: { 1: ['성정'] }, deck: ['난투'], filler: 0, turnDurationMs: 40000 });
  await drawEvent(g, 0);
  await g.waitPhase('MAIN');
  t.expect(g.room.freeForAll, '난투 상태');
  g.c(0).act('draw_card'); // 덱이 비어 던전 탈출로 게임 종료
  await g.waitPhase('ENDED');
  await g.waitFor(() => g.c(1).gameOvers.length > 0, '게임 종료 알림');
  await g.settle();
  g.check();
  t.note(`게임 종료 시 freeForAll=${g.room.freeForAll}`);
  g.c(1).act('play_tool', g.cardId(1, '성정'), g.c(2).id);
  await g.settle();
  g.check();
  const phaseAfterAttack = g.room.phase;
  t.note(`종료 후 공격 시도 → 단계 ${phaseAfterAttack}, 나래 패: ${g.hand(1).join(', ') || '없음'}`);
  if (phaseAfterAttack === 'WAITING_FOR_DEFENSE') {
    g.c(2).act('skip_defense');
    await g.settle();
    g.check();
    t.note(`방어 포기 후 → 단계 ${g.room.phase}, 다온 생존=${g.p(2).isAlive}, 현재 차례=${g.room.currentTurnPlayerId}`);
    g.c(0).act('start_game');
    await g.settle();
    t.note(`그 상태에서 start_game(재시작) → 단계 ${g.room.phase}`);
    await g.waitServerMs(40000);
    await g.settle();
    g.check();
    const cur = g.indexOf(g.room.currentTurnPlayerId);
    t.note(`턴 제한시간 경과 후 → 단계 ${g.room.phase}, 현재 차례=${cur >= 0 ? g.c(cur).name : g.room.currentTurnPlayerId}`);
  }
  t.expectEq(phaseAfterAttack, 'ENDED', '게임 종료 후 단계가 바뀌면 안 됨');
  t.expectEq(g.room.phase, 'ENDED', '게임 종료 상태 유지');
  t.expect(g.p(2).isAlive, '게임 종료 후 다온이 죽으면 안 됨');
  t.expectEq(g.hand(1), ['성정'], '성정은 사용되지 않아야 함');
});

scenario('난투: 차례 주인이 난투 중 다른 생존자의 무기에 죽으면 다음 생존자에게 차례가 넘어간다', {
  card: '난투',
  rule: RULE.난투,
}, async (t) => {
  const g = await t.game({ players: 4, hands: { 2: ['성정'] }, deck: ['난투'] });
  await drawEvent(g, 0);
  await g.waitPhase('MAIN');
  await attackAndKill(g, 2, '성정', 0);
  await g.waitFor(() => g.room.currentTurnPlayerId === g.c(1).id && g.room.phase === 'MAIN', '나래 차례');
  t.expect(!g.p(1).hasDrawnThisTurn, '나래는 아직 뽑지 않음');
  t.note(`차례가 넘어간 뒤 freeForAll=${g.room.freeForAll}`);
});

// ════════════════════════════════════════════════════════════════════
// 눈 없는 괴물
// ════════════════════════════════════════════════════════════════════

scenario('눈 없는 괴물: 소리를 낸(채팅한) 생존자는 죽고 괴물이 돌아간다', {
  card: '눈 없는 괴물',
  rule: RULE.괴물,
}, async (t) => {
  const g = await t.game({ players: 4, deck: ['눈 없는 괴물'] });
  await drawEvent(g, 0);
  await g.waitPhase('MAIN');
  t.expect(g.room.silenceMode, '괴물 등장');
  g.c(2).act('send_chat', '여기 누구 있어요?');
  await g.waitFor(() => !g.p(2).isAlive, '채팅한 다온 사망');
  await g.settle();
  t.expect(!g.room.silenceMode, '괴물에게 누군가 죽었으므로 괴물이 돌아감');
  t.expectEq(g.room.currentTurnPlayerId, g.c(0).id, '차례는 그대로 가람');
  g.c(1).act('send_chat', '이제 괜찮다');
  await g.settle();
  t.expect(g.p(1).isAlive, '괴물이 떠난 뒤 채팅은 안전');
  t.expect(g.msgs(0).some((m) => m.includes('이제 괜찮다')), '채팅이 정상 전달됨');
  await drawAgain(t, g, 0);
});

scenario('눈 없는 괴물: 죽은 자는 채팅해도 아무 일 없다', {
  card: '눈 없는 괴물',
  rule: RULE.괴물,
}, async (t) => {
  const g = await t.game({ players: 4, dead: [3], deck: ['눈 없는 괴물'] });
  await drawEvent(g, 0);
  await g.waitPhase('MAIN');
  g.c(3).act('send_chat', '우우우');
  await g.settle();
  t.expect([0, 1, 2].every((i) => g.p(i).isAlive), '아무도 죽지 않음');
  t.expect(g.room.silenceMode, '괴물은 그대로');
  t.expect(g.msgs(0).some((m) => m.includes('우우우')), '죽은 자의 채팅은 전달됨');
});

scenario('눈 없는 괴물: 카드를 뽑고 쓰는 기본 진행으로는 죽지 않는다', {
  card: '눈 없는 괴물',
  rule: `${RULE.괴물} / ${RULE.괴물상세}`,
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정'], 1: ['황금 방패'] }, deck: ['눈 없는 괴물'] });
  await drawEvent(g, 0);
  await g.waitPhase('MAIN');
  await drawNormal(g, 0);
  await attack(g, 0, '성정', 1);
  g.c(1).act('play_shield', g.cardId(1, '황금 방패'));
  await g.waitPhase('MAIN');
  await endTurnTo(g, 0, 1);
  await drawNormal(g, 1);
  await g.settle();
  t.expect([0, 1, 2].every((i) => g.p(i).isAlive), '기본 진행으로는 아무도 죽지 않음');
  t.expect(g.room.silenceMode, '괴물은 아직 남아 있음');
});

scenario('눈 없는 괴물: 아무도 죽지 않으면 뽑은 자의 차례가 돌아올 때 괴물이 돌아간다', {
  card: '눈 없는 괴물',
  rule: RULE.괴물,
}, async (t) => {
  const g = await t.game({ players: 3, deck: ['눈 없는 괴물'] });
  await drawEvent(g, 0);
  await g.waitPhase('MAIN');
  await drawNormal(g, 0);
  await endTurnTo(g, 0, 1);
  t.expect(g.room.silenceMode, '나래 차례: 괴물 유지');
  await drawNormal(g, 1);
  await endTurnTo(g, 1, 2);
  t.expect(g.room.silenceMode, '다온 차례: 괴물 유지');
  await drawNormal(g, 2);
  await endTurnTo(g, 2, 0);
  t.expect(!g.room.silenceMode, '가람 차례가 돌아오면 괴물이 돌아감');
  g.c(1).act('send_chat', '휴');
  await g.settle();
  t.expect(g.p(1).isAlive, '괴물이 떠난 뒤 채팅은 안전');
});

scenario('눈 없는 괴물: 처음부터 죽은 자가 있어도 뽑은 자의 차례가 돌아올 때 정확히 돌아간다', {
  card: '눈 없는 괴물',
  rule: RULE.괴물,
}, async (t) => {
  const g = await t.game({ players: 4, dead: [2], deck: ['눈 없는 괴물'] });
  await drawEvent(g, 0);
  await g.waitPhase('MAIN');
  await drawNormal(g, 0);
  await endTurnTo(g, 0, 1);
  t.expect(g.room.silenceMode, '나래 차례: 괴물 유지');
  await drawNormal(g, 1);
  await endTurnTo(g, 1, 3);
  t.expect(g.room.silenceMode, '라온 차례: 괴물 유지');
  await drawNormal(g, 3);
  await endTurnTo(g, 3, 0);
  t.expect(!g.room.silenceMode, '가람 차례가 돌아오면 괴물이 돌아감');
});

scenario('눈 없는 괴물: 차례 주인(뽑은 자)이 채팅하면 죽고 다음 생존자에게 차례가 넘어간다', {
  card: '눈 없는 괴물',
  rule: RULE.괴물,
}, async (t) => {
  const g = await t.game({ players: 4, deck: ['눈 없는 괴물'] });
  await drawEvent(g, 0);
  await g.waitPhase('MAIN');
  g.c(0).act('send_chat', '앗');
  await g.waitFor(() => !g.p(0).isAlive, '가람 사망');
  await g.waitFor(() => g.room.currentTurnPlayerId === g.c(1).id, '나래 차례');
  await g.settle();
  t.expectEq(g.room.phase, 'MAIN', 'MAIN 단계');
  t.expect(!g.room.silenceMode, '괴물이 돌아감');
  t.expect(g.p(2).isAlive && g.p(3).isAlive, '다른 사람은 생존');
});

scenario('눈 없는 괴물: 괴물이 아닌 무기로 누가 죽어도 괴물은 돌아가지 않는다', {
  card: '눈 없는 괴물',
  rule: RULE.괴물,
}, async (t) => {
  const g = await t.game({ players: 4, hands: { 0: ['성정'] }, deck: ['눈 없는 괴물'] });
  await drawEvent(g, 0);
  await g.waitPhase('MAIN');
  await drawNormal(g, 0);
  await attackAndKill(g, 0, '성정', 3);
  await g.waitPhase('MAIN');
  await g.settle();
  t.note(`무기로 라온 사망 직후 silenceMode=${g.room.silenceMode}, silenceTurnCount=${g.room.silenceTurnCount}`);
  t.expect(g.room.silenceMode, '"이 괴물에게" 죽은 것이 아니므로 괴물은 남아 있어야 함');
  g.c(1).act('send_chat', '라온이 죽었어');
  await g.settle();
  t.expect(!g.p(1).isAlive, '괴물이 남아 있으므로 채팅한 나래는 죽어야 함');
});

scenario('눈 없는 괴물: 중간에 죽은 자가 부활해 생존자가 늘어도 뽑은 자의 차례가 돌아올 때까지 괴물이 남는다', {
  card: '눈 없는 괴물',
  rule: `${RULE.괴물} / ${RULE.인체연성}`,
}, async (t) => {
  const g = await t.game({
    players: 4,
    dead: [3],
    hands: { 0: ['성정'], 1: ['성배'], 2: ['복권'] },
    deck: ['눈 없는 괴물', '코인', '인체 연성'],
  });
  await drawEvent(g, 0);
  await g.waitPhase('MAIN');
  t.note(`괴물 등장 시 silenceTurnCount=${g.room.silenceTurnCount} (생존자 3명)`);
  await drawNormal(g, 0);
  await endTurnTo(g, 0, 1);
  // 나래가 인체 연성을 뽑아 라온을 부활시킴
  await drawEvent(g, 1);
  await g.waitFor(() => pa(g)?.eventName === '인체 연성' && pa(g)?.type === 'CARD_SUBMISSION', '인체 연성 제출 단계');
  g.c(0).act('submit_cards', [g.cardId(0, '성정')]);
  g.c(1).act('submit_cards', [g.cardId(1, '성배')]);
  g.c(2).act('submit_cards', [g.cardId(2, '복권')]);
  await g.waitFor(() => pa(g)?.type === 'VOTE', '부활 투표');
  for (const i of [0, 1, 2]) g.c(i).act('submit_vote', g.c(3).id);
  await g.waitFor(() => g.p(3).isAlive, '라온 부활');
  await g.waitPhase('MAIN');
  t.expect(g.room.silenceMode, '부활 직후에도 괴물 유지');
  await drawNormal(g, 1);
  await endTurnTo(g, 1, 2);
  t.expect(g.room.silenceMode, '다온 차례: 괴물 유지');
  await drawNormal(g, 2);
  await endTurnTo(g, 2, 3);
  t.note(`부활한 라온 차례 silenceMode=${g.room.silenceMode}, silenceTurnCount=${g.room.silenceTurnCount}`);
  t.expect(g.room.silenceMode, '라온 차례: 아직 가람 차례가 돌아오지 않았으므로 괴물 유지');
  await drawNormal(g, 3);
  await endTurnTo(g, 3, 0);
  t.expect(!g.room.silenceMode, '가람 차례가 돌아오면 괴물이 돌아감');
});

// ════════════════════════════════════════════════════════════════════
// 화살 함정
// ════════════════════════════════════════════════════════════════════

scenario('화살 함정: 아무도 방패로 막지 않으면 뽑은 자가 죽고 다음 생존자에게 차례가 넘어간다', {
  card: '화살 함정',
  rule: RULE.화살,
}, async (t) => {
  const g = await t.game({ players: 3, deck: ['화살 함정'] });
  await startArrow(g, 0);
  t.expectEq(pa(g)?.targetId, g.c(0).id, '피격 대상은 뽑은 자');
  g.c(0).act('skip_defense');
  await g.waitFor(() => !g.p(0).isAlive, '가람 사망');
  await g.waitFor(() => g.room.currentTurnPlayerId === g.c(1).id && g.room.phase === 'MAIN', '나래 차례');
  t.expect(g.p(1).isAlive && g.p(2).isAlive, '다른 생존자는 무사');
  t.expect(!g.p(1).hasDrawnThisTurn, '나래는 아직 뽑지 않음');
});

scenario('화살 함정: 뽑은 자가 자기 방패로 막으면 살고 다시 뽑는다', {
  card: '화살 함정',
  rule: RULE.화살,
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['황금 방패'] }, deck: ['화살 함정'] });
  await startArrow(g, 0);
  g.c(0).act('play_shield', g.cardId(0, '황금 방패'));
  await g.waitPhase('MAIN');
  await g.settle();
  t.expect(g.p(0).isAlive, '가람 생존');
  t.expectEq(g.hand(0), [], '방패는 사용됨');
  t.expect(inGrave(g, '황금 방패'), '사용한 방패는 무덤으로');
  await drawAgain(t, g, 0);
});

scenario('화살 함정: 방패가 없는 뽑은 자를 다른 생존자가 일반 방패로 대신 막아줄 수 있다', {
  card: '화살 함정',
  rule: `${RULE.화살} / ${RULE.화살상세}`,
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 2: ['골든 레코드'] }, deck: ['화살 함정'] });
  await startArrow(g, 0);
  g.c(2).act('play_shield', g.cardId(2, '골든 레코드'));
  await g.waitPhase('MAIN');
  await g.settle();
  t.expect(g.p(0).isAlive && g.p(2).isAlive, '가람과 다온 생존');
  t.expectEq(g.hand(2), [], '다온의 방패가 사용됨');
  t.expect(inGrave(g, '골든 레코드'), '사용한 방패는 무덤으로');
  await drawAgain(t, g, 0);
});

scenario('화살 함정: 다른 생존자가 수호천사로 막아줄 수 있다', {
  card: '화살 함정',
  rule: `${RULE.화살상세} / ${RULE.수호천사}`,
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['수호천사'] }, deck: ['화살 함정'] });
  await startArrow(g, 0);
  g.c(1).act('play_shield', g.cardId(1, '수호천사'));
  await g.waitPhase('MAIN');
  t.expect(g.p(0).isAlive, '가람 생존');
  t.expectEq(g.hand(1), [], '수호천사 사용됨');
});

scenario('화살 함정: 거울 방패로도 막을 수 있고 아무에게도 반사되지 않는다', {
  card: '화살 함정',
  rule: RULE.화살,
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['거울 방패'] }, deck: ['화살 함정'] });
  await startArrow(g, 0);
  g.c(0).act('play_shield', g.cardId(0, '거울 방패'));
  await g.waitPhase('MAIN');
  await g.settle();
  t.expect([0, 1, 2].every((i) => g.p(i).isAlive), '모두 생존');
  t.expectEq(g.room.pendingAction, null, '반사로 새 방어 단계가 생기지 않음');
});

scenario('화살 함정: 다른 생존자에게 방패가 있으면 뽑은 자가 포기해도 그 생존자의 결정을 기다린다', {
  card: '화살 함정',
  rule: `${RULE.화살} / ${RULE.화살상세}`,
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 2: ['황금 방패'] }, deck: ['화살 함정'] });
  await startArrow(g, 0);
  g.c(0).act('skip_defense');
  g.c(1).act('skip_defense'); // 방패 없는 나래의 포기는 의미 없음
  await g.settle();
  t.expect(g.p(0).isAlive, '다온이 결정하기 전에는 죽지 않음');
  t.expectEq(g.room.phase, 'WAITING_FOR_DEFENSE', '방어 단계 유지');
  g.c(2).act('skip_defense');
  await g.waitFor(() => !g.p(0).isAlive, '가람 사망');
  t.expectEq(g.hand(2), ['황금 방패'], '포기한 다온의 방패는 그대로');
});

scenario('화살 함정: 시간 안에 아무도 막지 않으면 뽑은 자가 죽는다', {
  card: '화살 함정',
  rule: RULE.화살,
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['황금 방패'], 1: ['수호천사'] }, deck: ['화살 함정'] });
  await startArrow(g, 0);
  await g.waitServerMs(30000);
  await g.waitFor(() => !g.p(0).isAlive, '가람 사망');
  await g.waitFor(() => g.room.currentTurnPlayerId === g.c(1).id && g.room.phase === 'MAIN', '나래 차례');
});

scenario('화살 함정: 죽은 자의 방패나 방패가 아닌 카드로는 막을 수 없다', {
  card: '화살 함정',
  rule: RULE.화살,
}, async (t) => {
  const g = await t.game({ players: 4, dead: [3], hands: { 0: ['성정'], 3: ['황금 방패'] }, deck: ['화살 함정'] });
  await startArrow(g, 0);
  g.c(3).act('play_shield', g.cardId(3, '황금 방패'));
  g.c(0).act('play_shield', g.cardId(0, '성정'));
  g.c(1).act('play_shield', 'no-such-card');
  await g.settle();
  t.expectEq(g.room.phase, 'WAITING_FOR_DEFENSE', '잘못된 방어는 거부');
  t.expectEq(g.hand(3), ['황금 방패'], '죽은 라온의 방패 그대로');
  t.expectEq(g.hand(0), ['성정'], '가람의 성정 그대로');
  g.c(0).act('skip_defense');
  await g.waitFor(() => !g.p(0).isAlive, '가람 사망 (죽은 자는 개입 대상이 아님)');
});

scenario('화살 함정: 인간 방패로 다른 생존자를 내세우면 그 생존자가 대신 죽는다', {
  card: '화살 함정',
  rule: `${RULE.화살} / ${RULE.인간방패}`,
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['인간 방패'] }, deck: ['화살 함정'] });
  await startArrow(g, 0);
  g.c(0).act('interrupt_action', g.cardId(0, '인간 방패'), g.c(1).id);
  await g.waitFor(() => pa(g)?.targetId === g.c(1).id, '나래가 인간 방패로 지정됨');
  t.expectEq(g.hand(0), [], '인간 방패 사용됨');
  t.expect(inGrave(g, '인간 방패'), '인간 방패는 무덤으로');
  g.c(1).act('skip_defense');
  await g.waitFor(() => !g.p(1).isAlive, '나래 사망');
  await g.waitPhase('MAIN');
  t.expect(g.p(0).isAlive && g.p(2).isAlive, '가람과 다온 생존');
  await drawAgain(t, g, 0);
});

scenario('화살 함정: 인간 방패로 내세워진 생존자도 방패로 막을 수 있다', {
  card: '화살 함정',
  rule: RULE.인간방패,
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['인간 방패'], 1: ['황금 방패'] }, deck: ['화살 함정'] });
  await startArrow(g, 0);
  g.c(0).act('interrupt_action', g.cardId(0, '인간 방패'), g.c(1).id);
  await g.waitFor(() => pa(g)?.targetId === g.c(1).id, '나래가 인간 방패로 지정됨');
  g.c(1).act('play_shield', g.cardId(1, '황금 방패'));
  await g.waitPhase('MAIN');
  await g.settle();
  t.expect([0, 1, 2].every((i) => g.p(i).isAlive), '모두 생존');
  await drawAgain(t, g, 0);
});

scenario('화살 함정: 인간 방패로 죽은 자나 자신을 지정할 수 없고 피격자가 아니면 쓸 수 없다', {
  card: '화살 함정',
  rule: RULE.인간방패,
}, async (t) => {
  const g = await t.game({ players: 4, dead: [3], hands: { 0: ['인간 방패'], 1: ['인간 방패'] }, deck: ['화살 함정'] });
  await startArrow(g, 0);
  g.c(0).act('interrupt_action', g.cardId(0, '인간 방패'), g.c(3).id);
  g.c(0).act('interrupt_action', g.cardId(0, '인간 방패'), g.c(0).id);
  g.c(1).act('interrupt_action', g.cardId(1, '인간 방패'), g.c(2).id);
  await g.settle();
  t.expectEq(pa(g)?.targetId, g.c(0).id, '피격 대상은 여전히 가람');
  t.expectEq(g.hand(0), ['인간 방패'], '가람의 인간 방패 그대로');
  t.expectEq(g.hand(1), ['인간 방패'], '나래의 인간 방패 그대로');
  g.c(0).act('skip_defense');
  await g.waitFor(() => !g.p(0).isAlive, '가람 사망');
});

scenario('화살 함정: 생존자 2명 중 뽑은 자가 죽으면 게임이 끝난다', {
  card: '화살 함정',
  rule: RULE.화살,
}, async (t) => {
  const g = await t.game({ players: 2, deck: ['화살 함정'] });
  await startArrow(g, 0);
  g.c(0).act('skip_defense');
  await g.waitPhase('ENDED');
  await g.waitFor(() => g.c(1).gameOvers.length > 0, '게임 종료 알림');
  t.expect(!g.p(0).isAlive && g.p(1).isAlive, '가람 사망, 나래 생존');
});

scenario('화살 함정: 긴급탈출키트로 함정을 취소하면 뽑은 자가 산다', {
  card: '화살 함정',
  rule: `${RULE.화살} / ${RULE.긴급}`,
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 2: ['긴급탈출키트'] }, deck: ['화살 함정'] });
  await startArrow(g, 0);
  g.c(2).act('interrupt_action', g.cardId(2, '긴급탈출키트'));
  await g.waitPhase('MAIN');
  await g.settle();
  t.expect(g.p(0).isAlive, '가람 생존');
  t.expect(inGrave(g, '긴급탈출키트'), '키트는 무덤으로');
  await drawAgain(t, g, 0);
});
