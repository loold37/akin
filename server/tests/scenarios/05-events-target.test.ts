import { scenario } from '../harness/runner';
import type { GameCtx } from '../harness/game';
import type { ScenarioApi } from '../harness/runner';

// 대상 지정형 이벤트: 피바라기, 선택 (善), 선택 (惡), 카르마, 폴터가이스트, 뒤바뀐 영혼, 선물, 빙의
// 규칙(card.json)대로의 동작을 단언합니다. 실패 = 현재 구현이 규칙과 다름.

const RULE = {
  피바라기: '당신은 피를 바라는 검을 주웠습니다! 지금 이 검을 다른 생존자에게 사용해야만 합니다. 단, 이 검도 방패로 막을 수 있습니다.',
  피바라기1: '[1] 공격 횟수를 소모하지 않습니다.',
  피바라기2: '[2] 피바라기를 뽑은 생존자는 자신에게 수호천사(특수 방패)가 있을지라도 자신을 타겟으로 한 반사를 대신 막아주기가 불가능합니다.',
  선: '이 카드를 뽑은 자는 생존자 중 한 명을 선택해 카드를 전부 공개시킵니다. 그중 악의가 1장이라도 있다면 이 카드를 뽑은 자는 죽습니다.',
  악: '이 카드를 뽑은 자는 생존자 중 한 명을 선택해 카드를 전부 공개시킵니다. 그중 악의가 1장 이하라면 이 카드를 뽑은 자는 죽습니다.',
  선택상세: '공개 대상은 생존자 중 1명을 뽑은 자가 임의로 선택합니다. 뽑은 자 본인이 죽을 수 있는 페널티가 있습니다.',
  짙은악의: '(짙은 악의) 이 악의는 악의 2장입니다. … 악의를 버리거나 카드를 낼 때는 1장으로 취급합니다. (패에 들고 있을 때만 악의 2장으로 산정)',
  누군가: '(누군가의 뼈/로켓) 이 무기(보물)는 악의인 동시에 무기(보물)입니다.',
  선의: '(선의) 이 카드를 지니고 있다면 악의를 1장 줄여 계산합니다. … (단, 이 카드만으로 악의 판정을 유리하게 우회하여 이벤트를 회피할 수는 없음)',
  카르마: '죽은 자들은 회의를 통해 가장 악한 생존자에게 이 카드를 건네줍니다. 이 카드를 패에 넣는 순간 악의가 됩니다.',
  카르마상세: "카드를 뽑는 즉시에는 '이벤트 카드'로 취급되어 모두가 회의를 진행하며, 누군가의 패로 들어간 이후부터 '악의'로 취급됩니다.",
  폴터: '죽은 자들은 회의를 통해 생존자 중 한 명을 원한이 담긴 칼로 찌를 수 있습니다. 단, 이 칼 역시 방패로 막을 수 있습니다.',
  뒤바뀐: '이 카드를 뽑은 자는 생존자 중 한 명을 골라 자신의 모든 패와 선택한 생존자의 모든 패를 교환합니다.',
  선물: '이 카드를 뽑은 자는 자신의 패에서 원하는 카드 1장을 골라 다른 생존자에게 선물합니다.',
  빙의: '이 카드를 뽑은 자는 죽은 자들에게 이번 차례가 끝날 때까지 자신의 패와 차례를 빼앗깁니다. 죽은 자들은 차례를 마치면 돌려줍니다.',
  침묵: '(침묵) 이 카드를 사용하면 한 생존자를 선택해 이번 차례에 도구를 못 내게 합니다.',
  긴급: '(긴급탈출키트) 이 카드를 사용하면 이벤트를 한 개 취소합니다. 자신의 차례가 아니거나 이벤트가 진행 중 일지라도 사용 가능합니다.',
  수호천사: '(수호천사) 이 방패는 자신뿐만 아니라 다른 생존자에게 향하는 공격을 대신 막아줄 수 있습니다.',
  거울: '(거울 방패) 다른 생존자가 당신을 공격할 때 사용하면 그대로 그 공격을 당신을 공격한 생존자에게 돌려줍니다.',
};

// ── 도우미 ──────────────────────────────────────────────────────────

const sorted = (a: string[]) => [...a].sort();

function nameOf(g: GameCtx, id: string | null | undefined): string {
  const i = g.indexOf(id);
  return i >= 0 ? g.c(i).name : String(id);
}

/** i번이 카드를 뽑고 events_triggered를 받을 때까지 기다립니다. */
async function drawEvent(g: GameCtx, i = 0): Promise<void> {
  const before = g.c(i).eventsOf('events_triggered').length;
  g.c(i).act('draw_card');
  await g.waitFor(() => g.c(i).eventsOf('events_triggered').length > before, `${g.c(i).name} 이벤트 발동`);
}

async function waitTargetRequest(g: GameCtx, i: number): Promise<void> {
  await g.waitFor(() => g.requests(i, 'request_target').length > 0, `${g.c(i).name}에게 대상 요청`);
}

function lastCandidates(g: GameCtx, i: number): string[] {
  const r = g.requests(i, 'request_target');
  return (r[r.length - 1]?.[1] ?? []) as string[];
}

/** drawer가 이벤트를 뽑고 target을 지정해 방어 단계까지 진행합니다. */
async function attackWithEvent(g: GameCtx, drawer: number, target: number): Promise<void> {
  await drawEvent(g, drawer);
  await waitTargetRequest(g, drawer);
  g.c(drawer).act('submit_target', g.c(target).id);
  await g.waitPhase('WAITING_FOR_DEFENSE');
}

async function waitReveal(g: GameCtx): Promise<void> {
  await g.waitFor(() => !!(g.room.pendingAction as any)?.revealedCards, '패 공개 시작');
}

function confirmAll(g: GameCtx): void {
  g.clients.forEach((c, i) => {
    if (g.p(i).isAlive) c.act('confirm_reveal');
  });
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

function pendingType(g: GameCtx): string | null {
  return g.room.pendingAction?.type ?? null;
}

// ════════════════════════════════════════════════════════════════════
// 피바라기
// ════════════════════════════════════════════════════════════════════

scenario('피바라기: 뽑은 자에게만 대상 요청이 가고 후보에서 자신과 죽은 자는 제외된다', {
  card: '피바라기',
  rule: RULE.피바라기,
}, async (t) => {
  const g = await t.game({ players: 4, dead: [3], deck: ['피바라기'] });
  await drawEvent(g, 0);
  await waitTargetRequest(g, 0);
  await g.settle();
  const [ev] = g.requests(0, 'request_target')[0];
  t.expectEq(ev, '피바라기', '요청 이벤트 이름');
  t.expectEq(sorted(lastCandidates(g, 0)), sorted([g.c(1).id, g.c(2).id]), '후보는 뽑은 자를 뺀 생존자');
  for (const i of [1, 2, 3]) t.expectEq(g.requests(i, 'request_target').length, 0, `${g.c(i).name}에게는 대상 요청이 가지 않아야 함`);
  t.expectEq(g.room.phase, 'RESOLVING_EVENT', '대상 선택 대기 중');
});

scenario('피바라기: 방어하지 않으면 지목된 생존자가 죽고 뽑은 자는 다시 뽑는다', {
  card: '피바라기',
  rule: RULE.피바라기,
}, async (t) => {
  const g = await t.game({ players: 3, deck: ['피바라기'] });
  await attackWithEvent(g, 0, 1);
  t.expectEq(g.room.pendingAction?.targetId, g.c(1).id, '방어 대상은 나래');
  t.expectEq(g.room.pendingAction?.initiatorId, g.c(0).id, '공격자는 가람');
  g.c(1).act('skip_defense');
  await g.waitFor(() => !g.p(1).isAlive, '나래 사망');
  await g.waitPhase('MAIN');
  t.expect(g.p(0).isAlive && g.p(2).isAlive, '가람과 다온은 살아 있어야 함');
  await drawAgain(t, g, 0);
});

scenario('피바라기: 일반 방패로 막으면 둘 다 살고 방패는 버려진다', {
  card: '피바라기',
  rule: RULE.피바라기,
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['황금 방패'] }, deck: ['피바라기'] });
  await attackWithEvent(g, 0, 1);
  g.c(1).act('play_shield', g.cardId(1, '황금 방패'));
  await g.waitPhase('MAIN');
  await g.settle();
  t.expect(g.p(1).isAlive, '방어한 나래는 살아 있어야 함');
  t.expect(g.p(0).isAlive, '가람도 살아 있어야 함');
  t.expectEq(g.hand(1), [], '사용한 방패는 버려짐');
  t.expect(g.room.graveyard.some((c) => c.name === '황금 방패'), '무덤에 황금 방패');
  await drawAgain(t, g, 0);
});

scenario('피바라기: 대상 선택 시간이 지나면 다른 생존자 중 한 명이 강제로 공격받는다', {
  card: '피바라기',
  rule: RULE.피바라기,
}, async (t) => {
  const g = await t.game({ players: 3, deck: ['피바라기'] });
  await drawEvent(g, 0);
  await waitTargetRequest(g, 0);
  await g.waitServerMs(30000);
  await g.waitPhase('WAITING_FOR_DEFENSE');
  const target = g.room.pendingAction?.targetId;
  t.note(`시간 초과 후 무작위 대상: ${nameOf(g, target)}`);
  t.expect(target && target !== g.c(0).id, '공격 대상은 뽑은 자가 아닌 다른 생존자여야 함');
  const ti = g.indexOf(target);
  g.c(ti).act('skip_defense');
  await g.waitFor(() => !g.p(ti).isAlive, '대상 사망');
  await g.waitPhase('MAIN');
});

scenario('피바라기: 방어 제한시간이 지나면 대상이 죽는다', {
  card: '피바라기',
  rule: RULE.피바라기,
}, async (t) => {
  const g = await t.game({ players: 3, deck: ['피바라기'] });
  await attackWithEvent(g, 0, 1);
  await g.waitServerMs(30000);
  await g.waitFor(() => !g.p(1).isAlive, '방어 제한시간 후 나래 사망');
  await g.waitPhase('MAIN');
  t.expectEq(g.room.currentTurnPlayerId, g.c(0).id, '가람의 차례 유지');
});

scenario('피바라기: 공격 횟수를 소모하지 않아 이후 무기로 또 공격할 수 있다', {
  card: '피바라기',
  rule: RULE.피바라기1,
}, async (t) => {
  const g = await t.game({ players: 4, hands: { 0: ['성정'], 1: ['황금 방패'] }, deck: ['피바라기'] });
  await attackWithEvent(g, 0, 1);
  g.c(1).act('play_shield', g.cardId(1, '황금 방패'));
  await g.waitPhase('MAIN');
  t.expect(!g.p(0).hasUsedWeaponThisTurn, '피바라기 후에도 무기 사용 횟수가 남아 있어야 함');
  await drawAgain(t, g, 0);
  g.c(0).act('play_tool', g.cardId(0, '성정'), g.c(2).id);
  await g.waitPhase('WAITING_FOR_DEFENSE');
  t.expectEq((g.room.pendingAction?.weaponCard as any)?.name, '성정', '성정 공격이 진행되어야 함');
  g.c(2).act('skip_defense');
  await g.waitFor(() => !g.p(2).isAlive, '다온 사망');
});

scenario('피바라기: 이미 무기로 공격한 차례에도 피바라기 공격은 강제로 진행된다', {
  card: '피바라기',
  rule: RULE.피바라기1,
}, async (t) => {
  const g = await t.game({ players: 4, hands: { 0: ['성정'] }, deck: ['피바라기'] });
  g.c(0).act('play_tool', g.cardId(0, '성정'), g.c(3).id);
  await g.waitPhase('WAITING_FOR_DEFENSE');
  g.c(3).act('skip_defense');
  await g.waitFor(() => !g.p(3).isAlive, '라온 사망');
  await g.waitPhase('MAIN');
  t.expect(g.p(0).hasUsedWeaponThisTurn, '무기 사용 표시');
  await attackWithEvent(g, 0, 1);
  g.c(1).act('skip_defense');
  await g.waitFor(() => !g.p(1).isAlive, '나래 사망');
});

scenario('피바라기: 다른 생존자가 수호천사로 대상을 대신 지킬 수 있다', {
  card: '피바라기',
  rule: `${RULE.피바라기} / ${RULE.수호천사}`,
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 2: ['수호천사'] }, deck: ['피바라기'] });
  await attackWithEvent(g, 0, 1);
  // 대상이 먼저 포기해도 수호천사 보유자가 결정할 때까지 기다려야 함
  g.c(1).act('skip_defense');
  await g.settle();
  t.expectEq(g.room.phase, 'WAITING_FOR_DEFENSE', '수호천사 보유자의 결정을 기다려야 함');
  g.c(2).act('play_shield', g.cardId(2, '수호천사'), g.c(1).id);
  await g.waitPhase('MAIN');
  await g.settle();
  t.expect(g.p(1).isAlive, '나래는 수호천사 덕분에 살아 있어야 함');
  t.expectEq(g.hand(2), [], '수호천사는 버려짐');
});

scenario('피바라기: 뽑은 자는 자신의 수호천사로 자기가 공격한 대상을 지켜줄 수 있는가', {
  card: '피바라기',
  rule: `${RULE.피바라기} / ${RULE.피바라기2}`,
  ambiguous: '피바라기를 뽑은 자가 자기 수호천사로 자기가 지목한 대상을 대신 막아줄 수 있습니까? (규칙 [2]는 "자신을 타겟으로 한 반사"만 금지하고 이 경우는 언급이 없음. "사용해야만 합니다"를 무력화하는지 확인 필요)',
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['수호천사'] }, deck: ['피바라기'] });
  await attackWithEvent(g, 0, 1);
  g.c(0).act('play_shield', g.cardId(0, '수호천사'), g.c(1).id);
  await g.settle();
  t.note(`가람이 수호천사로 나래를 지키려 함 → 단계=${g.room.phase}, 가람 패=${g.hand(0).join(',') || '없음'}, 메시지="${g.msgs(0).slice(-1)[0]}"`);
  if (g.room.phase === 'WAITING_FOR_DEFENSE') {
    g.c(1).act('skip_defense');
    await g.waitPhase('MAIN');
  }
  t.note(`결과: 나래 생존=${g.p(1).isAlive}`);
});

scenario('피바라기: 거울 방패로 반사되면 뽑은 자가 대상이 되고 막지 못하면 죽는다', {
  card: '피바라기',
  rule: `${RULE.피바라기} / ${RULE.거울}`,
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['거울 방패'] }, deck: ['피바라기'] });
  await attackWithEvent(g, 0, 1);
  g.c(1).act('play_shield', g.cardId(1, '거울 방패'));
  await g.waitFor(() => g.room.pendingAction?.targetId === g.c(0).id, '반사되어 가람이 대상이 됨');
  t.expectEq(g.room.phase, 'WAITING_FOR_DEFENSE', '반사된 공격 방어 대기');
  g.c(0).act('skip_defense');
  await g.waitFor(() => !g.p(0).isAlive, '가람 사망');
  await g.waitPhase('MAIN');
  t.expect(g.p(1).isAlive, '나래는 살아 있어야 함');
  t.expectEq(g.room.currentTurnPlayerId, g.c(1).id, '죽은 가람 다음 생존자 나래의 차례');
});

scenario('피바라기: 반사된 공격을 뽑은 자 자신의 수호천사로 막을 수 없다', {
  card: '피바라기',
  rule: RULE.피바라기2,
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['수호천사'], 1: ['거울 방패'] }, deck: ['피바라기'] });
  await attackWithEvent(g, 0, 1);
  g.c(1).act('play_shield', g.cardId(1, '거울 방패'));
  await g.waitFor(() => g.room.pendingAction?.targetId === g.c(0).id, '반사되어 가람이 대상이 됨');
  g.c(0).act('play_shield', g.cardId(0, '수호천사'), g.c(0).id);
  await g.settle();
  const phaseAfter = g.room.phase;
  const kept = g.hand(0).includes('수호천사');
  t.note(`가람이 수호천사를 낸 뒤: 단계=${phaseAfter}, 수호천사 보유=${kept}, 가람 생존=${g.p(0).isAlive}`);
  t.expect(kept, '반사된 피바라기는 뽑은 자의 수호천사로 막을 수 없으므로 수호천사가 소모되지 않아야 함');
  t.expectEq(phaseAfter, 'WAITING_FOR_DEFENSE', '반사 공격은 계속 가람을 향해야 함');
  g.c(0).act('skip_defense');
  await g.waitFor(() => !g.p(0).isAlive, '가람 사망');
});

scenario('피바라기: 반사된 공격을 뽑은 자가 일반 방패로 막을 수 있는가', {
  card: '피바라기',
  rule: RULE.피바라기2,
  ambiguous: '규칙 [2]는 수호천사만 언급합니다. 피바라기를 뽑은 자가 거울 방패로 반사된 공격을 일반 방패(황금 방패 등)로는 막을 수 있습니까?',
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['황금 방패'], 1: ['거울 방패'] }, deck: ['피바라기'] });
  await attackWithEvent(g, 0, 1);
  g.c(1).act('play_shield', g.cardId(1, '거울 방패'));
  await g.waitFor(() => g.room.pendingAction?.targetId === g.c(0).id, '반사되어 가람이 대상이 됨');
  g.c(0).act('play_shield', g.cardId(0, '황금 방패'));
  await g.settle();
  t.note(`가람이 황금 방패를 냄 → 단계=${g.room.phase}, 가람 생존=${g.p(0).isAlive}, 황금 방패 보유=${g.hand(0).includes('황금 방패')}`);
});

scenario('피바라기: 침묵으로는 피바라기 공격을 취소할 수 없다', {
  card: '피바라기',
  rule: `${RULE.침묵} / 피바라기는 도구가 아닌 이벤트`,
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['침묵'] }, deck: ['피바라기'] });
  await attackWithEvent(g, 0, 1);
  g.c(1).act('interrupt_action', g.cardId(1, '침묵'), g.c(0).id);
  await g.settle();
  t.note(`침묵 시도 후 침묵 보유=${g.hand(1).includes('침묵')}, 메시지="${g.msgs(1).slice(-1)[0]}"`);
  t.expectEq(g.room.phase, 'WAITING_FOR_DEFENSE', '피바라기 공격은 계속되어야 함');
  t.expectEq(g.room.pendingAction?.targetId, g.c(1).id, '대상은 여전히 나래');
  g.c(1).act('skip_defense');
  await g.waitFor(() => !g.p(1).isAlive, '나래 사망');
});

scenario('피바라기: 긴급탈출키트로 피바라기 이벤트를 취소하면 아무도 죽지 않는다', {
  card: '피바라기',
  rule: RULE.긴급,
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['긴급탈출키트'] }, deck: ['피바라기'] });
  await attackWithEvent(g, 0, 1);
  g.c(1).act('interrupt_action', g.cardId(1, '긴급탈출키트'));
  await g.waitPhase('MAIN');
  await g.settle();
  t.expect(g.p(1).isAlive && g.p(0).isAlive, '아무도 죽지 않아야 함');
  t.expectEq(g.hand(1), [], '긴급탈출키트 소모');
  t.expect(g.room.graveyard.some((c) => c.name === '긴급탈출키트'), '무덤에 긴급탈출키트');
  await drawAgain(t, g, 0);
});

scenario('피바라기: 뽑은 자가 아닌 플레이어(생존자·죽은 자)의 대상 지정은 무시된다', {
  card: '피바라기',
  rule: RULE.피바라기,
}, async (t) => {
  const g = await t.game({ players: 4, dead: [3], deck: ['피바라기'] });
  await drawEvent(g, 0);
  await waitTargetRequest(g, 0);
  g.c(1).act('submit_target', g.c(2).id);
  g.c(3).act('submit_target', g.c(2).id);
  await g.settle();
  t.expectEq(pendingType(g), 'TARGET_SELECTION', '다른 사람의 지정은 무시되고 대상 선택 대기 유지');
  g.c(0).act('submit_target', g.c(1).id);
  await g.waitPhase('WAITING_FOR_DEFENSE');
  t.expectEq(g.room.pendingAction?.targetId, g.c(1).id, '뽑은 자가 고른 나래가 대상');
});

/** 피바라기 대상으로 잘못된 값을 보낸 뒤: 대상 선택이 계속되거나, 다른 생존자에게 공격이 가야 규칙대로입니다. */
function attackObligationKept(g: GameCtx): boolean {
  const pa = g.room.pendingAction;
  if (g.room.phase === 'RESOLVING_EVENT' && pa?.type === 'TARGET_SELECTION') return true;
  if (g.room.phase === 'WAITING_FOR_DEFENSE' && pa?.targetId) {
    const tp = g.room.getPlayerById(pa.targetId);
    return !!tp && tp.isAlive && tp.id !== g.c(0).id;
  }
  return false;
}

scenario('피바라기: 조작된 클라이언트가 자기 자신을 대상으로 보내면 거부된다', {
  card: '피바라기',
  rule: RULE.피바라기,
}, async (t) => {
  const g = await t.game({ players: 3, deck: ['피바라기'] });
  await drawEvent(g, 0);
  await waitTargetRequest(g, 0);
  g.c(0).act('submit_target', g.c(0).id);
  await g.settle();
  t.note(`자기 자신 지정 후: 단계=${g.room.phase}, 대기=${pendingType(g)}, 방어 대상=${nameOf(g, g.room.pendingAction?.targetId)}`);
  t.expect(attackObligationKept(g), '자기 자신 지정은 거부되고, 공격은 다른 생존자에게 가야 함');
});

scenario('피바라기: 조작된 클라이언트가 죽은 플레이어를 대상으로 보내면 거부된다', {
  card: '피바라기',
  rule: RULE.피바라기,
  allowViolations: ['DEFENSE_TARGET_DEAD'],
}, async (t) => {
  const g = await t.game({ players: 4, dead: [3], deck: ['피바라기'] });
  await drawEvent(g, 0);
  await waitTargetRequest(g, 0);
  g.c(0).act('submit_target', g.c(3).id);
  await g.settle();
  t.note(`죽은 라온 지정 후: 단계=${g.room.phase}, 대기=${pendingType(g)}, 방어 대상=${nameOf(g, g.room.pendingAction?.targetId)}`);
  const ok = attackObligationKept(g);
  if (!ok) {
    await g.waitServerMs(30000);
    await g.settle();
    t.note(`방어 제한시간 후: 단계=${g.room.phase}, 생존=${[0, 1, 2].map((i) => `${g.c(i).name}:${g.p(i).isAlive}`).join(',')}`);
  }
  t.expect(ok, '죽은 플레이어 지정은 거부되고, 공격은 살아 있는 다른 생존자에게 가야 함');
});

scenario('피바라기: 조작된 클라이언트가 없는 플레이어 id를 보내도 공격 의무가 남는다', {
  card: '피바라기',
  rule: RULE.피바라기,
}, async (t) => {
  const g = await t.game({ players: 3, deck: ['피바라기'] });
  await drawEvent(g, 0);
  await waitTargetRequest(g, 0);
  g.c(0).act('submit_target', 'no-such-player');
  await g.settle();
  t.note(`없는 id 지정 후: 단계=${g.room.phase}, 대기=${pendingType(g)}, 생존=${[0, 1, 2].map((i) => g.p(i).isAlive).join(',')}`);
  t.expect(attackObligationKept(g), '잘못된 id는 거부되고 피바라기 공격이 계속되어야 함 (이벤트가 그냥 사라지면 안 됨)');
});

// ════════════════════════════════════════════════════════════════════
// 선택 (善)
// ════════════════════════════════════════════════════════════════════

scenario('선택 (善): 대상 패에 악의가 있으면 공개 확인 후 뽑은 자가 죽는다', {
  card: '선택 (善)',
  rule: RULE.선,
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['시선', '성배'], 2: ['성배'] }, deck: ['선택 (善)'] });
  await drawEvent(g, 0);
  await waitTargetRequest(g, 0);
  for (const i of [1, 2]) t.expectEq(g.requests(i, 'request_target').length, 0, `${g.c(i).name}에게는 대상 요청이 없어야 함`);
  g.c(0).act('submit_target', g.c(1).id);
  await waitReveal(g);
  await g.waitFor(() => g.c(2).state?.revealedCardsInfo?.playerId === g.c(1).id, '다온에게도 공개 정보 전달');
  t.expectEq(sorted((g.c(2).state!.revealedCardsInfo!.cards as any[]).map((c) => c.name)), sorted(['시선', '성배']), '대상의 패 전부가 공개되어야 함');
  t.expect(g.p(0).isAlive, '공개 확인 전에는 아직 살아 있음');
  confirmAll(g);
  await g.waitFor(() => !g.p(0).isAlive, '가람 사망');
  await g.waitPhase('MAIN');
  t.expectEq(g.room.currentTurnPlayerId, g.c(1).id, '다음 생존자 나래의 차례');
  t.expectEq(sorted(g.hand(1)), sorted(['시선', '성배']), '공개된 패는 그대로 주인에게 남아야 함');
});

scenario('선택 (善): 대상 패에 악의가 없으면 뽑은 자는 살고 다시 뽑는다', {
  card: '선택 (善)',
  rule: RULE.선,
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['성배', '황금 방패'] }, deck: ['선택 (善)'] });
  await drawEvent(g, 0);
  await waitTargetRequest(g, 0);
  g.c(0).act('submit_target', g.c(1).id);
  await waitReveal(g);
  confirmAll(g);
  await g.waitPhase('MAIN');
  await g.settle();
  t.expect(g.p(0).isAlive, '가람은 살아 있어야 함');
  await drawAgain(t, g, 0);
});

scenario('선택 (善): 악의를 품은 도구(누군가의 뼈)도 악의로 세어 뽑은 자가 죽는다', {
  card: '선택 (善)',
  rule: `${RULE.선} / ${RULE.누군가}`,
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['누군가의 뼈'] }, deck: ['선택 (善)'] });
  await drawEvent(g, 0);
  await waitTargetRequest(g, 0);
  g.c(0).act('submit_target', g.c(1).id);
  await waitReveal(g);
  confirmAll(g);
  await g.waitFor(() => !g.p(0).isAlive, '가람 사망');
});

scenario('선택 (善): 짙은 악의도 악의로 세어 뽑은 자가 죽는다', {
  card: '선택 (善)',
  rule: `${RULE.선} / ${RULE.짙은악의}`,
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['짙은 악의'] }, deck: ['선택 (善)'] });
  await drawEvent(g, 0);
  await waitTargetRequest(g, 0);
  g.c(0).act('submit_target', g.c(1).id);
  await waitReveal(g);
  confirmAll(g);
  await g.waitFor(() => !g.p(0).isAlive, '가람 사망');
});

scenario('선택 (善): 공개는 모든 생존자가 확인할 때까지 유지되고 제한시간이 지나면 끝난다', {
  card: '선택 (善)',
  rule: RULE.선,
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['시선'] }, deck: ['선택 (善)'] });
  await drawEvent(g, 0);
  await waitTargetRequest(g, 0);
  g.c(0).act('submit_target', g.c(1).id);
  await waitReveal(g);
  g.c(0).act('confirm_reveal');
  g.c(1).act('confirm_reveal');
  await g.settle();
  t.expectEq(g.room.phase, 'RESOLVING_EVENT', '다온이 확인하기 전까지 공개 유지');
  t.expect(g.p(0).isAlive, '공개가 끝나기 전에는 살아 있음');
  await g.waitServerMs(30000);
  await g.waitFor(() => !g.p(0).isAlive, '제한시간 후 가람 사망');
  await g.waitPhase('MAIN');
});

scenario('선택 (善): 죽은 자의 확인은 공개 종료 조건(생존자 전원 확인)에 포함되지 않는다', {
  card: '선택 (善)',
  rule: RULE.선,
}, async (t) => {
  const g = await t.game({ players: 4, dead: [3], hands: { 1: ['시선'] }, deck: ['선택 (善)'] });
  await drawEvent(g, 0);
  await waitTargetRequest(g, 0);
  g.c(0).act('submit_target', g.c(1).id);
  await waitReveal(g);
  g.c(3).act('confirm_reveal'); // 죽은 라온
  g.c(0).act('confirm_reveal');
  g.c(1).act('confirm_reveal');
  await g.settle();
  t.note(`죽은 라온 + 가람 + 나래 확인 후: 단계=${g.room.phase}, 가람 생존=${g.p(0).isAlive} (다온은 아직 확인 안 함)`);
  t.expectEq(g.room.phase, 'RESOLVING_EVENT', '살아 있는 다온이 아직 확인하지 않았으므로 공개가 유지되어야 함');
});

scenario('선택 (善): 뽑은 자가 자기 자신을 공개 대상으로 고를 수 있는가', {
  card: '선택 (善)',
  rule: `${RULE.선} / ${RULE.선택상세}`,
  ambiguous: "선택 (善)/(惡)을 뽑은 자가 자기 자신을 공개 대상으로 고를 수 있습니까? ('생존자 중 한 명'에 본인이 포함되는지. 피바라기·선물은 '다른 생존자'라고 명시함)",
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['시선'] }, deck: ['선택 (善)'] });
  await drawEvent(g, 0);
  await waitTargetRequest(g, 0);
  t.note(`대상 후보에 본인 포함=${lastCandidates(g, 0).includes(g.c(0).id)}`);
  g.c(0).act('submit_target', g.c(0).id);
  await g.settle();
  const revealed = (g.room.pendingAction as any)?.revealedPlayerId;
  t.note(`본인 지정 후 공개 대상=${nameOf(g, revealed)}`);
  if (revealed) {
    confirmAll(g);
    await g.waitPhase('MAIN');
  }
  t.note(`결과: 가람(본인 패에 시선) 생존=${g.p(0).isAlive}`);
});

scenario('선택 (善): 대상 선택 시간이 지나면 무작위 다른 생존자가 공개되고 게임이 이어진다', {
  card: '선택 (善)',
  rule: RULE.선택상세,
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['성배'], 2: ['황금 방패'] }, deck: ['선택 (善)'] });
  await drawEvent(g, 0);
  await waitTargetRequest(g, 0);
  await g.waitServerMs(30000);
  await waitReveal(g);
  const revealed = (g.room.pendingAction as any)?.revealedPlayerId;
  t.note(`시간 초과 후 공개 대상=${nameOf(g, revealed)}`);
  t.expect(revealed && g.room.getPlayerById(revealed)?.isAlive, '공개 대상은 생존자여야 함');
  confirmAll(g);
  await g.waitPhase('MAIN');
  t.expect(g.p(0).isAlive, '악의가 없으므로 가람 생존');
});

scenario('선택 (善): 2인 게임에서 뽑은 자가 죽으면 남은 1인으로 게임이 끝난다', {
  card: '선택 (善)',
  rule: RULE.선,
}, async (t) => {
  const g = await t.game({ players: 2, hands: { 1: ['시선'] }, deck: ['선택 (善)'] });
  await drawEvent(g, 0);
  await waitTargetRequest(g, 0);
  g.c(0).act('submit_target', g.c(1).id);
  await waitReveal(g);
  confirmAll(g);
  await g.waitPhase('ENDED');
  await g.waitFor(() => g.c(1).gameOvers.length > 0, 'game_over 수신');
  t.expect(!g.p(0).isAlive && g.p(1).isAlive, '가람 사망, 나래 생존');
});

scenario('선택 (善): 뽑은 자가 아닌 플레이어의 대상 지정은 무시된다', {
  card: '선택 (善)',
  rule: RULE.선택상세,
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['시선'] }, deck: ['선택 (善)'] });
  await drawEvent(g, 0);
  await waitTargetRequest(g, 0);
  g.c(1).act('submit_target', g.c(2).id);
  await g.settle();
  t.expectEq(pendingType(g), 'TARGET_SELECTION', '나래의 지정은 무시되어야 함');
  t.expect(!(g.room.pendingAction as any)?.revealedCards, '공개가 시작되지 않아야 함');
});

/** 선택 대상으로 잘못된 값을 보낸 뒤: 대상 선택이 계속되거나, 살아 있는 생존자가 공개되어야 규칙대로입니다. */
function revealObligationKept(g: GameCtx): boolean {
  const pa: any = g.room.pendingAction;
  if (g.room.phase === 'RESOLVING_EVENT' && pa?.type === 'TARGET_SELECTION') return true;
  if (pa?.revealedCards) return !!g.room.getPlayerById(pa.revealedPlayerId)?.isAlive;
  return false;
}

scenario('선택 (善): 조작된 클라이언트가 없는 id를 보내 공개·죽음을 피할 수 없다', {
  card: '선택 (善)',
  rule: `${RULE.선} / ${RULE.선택상세}`,
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['시선'], 2: ['시선'] }, deck: ['선택 (善)'] });
  await drawEvent(g, 0);
  await waitTargetRequest(g, 0);
  g.c(0).act('submit_target', 'no-such-player');
  await g.settle();
  t.note(`없는 id 지정 후: 단계=${g.room.phase}, 대기=${pendingType(g)}, 가람 생존=${g.p(0).isAlive}, 차례=${nameOf(g, g.room.currentTurnPlayerId)}`);
  t.expect(revealObligationKept(g), '잘못된 id는 거부되고 생존자 1명의 패가 공개되어야 함 (이벤트가 사라져 죽음을 피하면 안 됨)');
});

scenario('선택 (善): 조작된 클라이언트가 죽은 플레이어를 공개 대상으로 지정할 수 없다', {
  card: '선택 (善)',
  rule: `${RULE.선} / ${RULE.선택상세}`,
}, async (t) => {
  const g = await t.game({ players: 4, dead: [3], hands: { 1: ['시선'], 2: ['시선'] }, deck: ['선택 (善)'] });
  await drawEvent(g, 0);
  await waitTargetRequest(g, 0);
  g.c(0).act('submit_target', g.c(3).id);
  await g.settle();
  const revealed = (g.room.pendingAction as any)?.revealedPlayerId;
  t.note(`죽은 라온 지정 후: 단계=${g.room.phase}, 공개 대상=${nameOf(g, revealed)}`);
  const ok = revealObligationKept(g);
  if (revealed) {
    confirmAll(g);
    await g.waitPhase('MAIN');
    t.note(`공개 종료 후 가람 생존=${g.p(0).isAlive} (생존자 나래·다온은 모두 악의 보유)`);
  }
  t.expect(ok, '죽은 플레이어는 공개 대상이 될 수 없어야 함 (생존자 중 한 명)');
});

scenario('선택 (善): 공개 확인 도중 긴급탈출키트를 써도 서버가 죽지 않는다', {
  card: '선택 (善)',
  rule: `${RULE.선} / ${RULE.긴급}`,
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['긴급탈출키트'], 1: ['시선'] }, deck: ['선택 (善)'] });
  await drawEvent(g, 0);
  await waitTargetRequest(g, 0);
  g.c(0).act('submit_target', g.c(1).id);
  await waitReveal(g);
  g.c(2).act('confirm_reveal');
  await g.waitFor(() => !!g.room.pendingAction?.responses[g.c(2).id], '다온 확인');
  g.c(0).act('interrupt_action', g.cardId(0, '긴급탈출키트'));
  await g.settle();
  const pa: any = g.room.pendingAction;
  t.note(`긴급탈출키트 사용 후: 단계=${g.room.phase}, 공개 중=${!!pa?.revealedCards}, 타이머=${pa?.timer ? (pa.timer._destroyed ? '꺼짐' : '동작') : '없음'}, 키트 보유=${g.hand(0).includes('긴급탈출키트')}, 가람 생존=${g.p(0).isAlive}`);
  await g.waitFor(() => g.room.phase === 'MAIN' || g.room.phase === 'ENDED', '이벤트 정리 후 MAIN 복귀');
});

scenario('선택 (善): 결과가 발표된 공개 도중 긴급탈출키트로 뽑은 자의 죽음을 취소할 수 있는가', {
  card: '선택 (善)',
  rule: `${RULE.선} / ${RULE.긴급}`,
  ambiguous: '선택 (善)/(惡)의 결과(뽑은 자 사망)가 이미 발표되고 패 공개 확인만 남은 시점에 긴급탈출키트를 쓰면 이벤트가 취소되어 뽑은 자가 살아남습니까?',
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['긴급탈출키트'], 1: ['시선'] }, deck: ['선택 (善)'] });
  await drawEvent(g, 0);
  await waitTargetRequest(g, 0);
  g.c(0).act('submit_target', g.c(1).id);
  await waitReveal(g);
  t.note(`공개 직전 발표: "${g.msgs(2).find((m) => m.includes('[선택 (善)]')) ?? ''}"`);
  g.c(0).act('interrupt_action', g.cardId(0, '긴급탈출키트'));
  await g.waitFor(() => g.room.phase === 'MAIN' || g.room.phase === 'ENDED', 'MAIN 복귀');
  await g.settle();
  t.note(`긴급탈출키트 사용 후 가람 생존=${g.p(0).isAlive}, 차례=${nameOf(g, g.room.currentTurnPlayerId)}`);
});

scenario('선택 (善): 패 공개 중 submit_cards로 자기 패(악의)를 버릴 수 없다', {
  card: '선택 (善)',
  rule: `${RULE.선} (패 공개는 카드 제출 이벤트가 아님)`,
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['성배'], 2: ['시선', '성배'] }, deck: ['선택 (善)'] });
  await drawEvent(g, 0);
  await waitTargetRequest(g, 0);
  g.c(0).act('submit_target', g.c(1).id);
  await waitReveal(g);
  g.c(2).act('submit_cards', [g.cardId(2, '시선')]);
  await g.settle();
  const during = g.hand(2).join(',');
  g.c(0).act('confirm_reveal');
  g.c(1).act('confirm_reveal');
  await g.waitPhase('MAIN');
  await g.settle();
  t.note(`submit_cards 직후 다온 패=${during || '없음'} / 공개 종료 후 다온 패=${g.hand(2).join(',') || '없음'}, 악의=${g.p(2).currentMalice}, 무덤에 시선=${g.room.graveyard.some((c) => c.name === '시선')}`);
  t.expect(g.hand(2).includes('시선'), '패 공개 중 제출한 악의 카드가 사라지면 안 됨');
  t.expectEq(g.p(2).currentMalice, 1, '다온의 악의 점수는 1점 그대로');
});

scenario('선택 (善): 공개 대상의 선의는 악의 판정을 줄이는가', {
  card: '선택 (善)',
  rule: `${RULE.선} / ${RULE.선의}`,
  ambiguous: '선택 (善)/(惡)에서 공개 대상이 선의를 지니고 있으면 악의 장수를 1장 줄여 셉니까? (선의의 "이벤트 회피 불가" 단서가 공개 대상이 아닌 뽑은 자의 생사에도 적용되는지)',
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['시선', '선의'] }, deck: ['선택 (善)'] });
  await drawEvent(g, 0);
  await waitTargetRequest(g, 0);
  g.c(0).act('submit_target', g.c(1).id);
  await waitReveal(g);
  confirmAll(g);
  await g.waitPhase('MAIN');
  await g.settle();
  t.note(`나래(시선+선의, currentMalice=${g.p(1).currentMalice}) 공개 결과 가람 생존=${g.p(0).isAlive} (선의를 무시하고 악의 1장으로 셈 → 사망)`);
});

// ════════════════════════════════════════════════════════════════════
// 선택 (惡)
// ════════════════════════════════════════════════════════════════════

async function choiceEvil(t: ScenarioApi, targetHand: string[], expectDrawerAlive: boolean, label: string): Promise<void> {
  const g = await t.game({ players: 3, hands: { 1: targetHand }, deck: ['선택 (惡)'] });
  await drawEvent(g, 0);
  await waitTargetRequest(g, 0);
  g.c(0).act('submit_target', g.c(1).id);
  await waitReveal(g);
  t.expect(g.p(0).isAlive, '공개 확인 전에는 살아 있음');
  confirmAll(g);
  await g.waitPhase('MAIN');
  await g.settle();
  t.expectEq(g.p(0).isAlive, expectDrawerAlive, label);
  if (expectDrawerAlive) await drawAgain(t, g, 0);
  else t.expectEq(g.room.currentTurnPlayerId, g.c(1).id, '다음 생존자 나래의 차례');
}

scenario('선택 (惡): 대상 악의가 0장이면 뽑은 자가 죽는다', { card: '선택 (惡)', rule: RULE.악 }, async (t) => {
  await choiceEvil(t, ['성배'], false, '악의 0장 → 가람 사망');
});

scenario('선택 (惡): 대상 악의가 1장이면 뽑은 자가 죽는다', { card: '선택 (惡)', rule: RULE.악 }, async (t) => {
  await choiceEvil(t, ['시선', '성배'], false, '악의 1장 → 가람 사망');
});

scenario('선택 (惡): 대상 악의가 2장이면 뽑은 자는 산다', { card: '선택 (惡)', rule: RULE.악 }, async (t) => {
  await choiceEvil(t, ['시선', '상처'], true, '악의 2장 → 가람 생존');
});

scenario('선택 (惡): 짙은 악의 1장은 패에서 악의 2장으로 세어 뽑은 자가 산다', {
  card: '선택 (惡)',
  rule: `${RULE.악} / ${RULE.짙은악의}`,
}, async (t) => {
  await choiceEvil(t, ['짙은 악의'], true, '짙은 악의(패에서 2장) → 가람 생존');
});

scenario('선택 (惡): 악의를 품은 보물(누군가의 로켓)과 악의 1장을 합쳐 2장으로 뽑은 자가 산다', {
  card: '선택 (惡)',
  rule: `${RULE.악} / ${RULE.누군가}`,
}, async (t) => {
  await choiceEvil(t, ['누군가의 로켓', '시선'], true, '누군가의 로켓+시선 = 악의 2장 → 가람 생존');
});

scenario('선택 (惡): 악의를 품은 도구 1장뿐이면 악의 1장으로 뽑은 자가 죽는다', {
  card: '선택 (惡)',
  rule: `${RULE.악} / ${RULE.누군가}`,
}, async (t) => {
  await choiceEvil(t, ['누군가의 방패'], false, '누군가의 방패 = 악의 1장 → 가람 사망');
});

scenario('선택 (惡): 뽑은 자가 자기 자신을 골라 살아남을 수 있는가', {
  card: '선택 (惡)',
  rule: `${RULE.악} / ${RULE.선택상세}`,
  ambiguous: "선택 (惡)을 뽑은 자가 악의 2장 이상을 들고 있을 때 자기 자신을 공개 대상으로 골라 살아남을 수 있습니까? ('생존자 중 한 명'에 본인 포함 여부)",
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['시선', '상처'], 1: ['성배'] }, deck: ['선택 (惡)'] });
  await drawEvent(g, 0);
  await waitTargetRequest(g, 0);
  g.c(0).act('submit_target', g.c(0).id);
  await g.settle();
  const revealed = (g.room.pendingAction as any)?.revealedPlayerId;
  t.note(`본인 지정 후 공개 대상=${nameOf(g, revealed)}`);
  if (revealed) {
    confirmAll(g);
    await g.waitPhase('MAIN');
  }
  t.note(`결과: 가람(악의 2장) 생존=${g.p(0).isAlive}`);
});

scenario('선택 (惡): 조작된 클라이언트가 없는 id를 보내 공개·죽음을 피할 수 없다', {
  card: '선택 (惡)',
  rule: `${RULE.악} / ${RULE.선택상세}`,
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['성배'], 2: ['성배'] }, deck: ['선택 (惡)'] });
  await drawEvent(g, 0);
  await waitTargetRequest(g, 0);
  g.c(0).act('submit_target', 'no-such-player');
  await g.settle();
  t.note(`없는 id 지정 후: 단계=${g.room.phase}, 대기=${pendingType(g)}, 가람 생존=${g.p(0).isAlive} (나래·다온 모두 악의 0장 → 규칙대로면 가람 사망)`);
  t.expect(revealObligationKept(g), '잘못된 id는 거부되고 생존자 1명의 패가 공개되어야 함');
});

// ════════════════════════════════════════════════════════════════════
// 카르마
// ════════════════════════════════════════════════════════════════════

scenario('카르마: 죽은 자들에게만 대상 요청이 가고 후보는 생존자다', {
  card: '카르마',
  rule: RULE.카르마,
}, async (t) => {
  const g = await t.game({ players: 4, dead: [2, 3], deck: ['카르마'] });
  await drawEvent(g, 0);
  await waitTargetRequest(g, 2);
  await waitTargetRequest(g, 3);
  await g.settle();
  for (const i of [2, 3]) {
    t.expectEq(g.requests(i, 'request_target')[0][0], '카르마', '요청 이벤트 이름');
    t.expectEq(sorted(lastCandidates(g, i)), sorted([g.c(0).id, g.c(1).id]), '후보는 생존자 전원');
  }
  for (const i of [0, 1]) t.expectEq(g.requests(i, 'request_target').length, 0, `생존자 ${g.c(i).name}에게는 요청이 없어야 함`);
});

scenario('카르마: 죽은 자가 고른 생존자의 패에 악의 1장으로 들어간다', {
  card: '카르마',
  rule: `${RULE.카르마} / ${RULE.카르마상세}`,
}, async (t) => {
  const g = await t.game({ players: 3, dead: [2], hands: { 1: ['시선', '상처'] }, deck: ['카르마'] });
  await drawEvent(g, 0);
  await waitTargetRequest(g, 2);
  g.c(2).act('submit_target', g.c(1).id);
  await g.waitFor(() => g.hand(1).includes('카르마'), '나래 패에 카르마');
  await g.waitPhase('MAIN');
  t.expect(g.p(1).hand.malices.some((c) => c.name === '카르마'), '카르마는 악의 칸에 있어야 함');
  t.expectEq(g.p(1).currentMalice, 3, '악의 2 + 카르마 1 = 3');
  t.expectEq(g.p(1).alignment, 'EVIL', '악의 3점 → 악인');
  t.expect(!g.hand(0).includes('카르마'), '뽑은 가람의 패에는 없음');
  await drawAgain(t, g, 0);
});

scenario('카르마: 패로 들어간 카르마는 무덤에 따로 남지 않는다', {
  card: '카르마',
  rule: RULE.카르마상세,
}, async (t) => {
  const g = await t.game({ players: 3, dead: [2], deck: ['카르마'] });
  await drawEvent(g, 0);
  await waitTargetRequest(g, 2);
  g.c(2).act('submit_target', g.c(1).id);
  await g.waitFor(() => g.hand(1).includes('카르마'), '나래 패에 카르마');
  await g.waitPhase('MAIN');
  const inHand = g.p(1).hand.malices.find((c) => c.name === '카르마');
  const inGrave = g.room.graveyard.filter((c) => c.name === '카르마');
  t.note(`패의 카르마 id=${inHand?.id}, 무덤의 카르마 ${inGrave.length}장 (id=${inGrave.map((c) => c.id).join(',')})`);
  t.expectEq(inGrave.length, 0, '나래의 패로 들어간 카르마가 무덤에도 남아 있으면 안 됨 (한 장이 두 곳에 존재)');
});

scenario('카르마: 죽은 자가 없으면 효과 없이 버려지고 뽑은 자는 다시 뽑는다', {
  card: '카르마',
  rule: RULE.카르마,
}, async (t) => {
  const g = await t.game({ players: 3, deck: ['카르마'] });
  await drawEvent(g, 0);
  await g.waitPhase('MAIN');
  await g.settle();
  for (const i of [0, 1, 2]) {
    t.expectEq(g.requests(i, 'request_target').length, 0, `${g.c(i).name}에게 요청 없음`);
    t.expect(!g.hand(i).includes('카르마'), `${g.c(i).name}의 패에 카르마 없음`);
  }
  t.expect(g.room.graveyard.some((c) => c.name === '카르마'), '카르마는 무덤으로');
  await drawAgain(t, g, 0);
});

scenario('카르마: 생존자는 카르마 대상을 정할 수 없다', {
  card: '카르마',
  rule: RULE.카르마,
}, async (t) => {
  const g = await t.game({ players: 3, dead: [2], deck: ['카르마'] });
  await drawEvent(g, 0);
  await waitTargetRequest(g, 2);
  g.c(0).act('submit_target', g.c(1).id);
  g.c(1).act('submit_target', g.c(0).id);
  await g.settle();
  t.expectEq(pendingType(g), 'TARGET_SELECTION', '생존자의 지정은 무시되어야 함');
  t.expect(!g.hand(0).includes('카르마') && !g.hand(1).includes('카르마'), '아직 아무에게도 가지 않음');
  g.c(2).act('submit_target', g.c(0).id);
  await g.waitFor(() => g.hand(0).includes('카르마'), '죽은 다온이 고른 가람에게 카르마');
});

scenario('카르마: 여러 죽은 자의 다수결로 대상이 정해진다', {
  card: '카르마',
  rule: RULE.카르마,
}, async (t) => {
  const g = await t.game({ players: 5, dead: [2, 3, 4], deck: ['카르마'] });
  await drawEvent(g, 0);
  await waitTargetRequest(g, 4);
  g.c(4).act('submit_target', g.c(0).id);
  await g.settle();
  t.expectEq(pendingType(g), 'TARGET_SELECTION', '죽은 자 1명만 정했을 때는 대기');
  g.c(2).act('submit_target', g.c(1).id);
  g.c(3).act('submit_target', g.c(1).id);
  await g.waitFor(() => g.hand(1).includes('카르마') || g.hand(0).includes('카르마'), '카르마 전달');
  t.expect(g.hand(1).includes('카르마'), '2표를 받은 나래에게 가야 함');
  t.expect(!g.hand(0).includes('카르마'), '1표를 받은 가람에게는 가지 않음');
});

scenario('카르마: 죽은 자들의 의견이 동수로 갈리면', {
  card: '카르마',
  rule: RULE.카르마,
  ambiguous: '죽은 자들의 "회의" 결과가 동수로 갈리면 카르마는 누구에게 갑니까? (현재 구현: 먼저 투표된 대상)',
}, async (t) => {
  const g = await t.game({ players: 4, dead: [2, 3], deck: ['카르마'] });
  await drawEvent(g, 0);
  await waitTargetRequest(g, 2);
  g.c(2).act('submit_target', g.c(1).id);
  await g.settle();
  g.c(3).act('submit_target', g.c(0).id);
  await g.waitFor(() => g.hand(1).includes('카르마') || g.hand(0).includes('카르마'), '카르마 전달');
  t.note(`다온→나래, 라온→가람 (1:1) → 카르마 받은 사람: ${g.hand(0).includes('카르마') ? '가람' : '나래'}`);
});

scenario('카르마: 죽은 자가 죽은 플레이어를 지목해도 카르마가 죽은 자의 패로 가지 않는다', {
  card: '카르마',
  rule: RULE.카르마,
}, async (t) => {
  const g = await t.game({ players: 3, dead: [2], deck: ['카르마'] });
  await drawEvent(g, 0);
  await waitTargetRequest(g, 2);
  g.c(2).act('submit_target', g.c(2).id);
  await g.settle();
  t.note(`죽은 다온이 자기 자신 지정 후: 단계=${g.room.phase}, 다온 패=${g.hand(2).join(',') || '없음'}`);
  t.expect(!g.hand(2).includes('카르마'), '카르마는 생존자에게만 건네져야 함 (죽은 자의 패로 가면 안 됨)');
});

scenario('카르마: 죽은 자가 시간 안에 정하지 않으면', {
  card: '카르마',
  rule: RULE.카르마,
  ambiguous: '죽은 자들이 제한시간 안에 대상을 정하지 않으면 카르마는 무작위 생존자에게 갑니까, 버려집니까? (현재 구현: 뽑은 자 포함 무작위 생존자)',
}, async (t) => {
  const g = await t.game({ players: 3, dead: [2], deck: ['카르마'] });
  await drawEvent(g, 0);
  await waitTargetRequest(g, 2);
  await g.waitServerMs(30000);
  await g.waitPhase('MAIN');
  await g.settle();
  const who = [0, 1, 2].filter((i) => g.hand(i).includes('카르마')).map((i) => g.c(i).name);
  t.note(`시간 초과 후 카르마 보유자: ${who.join(',') || '없음'}`);
});

scenario('카르마: 패에 들어간 카르마는 선택 (善)에서 악의로 판정된다', {
  card: '카르마',
  rule: RULE.카르마상세,
}, async (t) => {
  const g = await t.game({ players: 3, dead: [2], deck: ['카르마', '선택 (善)'] });
  await drawEvent(g, 0);
  await waitTargetRequest(g, 2);
  g.c(2).act('submit_target', g.c(1).id);
  await g.waitFor(() => g.hand(1).includes('카르마'), '나래 패에 카르마');
  await g.waitPhase('MAIN');
  await drawEvent(g, 0);
  await g.waitFor(() => g.requests(0, 'request_target').length > 0, '선택 (善) 대상 요청');
  g.c(0).act('submit_target', g.c(1).id);
  await waitReveal(g);
  confirmAll(g);
  await g.settle();
  await g.settle();
  t.expect(!g.p(0).isAlive, '나래의 카르마(악의 1장) 때문에 가람이 죽어야 함');
});

// ════════════════════════════════════════════════════════════════════
// 폴터가이스트
// ════════════════════════════════════════════════════════════════════

async function poltergeist(g: GameCtx, ghost: number, target: number): Promise<void> {
  await drawEvent(g, 0);
  await waitTargetRequest(g, ghost);
  g.c(ghost).act('submit_target', g.c(target).id);
  await g.waitPhase('WAITING_FOR_DEFENSE');
}

scenario('폴터가이스트: 죽은 자가 고른 생존자가 방어하지 않으면 죽는다', {
  card: '폴터가이스트',
  rule: RULE.폴터,
}, async (t) => {
  const g = await t.game({ players: 4, dead: [3], deck: ['폴터가이스트'] });
  await drawEvent(g, 0);
  await waitTargetRequest(g, 3);
  await g.settle();
  for (const i of [0, 1, 2]) t.expectEq(g.requests(i, 'request_target').length, 0, `생존자 ${g.c(i).name}에게 요청 없음`);
  t.expectEq(sorted(lastCandidates(g, 3)), sorted([g.c(0).id, g.c(1).id, g.c(2).id]), '후보는 생존자 전원');
  g.c(3).act('submit_target', g.c(1).id);
  await g.waitPhase('WAITING_FOR_DEFENSE');
  t.expectEq(g.room.pendingAction?.targetId, g.c(1).id, '나래가 방어 대상');
  g.c(1).act('skip_defense');
  await g.waitFor(() => !g.p(1).isAlive, '나래 사망');
  await g.waitPhase('MAIN');
  await drawAgain(t, g, 0);
});

scenario('폴터가이스트: 대상은 방패로 막을 수 있다', {
  card: '폴터가이스트',
  rule: RULE.폴터,
}, async (t) => {
  const g = await t.game({ players: 4, dead: [3], hands: { 1: ['황금 방패'] }, deck: ['폴터가이스트'] });
  await poltergeist(g, 3, 1);
  g.c(1).act('play_shield', g.cardId(1, '황금 방패'));
  await g.waitPhase('MAIN');
  await g.settle();
  t.expect(g.p(1).isAlive, '나래 생존');
  t.expectEq(g.hand(1), [], '황금 방패 소모');
});

scenario('폴터가이스트: 침묵으로 막을 수 없다', {
  card: '폴터가이스트',
  rule: `${RULE.폴터} / ${RULE.침묵}`,
}, async (t) => {
  const g = await t.game({ players: 4, dead: [3], hands: { 1: ['침묵'] }, deck: ['폴터가이스트'] });
  await poltergeist(g, 3, 1);
  g.c(1).act('interrupt_action', g.cardId(1, '침묵'), g.c(0).id);
  await g.settle();
  t.note(`침묵 시도 후 침묵 보유=${g.hand(1).includes('침묵')}`);
  t.expectEq(g.room.phase, 'WAITING_FOR_DEFENSE', '폴터가이스트 공격은 계속되어야 함');
  t.expectEq(g.room.pendingAction?.targetId, g.c(1).id, '대상은 여전히 나래');
  g.c(1).act('skip_defense');
  await g.waitFor(() => !g.p(1).isAlive, '나래 사망');
});

scenario('폴터가이스트: 거울 방패로 막으면 되돌릴 생존자 공격자가 없으므로 아무도 죽지 않는다', {
  card: '폴터가이스트',
  rule: `${RULE.폴터} / ${RULE.거울}`,
}, async (t) => {
  const g = await t.game({ players: 4, dead: [3], hands: { 1: ['거울 방패'] }, deck: ['폴터가이스트'] });
  await poltergeist(g, 3, 1);
  g.c(1).act('play_shield', g.cardId(1, '거울 방패'));
  await g.waitPhase('MAIN');
  await g.settle();
  t.expect([0, 1, 2].every((i) => g.p(i).isAlive), '생존자 모두 살아 있어야 함');
  t.expectEq(g.room.currentTurnPlayerId, g.c(0).id, '가람 차례 유지');
});

scenario('폴터가이스트: 다른 생존자가 수호천사로 대신 막아줄 수 있다', {
  card: '폴터가이스트',
  rule: `${RULE.폴터} / ${RULE.수호천사}`,
}, async (t) => {
  const g = await t.game({ players: 4, dead: [3], hands: { 2: ['수호천사'] }, deck: ['폴터가이스트'] });
  await poltergeist(g, 3, 1);
  g.c(2).act('play_shield', g.cardId(2, '수호천사'), g.c(1).id);
  await g.waitPhase('MAIN');
  await g.settle();
  t.expect(g.p(1).isAlive, '나래 생존');
  t.expectEq(g.hand(2), [], '수호천사 소모');
});

scenario('폴터가이스트: 죽은 자가 없으면 아무 일도 일어나지 않고 뽑은 자는 다시 뽑는다', {
  card: '폴터가이스트',
  rule: RULE.폴터,
}, async (t) => {
  const g = await t.game({ players: 3, deck: ['폴터가이스트'] });
  await drawEvent(g, 0);
  await g.waitPhase('MAIN');
  await g.settle();
  t.expect([0, 1, 2].every((i) => g.p(i).isAlive), '모두 생존');
  for (const i of [0, 1, 2]) t.expectEq(g.requests(i, 'request_target').length, 0, '요청 없음');
  await drawAgain(t, g, 0);
});

scenario('폴터가이스트: 생존자는 대상을 정할 수 없다', {
  card: '폴터가이스트',
  rule: RULE.폴터,
}, async (t) => {
  const g = await t.game({ players: 4, dead: [3], deck: ['폴터가이스트'] });
  await drawEvent(g, 0);
  await waitTargetRequest(g, 3);
  g.c(0).act('submit_target', g.c(1).id);
  g.c(2).act('submit_target', g.c(1).id);
  await g.settle();
  t.expectEq(pendingType(g), 'TARGET_SELECTION', '생존자의 지정은 무시');
  t.expectEq(g.room.phase, 'RESOLVING_EVENT', '아직 공격 전');
});

scenario('폴터가이스트: 죽은 자가 뽑은 자를 지목해 죽이면 다음 생존자 차례로 넘어간다', {
  card: '폴터가이스트',
  rule: RULE.폴터,
}, async (t) => {
  const g = await t.game({ players: 4, dead: [3], deck: ['폴터가이스트'] });
  await poltergeist(g, 3, 0);
  g.c(0).act('skip_defense');
  await g.waitFor(() => !g.p(0).isAlive, '가람 사망');
  await g.waitPhase('MAIN');
  t.expectEq(g.room.currentTurnPlayerId, g.c(1).id, '나래의 차례');
});

scenario('폴터가이스트: 죽은 자가 죽은 플레이어를 지목하면 거부된다', {
  card: '폴터가이스트',
  rule: RULE.폴터,
  allowViolations: ['DEFENSE_TARGET_DEAD'],
}, async (t) => {
  const g = await t.game({ players: 4, dead: [3], deck: ['폴터가이스트'] });
  await drawEvent(g, 0);
  await waitTargetRequest(g, 3);
  g.c(3).act('submit_target', g.c(3).id);
  await g.settle();
  const tgt = g.room.pendingAction?.targetId;
  t.note(`죽은 라온이 자기 자신 지정 후: 단계=${g.room.phase}, 방어 대상=${nameOf(g, tgt)}`);
  t.expect(!(g.room.phase === 'WAITING_FOR_DEFENSE' && tgt === g.c(3).id), '죽은 플레이어를 대상으로 한 방어 단계가 열리면 안 됨 (생존자 중 한 명)');
});

// ════════════════════════════════════════════════════════════════════
// 뒤바뀐 영혼
// ════════════════════════════════════════════════════════════════════

scenario('뒤바뀐 영혼: 고른 생존자와 패 전체를 맞바꾸고 악의 점수도 바뀐다', {
  card: '뒤바뀐 영혼',
  rule: RULE.뒤바뀐,
}, async (t) => {
  const g = await t.game({
    players: 3,
    hands: { 0: ['시선', '황금 방패'], 1: ['짙은 악의', '상처', '성배'], 2: ['코인'] },
    deck: ['뒤바뀐 영혼'],
  });
  await drawEvent(g, 0);
  await waitTargetRequest(g, 0);
  t.expectEq(sorted(lastCandidates(g, 0)), sorted([g.c(1).id, g.c(2).id]), '후보는 자신을 뺀 생존자');
  for (const i of [1, 2]) t.expectEq(g.requests(i, 'request_target').length, 0, '다른 사람에게 요청 없음');
  g.c(0).act('submit_target', g.c(1).id);
  await g.waitPhase('MAIN');
  await g.settle();
  t.expectEq(sorted(g.hand(0)), sorted(['짙은 악의', '상처', '성배']), '가람이 나래의 패를 받음');
  t.expectEq(sorted(g.hand(1)), sorted(['시선', '황금 방패']), '나래가 가람의 패를 받음');
  t.expectEq(g.hand(2), ['코인'], '다온은 그대로');
  t.expectEq(g.p(0).currentMalice, 3, '가람 악의 3');
  t.expectEq(g.p(0).alignment, 'EVIL', '가람 악인');
  t.expectEq(g.p(1).currentMalice, 1, '나래 악의 1');
  t.expectEq(g.p(1).alignment, 'GOOD', '나래 선인');
  await drawAgain(t, g, 0);
});

scenario('뒤바뀐 영혼: 자기 자신을 고르면 거부되고 다시 고를 수 있다', {
  card: '뒤바뀐 영혼',
  rule: RULE.뒤바뀐,
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['시선'], 1: ['성배'] }, deck: ['뒤바뀐 영혼'] });
  await drawEvent(g, 0);
  await waitTargetRequest(g, 0);
  g.c(0).act('submit_target', g.c(0).id);
  await g.settle();
  t.expectEq(pendingType(g), 'TARGET_SELECTION', '자기 자신 지정은 거부되고 대기 유지');
  t.expectEq(g.hand(0), ['시선'], '패 변화 없음');
  g.c(0).act('submit_target', g.c(1).id);
  await g.waitPhase('MAIN');
  t.expectEq(g.hand(0), ['성배'], '나래와 교환됨');
});

scenario('뒤바뀐 영혼: 대상 선택 시간이 지나면 무작위 다른 생존자와 패가 바뀐다', {
  card: '뒤바뀐 영혼',
  rule: RULE.뒤바뀐,
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['시선'], 1: ['성배'], 2: ['황금 방패'] }, deck: ['뒤바뀐 영혼'] });
  await drawEvent(g, 0);
  await waitTargetRequest(g, 0);
  await g.waitServerMs(30000);
  await g.waitPhase('MAIN');
  await g.settle();
  const partner = g.hand(1).includes('시선') ? 1 : g.hand(2).includes('시선') ? 2 : -1;
  t.note(`시간 초과 후 교환 상대: ${partner >= 0 ? g.c(partner).name : '없음'}`);
  t.expect(partner > 0, '다른 생존자 1명과 교환되어야 함');
  t.expectEq(g.hand(0), [partner === 1 ? '성배' : '황금 방패'], '가람은 상대의 패를 받음');
});

scenario('뒤바뀐 영혼: 조작된 클라이언트가 죽은 플레이어와 패를 바꿀 수 없다', {
  card: '뒤바뀐 영혼',
  rule: RULE.뒤바뀐,
}, async (t) => {
  const g = await t.game({ players: 4, dead: [3], hands: { 0: ['시선', '상처', '흑역사'], 3: ['성배'] }, deck: ['뒤바뀐 영혼'] });
  await drawEvent(g, 0);
  await waitTargetRequest(g, 0);
  g.c(0).act('submit_target', g.c(3).id);
  await g.settle();
  t.note(`죽은 라온 지정 후: 단계=${g.room.phase}, 가람 패=${g.hand(0).join(',')} (악의 ${g.p(0).currentMalice}), 라온 패=${g.hand(3).join(',')}`);
  t.expectEq(sorted(g.hand(3)), ['성배'], '죽은 라온의 패는 바뀌면 안 됨 (생존자 중 한 명과만 교환)');
  t.expect(g.hand(0).includes('시선'), '가람의 악의가 죽은 자에게 넘어가면 안 됨');
});

scenario('뒤바뀐 영혼: 조작된 클라이언트가 없는 id를 보내도 교환 의무가 남는다', {
  card: '뒤바뀐 영혼',
  rule: RULE.뒤바뀐,
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['시선'], 1: ['성배'], 2: ['황금 방패'] }, deck: ['뒤바뀐 영혼'] });
  await drawEvent(g, 0);
  await waitTargetRequest(g, 0);
  g.c(0).act('submit_target', 'no-such-player');
  await g.settle();
  t.note(`없는 id 지정 후: 단계=${g.room.phase}, 대기=${pendingType(g)}, 가람 패=${g.hand(0).join(',')}`);
  const swapped = !g.hand(0).includes('시선');
  t.expect(pendingType(g) === 'TARGET_SELECTION' || swapped, '잘못된 id는 거부되고 대상 선택이 계속되어야 함 (이벤트가 그냥 사라지면 안 됨)');
});

scenario('뒤바뀐 영혼: 뽑은 자가 아닌 플레이어의 지정은 무시된다', {
  card: '뒤바뀐 영혼',
  rule: RULE.뒤바뀐,
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['시선'], 1: ['성배'], 2: ['황금 방패'] }, deck: ['뒤바뀐 영혼'] });
  await drawEvent(g, 0);
  await waitTargetRequest(g, 0);
  g.c(1).act('submit_target', g.c(2).id);
  await g.settle();
  t.expectEq(pendingType(g), 'TARGET_SELECTION', '나래의 지정은 무시');
  t.expectEq(g.hand(0), ['시선'], '패 변화 없음');
  t.expectEq(g.hand(1), ['성배'], '나래 패 변화 없음');
});

// ════════════════════════════════════════════════════════════════════
// 선물
// ════════════════════════════════════════════════════════════════════

async function giftStart(g: GameCtx): Promise<void> {
  await drawEvent(g, 0);
  await waitTargetRequest(g, 0);
}

scenario('선물: 고른 카드 1장이 고른 생존자에게 가고 악의 점수가 갱신된다', {
  card: '선물',
  rule: RULE.선물,
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['시선', '성배'], 1: ['상처'] }, deck: ['선물'] });
  await giftStart(g);
  t.expectEq(g.requests(0, 'request_target')[0][0], '선물', '요청 이벤트 이름');
  t.expectEq(sorted(lastCandidates(g, 0)), sorted([g.c(1).id, g.c(2).id]), '후보는 다른 생존자');
  g.c(0).act('submit_gift', g.cardId(0, '시선'), g.c(1).id);
  await g.waitFor(() => g.hand(1).includes('시선'), '나래에게 시선 도착');
  await g.waitPhase('MAIN');
  t.expectEq(g.hand(0), ['성배'], '가람에게는 성배만 남음');
  t.expectEq(sorted(g.hand(1)), sorted(['상처', '시선']), '나래 패');
  t.expectEq(g.hand(2), [], '다온 변화 없음');
  t.expectEq(g.p(0).currentMalice, 0, '가람 악의 0');
  t.expectEq(g.p(1).currentMalice, 2, '나래 악의 2');
  await drawAgain(t, g, 0);
});

scenario('선물: 자기 자신에게는 선물할 수 없다', { card: '선물', rule: RULE.선물 }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['시선', '성배'] }, deck: ['선물'] });
  await giftStart(g);
  g.c(0).act('submit_gift', g.cardId(0, '시선'), g.c(0).id);
  await g.settle();
  t.expectEq(g.room.activeEvent?.name, '선물', '선물 대기 유지');
  t.expectEq(pendingType(g), 'TARGET_SELECTION', '거부되고 대기 유지');
  t.expectEq(sorted(g.hand(0)), sorted(['시선', '성배']), '패 변화 없음');
});

scenario('선물: 죽은 플레이어에게는 선물할 수 없다', { card: '선물', rule: RULE.선물 }, async (t) => {
  const g = await t.game({ players: 4, dead: [3], hands: { 0: ['시선', '성배'] }, deck: ['선물'] });
  await giftStart(g);
  t.expect(!lastCandidates(g, 0).includes(g.c(3).id), '후보에 죽은 라온 없음');
  g.c(0).act('submit_gift', g.cardId(0, '시선'), g.c(3).id);
  await g.settle();
  t.expectEq(pendingType(g), 'TARGET_SELECTION', '거부되고 대기 유지');
  t.expectEq(g.hand(3), [], '죽은 라온 패 변화 없음');
});

scenario('선물: 패에 없는 카드는 선물할 수 없다', { card: '선물', rule: RULE.선물 }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성배'], 1: ['시선'] }, deck: ['선물'] });
  await giftStart(g);
  g.c(0).act('submit_gift', g.cardId(1, '시선'), g.c(2).id);
  await g.settle();
  t.expectEq(pendingType(g), 'TARGET_SELECTION', '거부되고 대기 유지');
  t.expectEq(g.hand(1), ['시선'], '나래의 카드는 그대로');
  t.expectEq(g.hand(2), [], '다온 변화 없음');
});

scenario('선물: 뽑은 자가 아닌 플레이어는 선물을 보낼 수 없다', { card: '선물', rule: RULE.선물 }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성배'], 1: ['시선'] }, deck: ['선물'] });
  await giftStart(g);
  g.c(1).act('submit_gift', g.cardId(1, '시선'), g.c(2).id);
  await g.settle();
  t.expectEq(pendingType(g), 'TARGET_SELECTION', '나래의 선물은 무시');
  t.expectEq(g.hand(1), ['시선'], '나래 패 그대로');
  t.expectEq(g.hand(2), [], '다온 변화 없음');
});

scenario('선물: 시간이 지나면 무작위 카드 1장이 다른 생존자에게 간다', { card: '선물', rule: RULE.선물 }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['시선', '성배', '황금 방패'] }, deck: ['선물'] });
  await giftStart(g);
  await g.waitServerMs(30000);
  await g.waitPhase('MAIN');
  await g.settle();
  t.note(`시간 초과 후: 가람=${g.hand(0).join(',')}, 나래=${g.hand(1).join(',') || '-'}, 다온=${g.hand(2).join(',') || '-'}`);
  t.expectEq(g.hand(0).length, 2, '가람은 1장을 잃음');
  t.expectEq(g.hand(1).length + g.hand(2).length, 1, '다른 생존자 중 한 명이 1장을 받음');
  await drawAgain(t, g, 0);
});

scenario('선물: 패가 비어 있으면 아무 일 없이 끝나고 뽑은 자는 다시 뽑는다', { card: '선물', rule: RULE.선물 }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['시선'] }, deck: ['선물'] });
  await drawEvent(g, 0);
  await g.waitServerMs(30000);
  await g.waitPhase('MAIN');
  await g.settle();
  t.expectEq(g.hand(1), ['시선'], '다른 사람 패 변화 없음');
  t.expectEq(g.hand(2), [], '다온 변화 없음');
  await drawAgain(t, g, 0);
});

// ════════════════════════════════════════════════════════════════════
// 빙의
// ════════════════════════════════════════════════════════════════════

scenario('빙의: 죽은 자가 없으면 효과 없이 뽑은 자가 계속 진행한다', {
  card: '빙의',
  rule: RULE.빙의,
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['시선'] }, deck: ['빙의'] });
  await drawEvent(g, 0);
  await g.waitPhase('MAIN');
  await g.settle();
  t.expectEq(g.hand(0), ['시선'], '패 그대로');
  await drawAgain(t, g, 0);
});

scenario('빙의: 죽은 자가 있으면 뽑은 자의 차례가 끝나고 패는 그대로 돌아온다', {
  card: '빙의',
  rule: RULE.빙의,
}, async (t) => {
  const g = await t.game({ players: 4, dead: [3], hands: { 0: ['시선', '성배'] }, deck: ['빙의'] });
  await drawEvent(g, 0);
  // 죽은 자들이 차례를 마칠 기회를 줍니다 (end_turn은 받아들여지지 않을 수 있음)
  await g.settle();
  if (g.room.currentTurnPlayerId === g.c(0).id) {
    g.c(3).act('end_turn');
    await g.settle();
  }
  await g.waitFor(() => g.room.currentTurnPlayerId === g.c(1).id, '빙의된 차례가 끝나고 나래 차례');
  t.expect(g.p(0).isAlive, '가람은 살아 있음');
  t.expectEq(sorted(g.hand(0)), sorted(['시선', '성배']), '가람의 패는 돌려받아야 함');
  const deckBefore = g.room.deck.length;
  g.c(0).act('draw_card');
  await g.settle();
  t.expectEq(g.room.deck.length, deckBefore, '차례가 끝난 가람은 더 뽑을 수 없음');
});

scenario('빙의: 죽은 자들이 뽑은 자의 패와 차례를 대신 사용한다', {
  card: '빙의',
  rule: RULE.빙의,
  ambiguous: '빙의 시 죽은 자들이 실제로 뽑은 자의 패와 차례를 대신 사용해(드로우·도구 사용 등) 진행해야 합니까, 아니면 뽑은 자의 차례를 즉시 끝내는 것으로 충분합니까? 죽은 자가 여럿이면 누가 조종합니까?',
}, async (t) => {
  const g = await t.game({ players: 4, dead: [3], hands: { 0: ['시선', '성배'] }, deck: ['빙의'] });
  await drawEvent(g, 0);
  await g.settle();
  const turnAfter = nameOf(g, g.room.currentTurnPlayerId);
  const reqs = ['request_target', 'request_vote', 'request_cards'].map((e) => `${e}:${g.requests(3, e).length}`).join(' ');
  t.note(`빙의 직후 차례=${turnAfter}, 단계=${g.room.phase}, 죽은 라온이 받은 요청 ${reqs}`);
  const handBefore = g.hand(0).length;
  g.c(3).act('draw_card');
  await g.settle();
  t.note(`죽은 라온이 draw_card를 보낸 뒤 가람 패 ${handBefore}→${g.hand(0).length}장, 라온 패 ${g.hand(3).length}장`);
  t.expectEq(turnAfter, g.c(0).name, '빙의된 차례는 (죽은 자들이 조종하는) 가람의 차례로 유지되어야 함');
  t.expect(g.hand(0).length > handBefore, '죽은 자가 가람의 차례로 카드를 뽑을 수 있어야 함');
});
