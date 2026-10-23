import { scenario } from '../harness/runner';
import type { GameCtx } from '../harness/game';
import { makeSyntheticWeapon } from '../harness/cards';
import { isTimerPending } from '../harness/timescale';

// 방패 카드 그룹: 황금 방패, 골든 레코드, 부처님 손바닥, 수호천사, 거울 방패, 누군가의 방패
// 규칙(card.json)대로라면 일어나야 하는 일을 단언합니다. 실패 = 현재 구현이 규칙과 다름.

const ORDINARY = ['황금 방패', '골든 레코드', '부처님 손바닥'] as const;

const RULE_ORDINARY = '다른 생존자가 무기로 공격할 때 차례와 관계없이 즉시 막을 수 있으며, 사용 후 버립니다.';
const RULE_ANGEL = '이 방패는 자신뿐만 아니라 다른 생존자에게 향하는 공격을 대신 막아줄 수 있습니다. / 타인이 공격받는 상황(이벤트의 화살 함정 포함)에서 차례를 무시하고 개입하여 방어해 줄 수 있습니다.';
const RULE_MIRROR = '이 방패는 다른 생존자가 당신을 공격할 때 사용하면 그대로 그 공격을 당신을 공격한 생존자에게 돌려줍니다.';
const RULE_MIRROR_SPEAR = "'필멸의 창' 공격을 반사할 시, 애초에 창을 던졌던 원래 공격자가 아니라 나에게 창을 넘긴 직전의 생존자에게 반사합니다.";
const RULE_SOMEONE = '이 방패는 악의인 동시에 방패입니다. 악의를 제외한 카드로 사용 가능합니다.';
const RULE_SOMEONE_EVENT = '이벤트에 제출 시, 이 카드 단독으로는 불가능하며 다른 도구 카드 혹은 악의 카드와 섞어서 제출해야 합니다.';
const RULE_BLOODY_2 = '[피바라기 2] 피바라기를 뽑은 생존자는 자신에게 수호천사(특수 방패)가 있을지라도 자신을 타겟으로 한 반사를 대신 막아주기가 불가능합니다.';
const RULE_SILENCE = '[침묵] 이 카드를 사용하면 한 생존자를 선택해 이번 차례에 도구를 못 내게 합니다. 도구를 낸 순간도 침묵이 가능하며 차례와 관계없이 사용 가능합니다. / 침묵에 걸린 상대방은 이번 차례에 앞서 냈던 도구(방패 등)를 다시 패로 회수해야 하며 해당 카드의 효과는 무효화됩니다.';
const RULE_EXCALIBUR = '[엑스칼리버] 이 검은 모든 방패를 뚫을 수 있습니다.';
const RULE_ARROW = '[화살 함정] 날아오는 화살들을 생존자 중 한 명이 방패로 막지 않는다면 이 카드를 뽑은 자는 죽게 됩니다. / 자신이 방패가 없더라도 다른 생존자가 \'방패\'를 사용하여 대신 막아줄 수 있습니다.';

// ── 헬퍼 ──────────────────────────────────────────────────────────

const graveCount = (g: GameCtx, name: string) => g.room.graveyard.filter((c) => c.name === name).length;
const inGrave = (g: GameCtx, name: string) => graveCount(g, name) > 0;
const pendingTarget = (g: GameCtx) => g.indexOf(g.room.pendingAction?.targetId ?? null);
const pendingInitiator = (g: GameCtx) => g.indexOf(g.room.pendingAction?.initiatorId ?? null);

/** i번 소켓이 앞서 보낸 메시지가 서버에서 모두 처리될 때까지 기다립니다 (채팅 왕복으로 순서 보장). */
async function barrier(g: GameCtx, i: number): Promise<void> {
  const before = g.c(i).eventsOf('chat_message').length;
  g.c(i).act('send_chat', '.');
  await g.waitFor(() => g.c(i).eventsOf('chat_message').length > before, `${i}번 배리어`);
  await g.settle();
}

async function attack(g: GameCtx, from: number, weapon: string, to: number): Promise<void> {
  g.c(from).act('play_tool', g.cardId(from, weapon), g.c(to).id);
  await g.waitFor(
    () => g.room.phase === 'WAITING_FOR_DEFENSE' && g.room.pendingAction?.targetId === g.c(to).id,
    `${from}번 → ${to}번 공격 방어 단계`,
  );
}

function shield(g: GameCtx, who: number, name: string): void {
  g.c(who).act('play_shield', g.cardId(who, name));
}

async function waitTarget(g: GameCtx, i: number, label: string): Promise<void> {
  await g.waitFor(() => g.room.phase === 'WAITING_FOR_DEFENSE' && g.room.pendingAction?.targetId === g.c(i).id, label);
}

/** 0번(차례 주인)이 덱 맨 위 이벤트를 뽑아 대기 상태가 될 때까지. */
async function drawEvent(g: GameCtx, eventName: string, who = 0): Promise<void> {
  g.c(who).act('draw_card');
  await g.waitFor(() => g.room.graveyard.some((c) => c.name === eventName), `${eventName} 발동`);
}

async function bloodyAt(g: GameCtx, targetIdx: number): Promise<void> {
  await drawEvent(g, '피바라기');
  await g.waitFor(() => g.requests(0, 'request_target').length > 0, '피바라기 대상 선택 요청');
  g.c(0).act('submit_target', g.c(targetIdx).id);
  await waitTarget(g, targetIdx, '피바라기 방어 단계');
}

// ══════════════════════════════════════════════════════════════════
// 일반 방패 (황금 방패 / 골든 레코드 / 부처님 손바닥)
// ══════════════════════════════════════════════════════════════════

for (const name of ORDINARY) {
  scenario(`${name}: 공격받은 생존자가 사용하면 공격을 막고 방패는 무덤으로 간다`, { card: name, rule: RULE_ORDINARY }, async (t) => {
    const g = await t.game({ players: 3, hands: { 0: ['성정'], 1: [name, '코인'] } });
    await attack(g, 0, '성정', 1);
    shield(g, 1, name);
    await g.waitPhase('MAIN');
    t.expect(g.p(1).isAlive, '방어한 1번은 살아 있어야 함');
    t.expect(g.p(0).isAlive, '공격자 0번도 살아 있어야 함');
    t.expectEq(g.hand(1), ['코인'], '사용한 방패만 패에서 빠져야 함');
    t.expectEq(graveCount(g, name), 1, `무덤에 ${name} 1장`);
    t.expect(inGrave(g, '성정'), '사용한 무기도 무덤에 있어야 함');
    t.expectEq(g.room.currentTurnPlayerId, g.c(0).id, '차례는 그대로 0번');
  });

  scenario(`${name}: 공격받지 않은 제3자는 대신 막을 수 없다`, { card: name, rule: RULE_ORDINARY + ' (수호천사가 아닌 방패는 공격받은 본인만 사용)' }, async (t) => {
    const g = await t.game({ players: 3, hands: { 0: ['성정'], 2: [name] }, eventTimeoutMs: 120000 });
    await attack(g, 0, '성정', 1);
    shield(g, 2, name);
    await barrier(g, 2);
    t.expectEq(g.room.phase, 'WAITING_FOR_DEFENSE', '제3자의 일반 방패는 거부되어 방어 단계가 유지되어야 함');
    t.expectEq(g.hand(2), [name], '거부된 방패는 2번 패에 남아 있어야 함');
    t.expect(!inGrave(g, name), '거부된 방패가 무덤에 가면 안 됨');
    g.c(1).act('skip_defense');
    await g.waitFor(() => !g.p(1).isAlive, '1번 사망');
    await g.waitPhase('MAIN');
  });
}

scenario('황금 방패: 공격자는 자신의 공격을 자기 방패로 막을 수 없다', { card: '황금 방패', rule: RULE_ORDINARY }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정', '황금 방패'] }, eventTimeoutMs: 120000 });
  await attack(g, 0, '성정', 1);
  shield(g, 0, '황금 방패');
  await barrier(g, 0);
  t.expectEq(g.room.phase, 'WAITING_FOR_DEFENSE', '방어 단계가 유지되어야 함');
  t.expectEq(g.hand(0), ['황금 방패'], '공격자의 방패는 소모되지 않아야 함');
  g.c(1).act('skip_defense');
  await g.waitFor(() => !g.p(1).isAlive, '1번 사망');
});

scenario('골든 레코드: 난투 중 차례가 아닌 생존자의 공격도 차례 주인이 막을 수 있다 (차례와 관계없이)', { card: '골든 레코드', rule: RULE_ORDINARY }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['골든 레코드'], 1: ['성정'] }, deck: ['난투'] });
  await drawEvent(g, '난투');
  await g.waitFor(() => g.room.freeForAll && g.room.phase === 'MAIN', '난투 시작');
  await attack(g, 1, '성정', 0);
  shield(g, 0, '골든 레코드');
  await g.waitPhase('MAIN');
  t.expect(g.p(0).isAlive, '0번은 살아 있어야 함');
  t.expect(inGrave(g, '골든 레코드'), '골든 레코드는 무덤으로');
  t.expectEq(g.hand(0), [], '0번 패는 비어야 함');
});

scenario('부처님 손바닥: 피바라기 공격도 피격자가 막을 수 있다', { card: '부처님 손바닥', rule: RULE_ORDINARY + ' / [피바라기] 단, 이 검도 방패로 막을 수 있습니다.' }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['부처님 손바닥'] }, deck: ['피바라기'] });
  await bloodyAt(g, 1);
  shield(g, 1, '부처님 손바닥');
  await g.waitPhase('MAIN');
  t.expect(g.p(1).isAlive, '1번 생존');
  t.expect(g.p(0).isAlive, '0번 생존');
  t.expect(inGrave(g, '부처님 손바닥'), '방패는 무덤으로');
  t.expect(!g.p(0).hasDrawnThisTurn, '이벤트 처리 후 0번은 다시 뽑아야 함');
});

scenario('골든 레코드: 폴터가이스트의 칼을 피격자가 막는다', { card: '골든 레코드', rule: RULE_ORDINARY + ' / [폴터가이스트] 단, 이 칼 역시 방패로 막을 수 있습니다.' }, async (t) => {
  const g = await t.game({ players: 4, dead: [3], hands: { 1: ['골든 레코드'] }, deck: ['폴터가이스트'] });
  await drawEvent(g, '폴터가이스트');
  await g.waitFor(() => g.requests(3, 'request_target').length > 0, '망자에게 대상 선택 요청');
  g.c(3).act('submit_target', g.c(1).id);
  await waitTarget(g, 1, '폴터가이스트 방어 단계');
  shield(g, 1, '골든 레코드');
  await g.waitPhase('MAIN');
  t.expect(g.p(1).isAlive, '1번 생존');
  t.expect(inGrave(g, '골든 레코드'), '방패는 무덤으로');
});

scenario('부처님 손바닥: 방어 단계가 아닐 때(MAIN)는 방패를 낼 수 없다', { card: '부처님 손바닥', rule: RULE_ORDINARY }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['부처님 손바닥'], 1: ['황금 방패'] } });
  g.c(0).act('play_shield', g.cardId(0, '부처님 손바닥'));
  g.c(1).act('play_shield', g.cardId(1, '황금 방패'));
  // 방패를 무기처럼 play_tool로 내는 것도 무시되어야 함
  g.c(0).act('play_tool', g.cardId(0, '부처님 손바닥'), g.c(1).id);
  await barrier(g, 0);
  await barrier(g, 1);
  t.expectEq(g.room.phase, 'MAIN', '단계 변화 없음');
  t.expectEq(g.hand(0), ['부처님 손바닥'], '0번 방패 그대로');
  t.expectEq(g.hand(1), ['황금 방패'], '1번 방패 그대로');
  t.expectEq(g.room.graveyard.length, 0, '무덤은 비어 있어야 함');
  t.expect(g.p(1).isAlive && g.p(0).isAlive, '모두 생존');
});

scenario('황금 방패: 이벤트 투표(천사의 심판대) 중에는 방패를 낼 수 없다', { card: '황금 방패', rule: RULE_ORDINARY + ' (무기 공격이 아닌 상황에서는 사용 불가)' }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['황금 방패'] }, deck: ['천사의 심판대'], eventTimeoutMs: 120000 });
  await drawEvent(g, '천사의 심판대');
  await g.waitFor(() => g.room.pendingAction?.type === 'VOTE', '투표 시작');
  g.c(1).act('play_shield', g.cardId(1, '황금 방패'));
  await barrier(g, 1);
  t.expectEq(g.room.phase, 'RESOLVING_EVENT', '투표가 계속되어야 함');
  t.expectEq(g.room.pendingAction?.type, 'VOTE', '대기 액션은 여전히 투표');
  t.expectEq(g.hand(1), ['황금 방패'], '방패가 소모되면 안 됨');
});

scenario('황금 방패: 방어가 끝난 뒤 연달아 낸 두 번째 방패는 소모되지 않는다', { card: '황금 방패', rule: RULE_ORDINARY }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정'], 1: ['황금 방패', '골든 레코드'] } });
  await attack(g, 0, '성정', 1);
  g.c(1).act('play_shield', g.cardId(1, '황금 방패'));
  g.c(1).act('play_shield', g.cardId(1, '골든 레코드'));
  await g.waitPhase('MAIN');
  await barrier(g, 1);
  t.expect(g.p(1).isAlive, '1번 생존');
  t.expectEq(g.hand(1), ['골든 레코드'], '두 번째 방패는 패에 남아야 함');
  t.expectEq(graveCount(g, '골든 레코드'), 0, '골든 레코드는 무덤에 없어야 함');
});

scenario('황금 방패: 남의 방패 id, 방패가 아닌 카드, 다른 방 코드로는 막을 수 없다', { card: '황금 방패', rule: RULE_ORDINARY }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정'], 1: ['시선', '십자가#201'], 2: ['황금 방패'] }, eventTimeoutMs: 120000 });
  await attack(g, 0, '성정', 1);
  const othersShield = g.cardId(2, '황금 방패');
  g.c(1).act('play_shield', othersShield);
  g.c(1).act('play_shield', g.cardId(1, '시선'));
  g.c(1).act('play_shield', g.cardId(1, '십자가'));
  g.c(1).raw('play_shield', 'NO_SUCH_ROOM', othersShield);
  g.c(1).act('play_shield');
  await barrier(g, 1);
  t.expectEq(g.room.phase, 'WAITING_FOR_DEFENSE', '방어 단계 유지');
  t.expectEq(g.hand(2), ['황금 방패'], '2번 방패는 그대로');
  t.expectEq(g.hand(1).sort(), ['시선', '십자가'].sort(), '1번 패 그대로');
  t.expectEq(g.room.graveyard.filter((c) => c.name !== '성정').length, 0, '무덤에는 성정만');
  g.c(1).act('skip_defense');
  await g.waitFor(() => !g.p(1).isAlive, '1번 사망');
});

scenario('황금 방패: 엑스칼리버 공격은 막을 수 없다', { card: '황금 방패', rule: RULE_EXCALIBUR }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['황금 방패'] }, eventTimeoutMs: 120000 });
  g.room.addCardToHand(g.p(0), makeSyntheticWeapon('엑스칼리버'));
  g.tracker.rebaseline();
  g.broadcast();
  await attack(g, 0, '엑스칼리버', 1);
  shield(g, 1, '황금 방패');
  await barrier(g, 1);
  t.expectEq(g.room.phase, 'WAITING_FOR_DEFENSE', '방패가 거부되어 방어 단계 유지');
  t.expectEq(g.hand(1), ['황금 방패'], '거부된 방패는 소모되지 않음');
  g.c(1).act('skip_defense');
  await g.waitFor(() => !g.p(1).isAlive, '1번 사망');
});

scenario('황금 방패: 방패를 쥐고 있어도 제한시간 안에 내지 않으면 죽는다', { card: '황금 방패', rule: RULE_ORDINARY + ' (자동 사용 없음)' }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정'], 1: ['황금 방패'] } });
  await attack(g, 0, '성정', 1);
  await g.waitServerMs(30000);
  await g.waitFor(() => !g.p(1).isAlive, '시간 초과로 1번 사망');
  await g.waitPhase('MAIN');
  t.expectEq(g.room.currentTurnPlayerId, g.c(0).id, '차례는 0번 유지');
});

scenario('황금 방패: 방어 대기 중 턴 제한시간이 지나도 방어가 끝나면 턴 타이머가 다시 돈다', {
  card: '황금 방패',
  rule: RULE_ORDINARY + ' (방어 단계가 끝나면 차례 주인의 턴 타이머가 살아 있어야 함 — 잠수 시 게임 정지 방지)',
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정'], 1: ['황금 방패'] }, eventTimeoutMs: 120000 });
  // 턴 제한시간을 서버 기준 4초(실제 200ms)로 줄여 방어 대기 중에 만료되게 함
  (g.room as any).startTurnTimer(4000);
  await attack(g, 0, '성정', 1);
  await t.sleep(400); // 방어 대기 중 턴 타이머 만료
  t.expectEq(g.room.phase, 'WAITING_FOR_DEFENSE', '방어 대기 중');
  shield(g, 1, '황금 방패');
  await g.waitPhase('MAIN');
  await g.settle();
  const timerAlive = isTimerPending(g.room.turnTimer) && !g.room.isTurnTimerPaused;
  t.expect(timerAlive, `방어 종료 후 MAIN인데 턴 타이머가 없음 (paused=${g.room.isTurnTimerPaused}, timer=${isTimerPending(g.room.turnTimer)}) — 0번이 잠수하면 영원히 멈춤`);
  // 남은 시간이 지나면 차례가 넘어가야 함
  await g.waitFor(() => g.room.currentTurnPlayerId === g.c(1).id, '턴 시간 초과로 1번 차례', 1500);
});

// ── 침묵과 방패 ──

scenario('황금 방패: 침묵에 걸린 생존자는 방패를 낼 수 없다 (화살 함정)', { card: '황금 방패', rule: RULE_SILENCE }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정', '황금 방패'], 1: ['침묵'] }, deck: ['화살 함정'], eventTimeoutMs: 120000 });
  await attack(g, 0, '성정', 1);
  g.c(1).act('interrupt_action', g.cardId(1, '침묵'), g.c(0).id);
  await g.waitFor(() => g.room.phase === 'MAIN' && g.p(0).isSilenced, '0번 침묵, 공격 취소');
  await drawEvent(g, '화살 함정');
  await waitTarget(g, 0, '화살 함정 방어 단계');
  shield(g, 0, '황금 방패');
  await barrier(g, 0);
  t.expectEq(g.room.phase, 'WAITING_FOR_DEFENSE', '침묵 상태의 방패는 거부되어야 함');
  t.expectEq(g.hand(0), ['황금 방패'], '방패가 소모되면 안 됨');
  g.c(0).act('skip_defense');
  await g.waitFor(() => !g.p(0).isAlive, '0번 화살 함정으로 사망');
  await g.waitPhase('MAIN');
  t.expectEq(g.room.currentTurnPlayerId, g.c(1).id, '차례는 1번으로');
});

scenario('황금 방패: 침묵으로 지목당한 피격자는 방패를 낼 수 없다', { card: '황금 방패', rule: RULE_SILENCE }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정'], 1: ['황금 방패'], 2: ['침묵'] }, eventTimeoutMs: 120000 });
  await attack(g, 0, '성정', 1);
  g.c(2).act('interrupt_action', g.cardId(2, '침묵'), g.c(1).id);
  await barrier(g, 2);
  t.note(`침묵 후: 0번 침묵=${g.p(0).isSilenced}, 1번 침묵=${g.p(1).isSilenced}, 단계=${g.room.phase}`);
  t.expect(g.p(1).isSilenced, `침묵으로 지목한 1번(피격자)이 침묵 상태여야 함 — 실제: 0번 침묵=${g.p(0).isSilenced}, 1번 침묵=${g.p(1).isSilenced}`);
  t.expectEq(g.room.phase, 'WAITING_FOR_DEFENSE', '0번의 공격은 계속되어야 함');
  shield(g, 1, '황금 방패');
  await barrier(g, 1);
  t.expectEq(g.hand(1), ['황금 방패'], '침묵 상태의 방패는 거부');
  g.c(1).act('skip_defense');
  await g.waitFor(() => !g.p(1).isAlive, '1번 사망');
});

// ══════════════════════════════════════════════════════════════════
// 수호천사
// ══════════════════════════════════════════════════════════════════

scenario('수호천사: 공격받은 본인도 사용해 막을 수 있다', { card: '수호천사', rule: RULE_ANGEL }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정'], 1: ['수호천사'] } });
  await attack(g, 0, '성정', 1);
  shield(g, 1, '수호천사');
  await g.waitPhase('MAIN');
  t.expect(g.p(1).isAlive, '1번 생존');
  t.expectEq(g.hand(1), [], '수호천사 소모');
  t.expect(inGrave(g, '수호천사'), '수호천사는 무덤으로');
});

scenario('수호천사: 제3자가 공격받는 생존자를 대신 막아준다', { card: '수호천사', rule: RULE_ANGEL }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정'], 1: ['코인'], 2: ['수호천사'] } });
  await attack(g, 0, '성정', 1);
  shield(g, 2, '수호천사');
  await g.waitPhase('MAIN');
  t.expect(g.p(1).isAlive, '1번 생존');
  t.expect(g.p(2).isAlive, '2번 생존');
  t.expectEq(g.hand(2), [], '2번의 수호천사 소모');
  t.expectEq(g.hand(1), ['코인'], '1번 패 그대로');
  t.expect(inGrave(g, '수호천사'), '수호천사는 무덤으로');
});

scenario('수호천사: 피격자가 방어를 포기한 뒤에도 보유자가 개입해 살릴 수 있다', { card: '수호천사', rule: RULE_ANGEL }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정'], 2: ['수호천사'] }, eventTimeoutMs: 120000 });
  await attack(g, 0, '성정', 1);
  g.c(1).act('skip_defense');
  await barrier(g, 1);
  t.expectEq(g.room.phase, 'WAITING_FOR_DEFENSE', '수호천사 보유자의 결정을 기다려야 함');
  t.expect(g.p(1).isAlive, '아직 1번 생존');
  shield(g, 2, '수호천사');
  await g.waitPhase('MAIN');
  t.expect(g.p(1).isAlive, '수호천사 개입으로 1번 생존');
});

scenario('수호천사: 피격자가 포기해도 모든 수호천사 보유자가 포기할 때까지 피해가 확정되지 않는다', { card: '수호천사', rule: RULE_ANGEL }, async (t) => {
  const g = await t.game({ players: 4, hands: { 0: ['성정'], 2: ['수호천사'], 3: ['수호천사'] }, eventTimeoutMs: 120000 });
  await attack(g, 0, '성정', 1);
  g.c(1).act('skip_defense');
  await barrier(g, 1);
  t.expect(g.p(1).isAlive && g.room.phase === 'WAITING_FOR_DEFENSE', '1번 포기 후에도 대기');
  g.c(2).act('skip_defense');
  await barrier(g, 2);
  t.expect(g.p(1).isAlive && g.room.phase === 'WAITING_FOR_DEFENSE', '2번 포기 후에도 3번을 대기');
  g.c(3).act('skip_defense');
  await g.waitFor(() => !g.p(1).isAlive, '모두 포기 → 1번 즉시 사망', 1000);
  await g.waitPhase('MAIN');
  t.expectEq(g.hand(2), ['수호천사'], '포기한 보유자의 수호천사는 그대로');
});

scenario('수호천사: 보유자가 먼저 포기해도 피격자가 결정하기 전에는 피해가 확정되지 않는다', { card: '수호천사', rule: RULE_ANGEL + ' / ' + RULE_ORDINARY }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정'], 1: ['황금 방패'], 2: ['수호천사'] }, eventTimeoutMs: 120000 });
  await attack(g, 0, '성정', 1);
  g.c(2).act('skip_defense');
  await barrier(g, 2);
  t.expect(g.p(1).isAlive && g.room.phase === 'WAITING_FOR_DEFENSE', '피격자 결정 대기');
  shield(g, 1, '황금 방패');
  await g.waitPhase('MAIN');
  t.expect(g.p(1).isAlive, '1번 생존');
  t.expectEq(g.hand(2), ['수호천사'], '2번 수호천사 그대로');
});

scenario('수호천사: 보유자가 응답하지 않으면 제한시간 후 피격자가 죽는다', { card: '수호천사', rule: RULE_ANGEL }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정'], 2: ['수호천사'] } });
  await attack(g, 0, '성정', 1);
  g.c(1).act('skip_defense');
  await barrier(g, 1);
  t.expect(g.p(1).isAlive, '보유자 대기 중');
  await g.waitServerMs(30000);
  await g.waitFor(() => !g.p(1).isAlive, '시간 초과 후 1번 사망');
  await g.waitPhase('MAIN');
});

scenario('수호천사: 죽은 생존자의 수호천사로는 개입할 수 없고, 그를 기다리지도 않는다', { card: '수호천사', rule: RULE_ANGEL + ' (생존자만 개입 가능)' }, async (t) => {
  const g = await t.game({ players: 4, dead: [3], hands: { 0: ['성정'], 3: ['수호천사'] }, eventTimeoutMs: 120000 });
  await attack(g, 0, '성정', 1);
  shield(g, 3, '수호천사');
  await barrier(g, 3);
  t.expectEq(g.room.phase, 'WAITING_FOR_DEFENSE', '죽은 자의 수호천사는 거부');
  t.expectEq(g.hand(3), ['수호천사'], '죽은 자의 패 그대로');
  g.c(1).act('skip_defense');
  await g.waitFor(() => !g.p(1).isAlive, '죽은 보유자를 기다리지 않고 1번 즉시 사망', 1000);
});

scenario('수호천사: 공격자는 자신의 수호천사로 자기가 공격한 대상을 막아줄 수 없다', { card: '수호천사', rule: RULE_BLOODY_2 + ' (일반 무기 공격에도 동일 적용)' }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정', '수호천사'] }, eventTimeoutMs: 120000 });
  await attack(g, 0, '성정', 1);
  shield(g, 0, '수호천사');
  await barrier(g, 0);
  t.expectEq(g.room.phase, 'WAITING_FOR_DEFENSE', '공격자의 수호천사는 거부');
  t.expectEq(g.hand(0), ['수호천사'], '공격자의 수호천사는 소모되지 않음');
  g.c(1).act('skip_defense');
  await g.waitFor(() => !g.p(1).isAlive, '공격자 보유분은 기다리지 않고 1번 즉시 사망', 1000);
});

scenario('수호천사: 피바라기를 뽑은 생존자는 자신의 수호천사로 피바라기 대상을 막아줄 수 없다', { card: '수호천사', rule: RULE_BLOODY_2 }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['수호천사'] }, deck: ['피바라기'], eventTimeoutMs: 120000 });
  await bloodyAt(g, 1);
  shield(g, 0, '수호천사');
  await barrier(g, 0);
  t.expectEq(g.room.phase, 'WAITING_FOR_DEFENSE', '피바라기 사용자의 수호천사는 거부');
  t.expectEq(g.hand(0), ['수호천사'], '수호천사 그대로');
  g.c(1).act('skip_defense');
  await g.waitFor(() => !g.p(1).isAlive, '1번 사망');
  await g.waitPhase('MAIN');
});

scenario('수호천사: 피바라기가 거울 방패로 반사되어 돌아오면 뽑은 사람이 자신의 수호천사로 막을 수 있는가', {
  card: '수호천사',
  rule: RULE_BLOODY_2 + ' / ' + RULE_ANGEL,
  ambiguous: "피바라기 [2]의 '자신을 타겟으로 한 반사를 대신 막아주기가 불가능'이, 피바라기가 거울 방패로 반사되어 뽑은 사람 본인에게 돌아왔을 때 본인의 수호천사로 막는 것을 금지하는 뜻인가요? (아니면 '자신이 지목한 대상'을 막아줄 수 없다는 뜻인가요?)",
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['수호천사'], 1: ['거울 방패'] }, deck: ['피바라기'], eventTimeoutMs: 120000 });
  await bloodyAt(g, 1);
  shield(g, 1, '거울 방패');
  await waitTarget(g, 0, '반사되어 0번이 피격 대상');
  shield(g, 0, '수호천사');
  await barrier(g, 0);
  t.note(`0번이 반사된 피바라기에 자신의 수호천사 사용 → 단계=${g.room.phase}, 0번 패=[${g.hand(0).join(', ')}], 0번 생존=${g.p(0).isAlive}`);
  if (g.room.phase === 'WAITING_FOR_DEFENSE') {
    g.c(0).act('skip_defense');
    await g.waitPhase('MAIN');
    t.note(`수호천사가 거부되어 포기 → 0번 생존=${g.p(0).isAlive}`);
  }
});

scenario('수호천사: 화살 함정을 밟은 생존자를 다른 생존자가 수호천사로 막아준다', { card: '수호천사', rule: RULE_ANGEL + ' / ' + RULE_ARROW }, async (t) => {
  const g = await t.game({ players: 3, hands: { 2: ['수호천사'] }, deck: ['화살 함정'] });
  await drawEvent(g, '화살 함정');
  await waitTarget(g, 0, '화살 함정 방어 단계');
  shield(g, 2, '수호천사');
  await g.waitPhase('MAIN');
  t.expect(g.p(0).isAlive, '0번 생존');
  t.expect(inGrave(g, '수호천사'), '수호천사는 무덤으로');
  t.expect(!g.p(0).hasDrawnThisTurn, '0번은 다시 뽑아야 함');
});

scenario('수호천사: 화살 함정은 방패 보유자가 모두 포기해야 즉시 맞는다', { card: '수호천사', rule: RULE_ARROW }, async (t) => {
  const g = await t.game({ players: 3, hands: { 2: ['수호천사'] }, deck: ['화살 함정'], eventTimeoutMs: 120000 });
  await drawEvent(g, '화살 함정');
  await waitTarget(g, 0, '화살 함정 방어 단계');
  g.c(0).act('skip_defense');
  await barrier(g, 0);
  t.expect(g.p(0).isAlive && g.room.phase === 'WAITING_FOR_DEFENSE', '2번의 결정을 기다려야 함');
  g.c(2).act('skip_defense');
  await g.waitFor(() => !g.p(0).isAlive, '0번 사망', 1000);
  await g.waitPhase('MAIN');
  t.expectEq(g.room.currentTurnPlayerId, g.c(1).id, '차례는 1번으로');
});

scenario('수호천사: 두 보유자가 동시에 개입하면 1장만 소모된다', { card: '수호천사', rule: RULE_ANGEL + ' 사용 후 버립니다.' }, async (t) => {
  const g = await t.game({ players: 4, hands: { 0: ['성정'], 2: ['수호천사'], 3: ['수호천사'] } });
  await attack(g, 0, '성정', 1);
  shield(g, 2, '수호천사');
  shield(g, 3, '수호천사');
  await g.waitPhase('MAIN');
  await barrier(g, 2);
  await barrier(g, 3);
  t.expect(g.p(1).isAlive, '1번 생존');
  t.expectEq(graveCount(g, '수호천사'), 1, '무덤의 수호천사 1장');
  t.expectEq(g.hand(2).length + g.hand(3).length, 1, '둘 중 한 명은 수호천사를 그대로 가짐');
});

scenario('수호천사: 거울 방패로 반사된 공격도 제3자가 대신 막아줄 수 있다', { card: '수호천사', rule: RULE_ANGEL + ' / ' + RULE_MIRROR }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정'], 1: ['거울 방패'], 2: ['수호천사'] } });
  await attack(g, 0, '성정', 1);
  shield(g, 1, '거울 방패');
  await waitTarget(g, 0, '반사되어 0번이 피격 대상');
  shield(g, 2, '수호천사');
  await g.waitPhase('MAIN');
  t.expect(g.p(0).isAlive && g.p(1).isAlive && g.p(2).isAlive, '모두 생존');
  t.expect(inGrave(g, '거울 방패') && inGrave(g, '수호천사'), '두 방패 모두 무덤으로');
});

scenario('수호천사: 엑스칼리버 공격은 수호천사로도 막을 수 없다', { card: '수호천사', rule: RULE_EXCALIBUR }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['수호천사'], 2: ['수호천사'] }, eventTimeoutMs: 120000 });
  g.room.addCardToHand(g.p(0), makeSyntheticWeapon('엑스칼리버'));
  g.tracker.rebaseline();
  g.broadcast();
  await attack(g, 0, '엑스칼리버', 1);
  shield(g, 2, '수호천사');
  shield(g, 1, '수호천사');
  await barrier(g, 2);
  await barrier(g, 1);
  t.expectEq(g.room.phase, 'WAITING_FOR_DEFENSE', '수호천사 거부');
  t.expectEq(g.hand(1), ['수호천사'], '1번 수호천사 그대로');
  t.expectEq(g.hand(2), ['수호천사'], '2번 수호천사 그대로');
  g.c(1).act('skip_defense');
  await barrier(g, 1);
  t.note(`엑스칼리버 공격에 피격자만 포기했을 때 즉시 확정 여부: 1번 생존=${g.p(1).isAlive}, 단계=${g.room.phase} (막을 수 없는 수호천사 보유자 2번도 포기해야 확정됨)`);
  g.c(2).act('skip_defense');
  await g.waitFor(() => !g.p(1).isAlive, '1번 사망');
});

scenario('수호천사: 폴터가이스트의 칼도 제3자가 대신 막아줄 수 있다', { card: '수호천사', rule: RULE_ANGEL + ' / [폴터가이스트] 단, 이 칼 역시 방패로 막을 수 있습니다.' }, async (t) => {
  const g = await t.game({ players: 4, dead: [3], hands: { 2: ['수호천사'] }, deck: ['폴터가이스트'] });
  await drawEvent(g, '폴터가이스트');
  await g.waitFor(() => g.requests(3, 'request_target').length > 0, '망자에게 대상 선택 요청');
  g.c(3).act('submit_target', g.c(1).id);
  await waitTarget(g, 1, '폴터가이스트 방어 단계');
  shield(g, 2, '수호천사');
  await g.waitPhase('MAIN');
  t.expect(g.p(1).isAlive, '1번 생존');
  t.expect(inGrave(g, '수호천사'), '수호천사는 무덤으로');
});

scenario('수호천사: 침묵에 걸린 생존자는 수호천사로 개입할 수 없다', { card: '수호천사', rule: RULE_SILENCE + ' / ' + RULE_ANGEL }, async (t) => {
  const g = await t.game({ players: 4, dead: [3], hands: { 0: ['성정', '수호천사'], 1: ['침묵'] }, deck: ['폴터가이스트'], eventTimeoutMs: 120000 });
  // 0번이 1번을 공격 → 1번이 침묵으로 0번을 침묵시킴
  await attack(g, 0, '성정', 1);
  g.c(1).act('interrupt_action', g.cardId(1, '침묵'), g.c(0).id);
  await g.waitFor(() => g.room.phase === 'MAIN' && g.p(0).isSilenced, '0번 침묵');
  // 같은 차례에 폴터가이스트 → 망자가 1번을 지목
  await drawEvent(g, '폴터가이스트');
  await g.waitFor(() => g.requests(3, 'request_target').length > 0, '망자에게 대상 선택 요청');
  g.c(3).act('submit_target', g.c(1).id);
  await waitTarget(g, 1, '폴터가이스트 방어 단계');
  shield(g, 0, '수호천사');
  await barrier(g, 0);
  t.expectEq(g.room.phase, 'WAITING_FOR_DEFENSE', '침묵 상태의 수호천사 거부');
  t.expectEq(g.hand(0), ['수호천사'], '수호천사 그대로');
  g.c(1).act('skip_defense');
  await barrier(g, 1);
  t.note(`피격자 포기 직후: 1번 생존=${g.p(1).isAlive}, 단계=${g.room.phase} (침묵으로 개입할 수 없는 0번의 포기를 기다리는지)`);
  if (g.p(1).isAlive) g.c(0).act('skip_defense');
  await g.waitFor(() => !g.p(1).isAlive, '1번 사망');
});

// ══════════════════════════════════════════════════════════════════
// 거울 방패
// ══════════════════════════════════════════════════════════════════

scenario('거울 방패: 공격을 공격자에게 되돌리고, 공격자가 막지 못하면 공격자가 죽는다', { card: '거울 방패', rule: RULE_MIRROR }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정'], 1: ['거울 방패'] }, eventTimeoutMs: 120000 });
  await attack(g, 0, '성정', 1);
  shield(g, 1, '거울 방패');
  await waitTarget(g, 0, '반사되어 0번이 피격 대상');
  t.expect(g.p(1).isAlive, '1번 생존');
  t.expect(inGrave(g, '거울 방패'), '거울 방패는 무덤으로');
  t.expectEq(g.hand(1), [], '1번 패에서 거울 방패 소모');
  g.c(0).act('skip_defense');
  await g.waitFor(() => !g.p(0).isAlive, '0번 사망', 1000);
  await g.waitPhase('MAIN');
  t.expect(g.p(1).isAlive, '1번은 여전히 생존');
  t.expectEq(g.room.currentTurnPlayerId, g.c(1).id, '죽은 0번의 차례는 1번으로 넘어감');
});

scenario('거울 방패: 되돌아온 공격을 원래 공격자가 방패로 막으면 둘 다 산다', { card: '거울 방패', rule: RULE_MIRROR + ' / ' + RULE_ORDINARY }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정', '황금 방패'], 1: ['거울 방패'] } });
  await attack(g, 0, '성정', 1);
  shield(g, 1, '거울 방패');
  await waitTarget(g, 0, '반사되어 0번이 피격 대상');
  shield(g, 0, '황금 방패');
  await g.waitPhase('MAIN');
  t.expect(g.p(0).isAlive && g.p(1).isAlive, '둘 다 생존');
  t.expect(inGrave(g, '성정') && inGrave(g, '거울 방패') && inGrave(g, '황금 방패'), '무기와 두 방패 모두 무덤으로');
  t.expectEq(g.room.currentTurnPlayerId, g.c(0).id, '차례는 0번 유지');
});

scenario('거울 방패: 되돌아온 공격을 원래 공격자가 자신의 수호천사로 막을 수 있다', { card: '거울 방패', rule: RULE_MIRROR + ' / ' + RULE_ANGEL }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정', '수호천사'], 1: ['거울 방패'] } });
  await attack(g, 0, '성정', 1);
  shield(g, 1, '거울 방패');
  await waitTarget(g, 0, '반사되어 0번이 피격 대상');
  shield(g, 0, '수호천사');
  await g.waitPhase('MAIN');
  t.expect(g.p(0).isAlive && g.p(1).isAlive, '둘 다 생존');
  t.expect(inGrave(g, '수호천사'), '수호천사는 무덤으로');
});

scenario('거울 방패: 거울 방패끼리 주고받으면 마지막으로 막지 못한 쪽이 죽는다', { card: '거울 방패', rule: RULE_MIRROR }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정', '거울 방패'], 1: ['거울 방패', '거울 방패'] }, eventTimeoutMs: 120000 });
  await attack(g, 0, '성정', 1);
  shield(g, 1, '거울 방패');
  await waitTarget(g, 0, '1차 반사 → 0번');
  shield(g, 0, '거울 방패');
  await waitTarget(g, 1, '2차 반사 → 1번');
  t.expectEq(pendingInitiator(g), 0, '2차 반사의 공격자는 0번');
  shield(g, 1, '거울 방패');
  await waitTarget(g, 0, '3차 반사 → 0번');
  g.c(0).act('skip_defense');
  await g.waitFor(() => !g.p(0).isAlive, '0번 사망', 1000);
  await g.waitPhase('MAIN');
  t.expect(g.p(1).isAlive, '1번 생존');
  t.expectEq(graveCount(g, '거울 방패'), 3, '거울 방패 3장 모두 무덤으로');
});

scenario('거울 방패: 되돌아온 공격에 응답하지 않으면 제한시간 후 원래 공격자가 죽는다', { card: '거울 방패', rule: RULE_MIRROR }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정', '황금 방패'], 1: ['거울 방패'] } });
  await attack(g, 0, '성정', 1);
  shield(g, 1, '거울 방패');
  await waitTarget(g, 0, '반사되어 0번이 피격 대상');
  await g.waitServerMs(30000);
  await g.waitFor(() => !g.p(0).isAlive, '시간 초과로 0번 사망');
  await g.waitPhase('MAIN');
  t.expect(g.p(1).isAlive, '1번 생존');
});

scenario('거울 방패: 공격받지 않은 제3자는 거울 방패를 쓸 수 없다', { card: '거울 방패', rule: RULE_MIRROR }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정'], 2: ['거울 방패'] }, eventTimeoutMs: 120000 });
  await attack(g, 0, '성정', 1);
  shield(g, 2, '거울 방패');
  await barrier(g, 2);
  t.expectEq(pendingTarget(g), 1, '피격 대상은 여전히 1번');
  t.expectEq(g.hand(2), ['거울 방패'], '2번 거울 방패 그대로');
  g.c(1).act('skip_defense');
  await g.waitFor(() => !g.p(1).isAlive, '1번 사망');
  t.expect(g.p(0).isAlive, '0번 생존');
});

scenario('거울 방패: 필멸의 창은 원래 공격자가 아니라 창을 넘긴 직전 생존자에게 반사된다', { card: '거울 방패', rule: RULE_MIRROR_SPEAR }, async (t) => {
  const g = await t.game({ players: 4, hands: { 0: ['필멸의 창'], 1: ['황금 방패'], 2: ['거울 방패'] }, eventTimeoutMs: 120000 });
  await attack(g, 0, '필멸의 창', 1);
  shield(g, 1, '황금 방패');
  await waitTarget(g, 2, '창이 1번 오른쪽(2번)으로');
  shield(g, 2, '거울 방패');
  await g.waitFor(() => pendingTarget(g) !== 2 || g.room.phase !== 'WAITING_FOR_DEFENSE', '반사');
  t.expectEq(pendingTarget(g), 1, '창을 넘긴 1번에게 반사되어야 함 (원래 공격자 0번이 아님)');
  g.c(1).act('skip_defense');
  await g.waitFor(() => !g.p(1).isAlive, '1번 사망');
  await g.waitPhase('MAIN');
  t.expect(g.p(0).isAlive && g.p(2).isAlive && g.p(3).isAlive, '나머지는 생존');
});

scenario('거울 방패: 필멸의 창 첫 공격을 반사하면 던진 사람에게 돌아간다', { card: '거울 방패', rule: RULE_MIRROR_SPEAR }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['필멸의 창'], 1: ['거울 방패'] }, eventTimeoutMs: 120000 });
  await attack(g, 0, '필멸의 창', 1);
  shield(g, 1, '거울 방패');
  await waitTarget(g, 0, '0번에게 반사');
  g.c(0).act('skip_defense');
  await g.waitFor(() => !g.p(0).isAlive, '0번 사망');
  await g.waitPhase('MAIN');
  t.expect(g.p(1).isAlive && g.p(2).isAlive, '1, 2번 생존');
});

scenario('거울 방패: 피바라기를 반사하면 피바라기를 뽑은 생존자가 공격받는다', { card: '거울 방패', rule: RULE_MIRROR }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['거울 방패'] }, deck: ['피바라기'], eventTimeoutMs: 120000 });
  await bloodyAt(g, 1);
  shield(g, 1, '거울 방패');
  await waitTarget(g, 0, '0번에게 반사');
  g.c(0).act('skip_defense');
  await g.waitFor(() => !g.p(0).isAlive, '0번 사망', 1000);
  await g.waitPhase('MAIN');
  t.expect(g.p(1).isAlive, '1번 생존');
  t.expectEq(g.room.currentTurnPlayerId, g.c(1).id, '차례는 1번으로');
});

scenario('거울 방패: 화살 함정은 공격자가 없으므로 방패로서 막기만 한다', { card: '거울 방패', rule: RULE_ARROW + ' / ' + RULE_MIRROR }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['거울 방패'] }, deck: ['화살 함정'] });
  await drawEvent(g, '화살 함정');
  await waitTarget(g, 0, '화살 함정 방어 단계');
  shield(g, 0, '거울 방패');
  await g.waitPhase('MAIN');
  t.expect(g.p(0).isAlive && g.p(1).isAlive && g.p(2).isAlive, '아무도 죽지 않음');
  t.expect(inGrave(g, '거울 방패'), '거울 방패는 무덤으로');
  t.expect(!g.p(0).hasDrawnThisTurn, '0번은 다시 뽑아야 함');
});

scenario('거울 방패: 화살 함정은 다른 생존자가 거울 방패로 대신 막아줄 수 있다', { card: '거울 방패', rule: RULE_ARROW }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['거울 방패'] }, deck: ['화살 함정'] });
  await drawEvent(g, '화살 함정');
  await waitTarget(g, 0, '화살 함정 방어 단계');
  shield(g, 1, '거울 방패');
  await g.waitPhase('MAIN');
  t.expect(g.p(0).isAlive && g.p(1).isAlive && g.p(2).isAlive, '아무도 죽지 않음');
  t.expect(inGrave(g, '거울 방패'), '거울 방패는 무덤으로');
});

scenario('거울 방패: 폴터가이스트(죽은 자들의 칼)를 막으면 아무도 죽지 않는다', { card: '거울 방패', rule: RULE_MIRROR + ' / [폴터가이스트] 단, 이 칼 역시 방패로 막을 수 있습니다.' }, async (t) => {
  const g = await t.game({ players: 4, dead: [3], hands: { 1: ['거울 방패'] }, deck: ['폴터가이스트'] });
  await drawEvent(g, '폴터가이스트');
  await g.waitFor(() => g.requests(3, 'request_target').length > 0, '망자에게 대상 선택 요청');
  g.c(3).act('submit_target', g.c(1).id);
  await waitTarget(g, 1, '폴터가이스트 방어 단계');
  shield(g, 1, '거울 방패');
  await g.waitPhase('MAIN');
  t.expect(g.p(0).isAlive && g.p(1).isAlive && g.p(2).isAlive, '살아 있던 생존자는 모두 생존');
  t.expect(inGrave(g, '거울 방패'), '거울 방패는 무덤으로');
  t.expect(!g.p(0).hasDrawnThisTurn, '0번은 다시 뽑아야 함');
});

scenario('거울 방패: 룰렛에서 뽑힌 칼(공격자 없음)을 막으면 아무도 죽지 않는다', { card: '거울 방패', rule: RULE_MIRROR + ' / [룰렛] 무기를 가지게 된 자는 방패로 막지 못하면 죽습니다.' }, async (t) => {
  const g = await t.game({
    players: 3,
    hands: { 0: ['성정', '거울 방패'], 1: ['코인', '거울 방패'], 2: ['코인', '거울 방패'] },
    deck: ['룰렛'],
    eventTimeoutMs: 120000,
  });
  await drawEvent(g, '룰렛');
  await g.waitFor(() => g.requests(0, 'request_cards').length > 0, '룰렛 제출 요청');
  g.c(0).act('submit_cards', [g.cardId(0, '성정')]);
  g.c(1).act('submit_cards', [g.cardId(1, '코인')]);
  g.c(2).act('submit_cards', [g.cardId(2, '코인')]);
  await g.waitPhase('WAITING_FOR_DEFENSE');
  const victim = pendingTarget(g);
  t.note(`룰렛으로 칼을 받은 사람: ${victim}번`);
  t.expect(victim >= 0, '피격 대상이 있어야 함');
  shield(g, victim, '거울 방패');
  await g.waitPhase('MAIN');
  t.expect(g.p(0).isAlive && g.p(1).isAlive && g.p(2).isAlive, '아무도 죽지 않음');
  t.expectEq(graveCount(g, '거울 방패'), 1, '사용한 거울 방패 1장만 무덤으로');
});

scenario('거울 방패: 엑스칼리버 공격은 반사할 수 없다', { card: '거울 방패', rule: RULE_EXCALIBUR }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['거울 방패'] }, eventTimeoutMs: 120000 });
  g.room.addCardToHand(g.p(0), makeSyntheticWeapon('엑스칼리버'));
  g.tracker.rebaseline();
  g.broadcast();
  await attack(g, 0, '엑스칼리버', 1);
  shield(g, 1, '거울 방패');
  await barrier(g, 1);
  t.expectEq(pendingTarget(g), 1, '반사되지 않고 1번이 계속 피격 대상');
  t.expectEq(g.hand(1), ['거울 방패'], '거울 방패 그대로');
  g.c(1).act('skip_defense');
  await g.waitFor(() => !g.p(1).isAlive, '1번 사망');
  t.expect(g.p(0).isAlive, '0번 생존');
});

scenario('거울 방패: 교화의 창 공격을 반사해 공격자가 죽으면 누구의 악의가 정화되는가', {
  card: '거울 방패',
  rule: RULE_MIRROR + ' / [교화의 창] 이 창으로 다른 생존자를 죽이는 것에 성공하면 자신의 모든 악의를 버립니다.',
  ambiguous: '교화의 창 공격을 거울 방패로 반사해 원래 공격자가 죽었을 때, 반사한 사람이 "교화의 창으로 죽이는 데 성공"한 것으로 보아 반사한 사람의 악의를 모두 버리나요, 아니면 아무의 악의도 버리지 않나요?',
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['교화의 창', '시선'], 1: ['거울 방패', '시선', '상처'] }, eventTimeoutMs: 120000 });
  await attack(g, 0, '교화의 창', 1);
  shield(g, 1, '거울 방패');
  await waitTarget(g, 0, '0번에게 반사');
  g.c(0).act('skip_defense');
  await g.waitFor(() => !g.p(0).isAlive, '0번 사망');
  await g.waitPhase('MAIN');
  t.note(`반사한 1번의 남은 악의 카드: ${g.p(1).hand.malices.length}장 (원래 2장), currentMalice=${g.p(1).currentMalice}`);
  t.note(`무덤의 악의 카드: ${g.room.graveyard.filter((c) => c.category === 'MALICE').map((c) => c.name).join(', ') || '없음'}`);
});

// ══════════════════════════════════════════════════════════════════
// 누군가의 방패
// ══════════════════════════════════════════════════════════════════

scenario('누군가의 방패: 패에 있으면 악의 1점으로 계산되고 악의 3점이면 악인이 된다', { card: '누군가의 방패', rule: RULE_SOMEONE }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['누군가의 방패'], 2: ['누군가의 방패', '시선', '상처'] } });
  t.expectEq(g.p(1).currentMalice, 1, '누군가의 방패 1장 = 악의 1점');
  t.expectEq(g.p(1).alignment, 'GOOD', '1점은 선인');
  t.expectEq(g.p(2).currentMalice, 3, '누군가의 방패 + 악의 2장 = 3점');
  t.expectEq(g.p(2).alignment, 'EVIL', '3점이면 악인');
});

scenario('누군가의 방패: 방패로 공격을 막을 수 있고, 사용하면 악의도 함께 사라진다', { card: '누군가의 방패', rule: RULE_SOMEONE + ' / ' + RULE_ORDINARY }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정'], 1: ['누군가의 방패', '시선', '상처'] } });
  t.expectEq(g.p(1).alignment, 'EVIL', '사용 전 악인');
  await attack(g, 0, '성정', 1);
  shield(g, 1, '누군가의 방패');
  await g.waitPhase('MAIN');
  t.expect(g.p(1).isAlive, '1번 생존');
  t.expect(inGrave(g, '누군가의 방패'), '누군가의 방패는 무덤으로');
  t.expectEq(g.p(1).currentMalice, 2, '악의 2점으로 감소');
  t.expectEq(g.p(1).alignment, 'GOOD', '선인으로 복귀');
});

scenario('누군가의 방패: 공격받지 않은 제3자는 대신 막을 수 없다', { card: '누군가의 방패', rule: RULE_ORDINARY }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정'], 2: ['누군가의 방패'] }, eventTimeoutMs: 120000 });
  await attack(g, 0, '성정', 1);
  shield(g, 2, '누군가의 방패');
  await barrier(g, 2);
  t.expectEq(g.room.phase, 'WAITING_FOR_DEFENSE', '방어 단계 유지');
  t.expectEq(g.hand(2), ['누군가의 방패'], '2번 방패 그대로');
  t.expectEq(g.p(2).currentMalice, 1, '2번 악의 그대로');
  g.c(1).act('skip_defense');
  await g.waitFor(() => !g.p(1).isAlive, '1번 사망');
});

scenario('누군가의 방패: 선택(善)에서 악의 1장으로 판정된다', { card: '누군가의 방패', rule: RULE_SOMEONE + ' / [선택 (善)] 지목한 생존자의 패에 악의가 있으면 뽑은 자가 죽습니다.' }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['누군가의 방패'] }, deck: ['선택 (善)'] });
  await drawEvent(g, '선택 (善)');
  await g.waitFor(() => g.requests(0, 'request_target').length > 0, '대상 선택 요청');
  g.c(0).act('submit_target', g.c(1).id);
  await g.waitFor(() => !!(g.room.pendingAction as any)?.revealedCards, '패 공개');
  for (const i of [0, 1, 2]) g.c(i).act('confirm_reveal');
  await g.waitFor(() => g.room.phase === 'MAIN', '공개 종료');
  t.expect(!g.p(0).isAlive, '1번 패에 악의(누군가의 방패)가 있으므로 0번 사망');
  t.expect(g.p(1).isAlive, '1번 생존');
});

scenario('누군가의 방패: 제물에 단독으로 낼 수 없다', { card: '누군가의 방패', rule: RULE_SOMEONE_EVENT }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['누군가의 방패'] }, deck: ['제물'], eventTimeoutMs: 120000 });
  await drawEvent(g, '제물');
  await g.waitFor(() => g.requests(1, 'request_cards').length > 0, '제물 제출 요청');
  g.c(1).act('submit_cards', [g.cardId(1, '누군가의 방패')]);
  await barrier(g, 1);
  const resp = g.room.pendingAction?.responses?.[g.c(1).id];
  t.note(`1번 제출 결과: 패=[${g.hand(1).join(', ')}], 제출 기록=${resp ? JSON.stringify((resp as any[]).map((c: any) => c.name)) : '없음'}`);
  t.expectEq(g.hand(1), ['누군가의 방패'], '단독 제출은 거부되어 패에 남아야 함');
  t.expect(!resp, '단독 제출이 제물로 기록되면 안 됨');
});

scenario('누군가의 방패: 제물에 다른 도구 카드와 섞어 내면 인정된다', { card: '누군가의 방패', rule: RULE_SOMEONE_EVENT + ' / [제물] 악의를 제외한 카드를 참가자 수만큼 바쳐야 합니다.' }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['코인'], 1: ['누군가의 방패', '황금 방패'], 2: ['코인'] }, deck: ['제물'], eventTimeoutMs: 120000 });
  await drawEvent(g, '제물');
  await g.waitFor(() => g.requests(1, 'request_cards').length > 0, '제물 제출 요청');
  g.c(1).act('submit_cards', [g.cardId(1, '누군가의 방패'), g.cardId(1, '황금 방패')]);
  await barrier(g, 1);
  t.expectEq(g.hand(1), [], '두 장 모두 제출');
  t.expectEq(g.p(1).currentMalice, 0, '제출 후 악의 0');
  g.c(0).act('submit_cards', [g.cardId(0, '코인')]);
  await g.waitPhase('MAIN');
  t.expect(g.p(0).isAlive && g.p(1).isAlive && g.p(2).isAlive, '제물 성공 — 아무도 죽지 않음');
  t.expect(inGrave(g, '누군가의 방패') && inGrave(g, '황금 방패'), '바친 카드는 무덤으로');
});

scenario('누군가의 방패: 인체 연성에 단독으로 낼 수 없다', { card: '누군가의 방패', rule: RULE_SOMEONE_EVENT }, async (t) => {
  const g = await t.game({ players: 3, dead: [2], hands: { 1: ['누군가의 방패'] }, deck: ['인체 연성'], eventTimeoutMs: 120000 });
  await drawEvent(g, '인체 연성');
  await g.waitFor(() => g.requests(1, 'request_cards').length > 0, '인체 연성 제출 요청');
  g.c(1).act('submit_cards', [g.cardId(1, '누군가의 방패')]);
  await barrier(g, 1);
  const resp = g.room.pendingAction?.responses?.[g.c(1).id] as any[] | undefined;
  t.note(`1번 제출 결과: 패=[${g.hand(1).join(', ')}], 제출 기록=${resp ? JSON.stringify(resp.map((c: any) => c.name)) : '없음'}`);
  t.expectEq(g.hand(1), ['누군가의 방패'], '단독 제출은 거부되어 패에 남아야 함');
  t.expect(!resp || resp.length === 0, '단독 제출이 제물로 기록되면 안 됨');
});

scenario('누군가의 방패: 무장해제에서 무기와 함께 내면 악의 1장으로 인정된다', { card: '누군가의 방패', rule: RULE_SOMEONE_EVENT + ' / [무장해제] 자신의 패에서 무기를 1장 버리면 자신의 악의를 1장 버릴 수 있습니다.' }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['성정', '누군가의 방패'] }, deck: ['무장해제'], eventTimeoutMs: 120000 });
  await drawEvent(g, '무장해제');
  await g.waitFor(() => g.requests(1, 'request_cards').length > 0, '무장해제 제출 요청');
  g.c(1).act('submit_cards', [g.cardId(1, '성정'), g.cardId(1, '누군가의 방패')]);
  await barrier(g, 1);
  t.expectEq(g.hand(1), [], '무기와 누군가의 방패 모두 버려짐');
  t.expectEq(g.p(1).currentMalice, 0, '악의 0');
  g.c(0).act('submit_cards', []);
  g.c(2).act('submit_cards', []);
  await g.waitPhase('MAIN');
  t.expect(inGrave(g, '성정') && inGrave(g, '누군가의 방패'), '두 장 모두 무덤으로');
});

scenario('누군가의 방패: 무장해제에 단독으로 내면 버려지지 않는다', { card: '누군가의 방패', rule: RULE_SOMEONE_EVENT }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['누군가의 방패'] }, deck: ['무장해제'], eventTimeoutMs: 120000 });
  await drawEvent(g, '무장해제');
  await g.waitFor(() => g.requests(1, 'request_cards').length > 0, '무장해제 제출 요청');
  g.c(1).act('submit_cards', [g.cardId(1, '누군가의 방패')]);
  await barrier(g, 1);
  t.expectEq(g.hand(1), ['누군가의 방패'], '단독 제출은 버려지지 않음');
  t.expectEq(g.p(1).currentMalice, 1, '악의 그대로');
});

scenario('누군가의 방패: 면죄부에서 보물과 함께 내면 악의 1장으로 인정된다', { card: '누군가의 방패', rule: RULE_SOMEONE_EVENT + ' / [면죄부] 자신의 패에서 보물 1장을 버리면 자신의 악의 1장을 버릴 수 있습니다.' }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['코인', '누군가의 방패'] }, deck: ['면죄부'], eventTimeoutMs: 120000 });
  await drawEvent(g, '면죄부');
  await g.waitFor(() => g.requests(1, 'request_cards').length > 0, '면죄부 제출 요청');
  g.c(1).act('submit_cards', [g.cardId(1, '코인'), g.cardId(1, '누군가의 방패')]);
  await barrier(g, 1);
  t.expectEq(g.hand(1), [], '보물과 누군가의 방패 모두 버려짐');
  t.expectEq(g.p(1).currentMalice, 0, '악의 0');
  g.c(0).act('submit_cards', []);
  g.c(2).act('submit_cards', []);
  await g.waitPhase('MAIN');
});

scenario('누군가의 방패: 마육검 입찰에 단독으로 낼 수 있는가', {
  card: '누군가의 방패',
  rule: RULE_SOMEONE_EVENT + ' / [마육검] 이 검을 얻고 싶은 생존자들은 동시에 악의를 공개합니다.',
  ambiguous: '마육검 경매에서 누군가의 방패 1장만 공개(제출)하는 것은 "이벤트에 제출 시 단독으로는 불가능"에 해당하나요? 아니면 악의 공개이므로 단독으로도 악의 1점 입찰로 인정되나요?',
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['누군가의 방패'] }, deck: ['마육검'], eventTimeoutMs: 120000 });
  await drawEvent(g, '마육검');
  await g.waitFor(() => g.requests(1, 'request_cards').length > 0, '마육검 입찰 요청');
  g.c(1).act('submit_cards', [g.cardId(1, '누군가의 방패')]);
  await barrier(g, 1);
  g.c(0).act('submit_cards', []);
  g.c(2).act('submit_cards', []);
  await g.waitFor(() => g.room.pendingAction?.type === 'TARGET_SELECTION' || g.room.phase === 'MAIN', '경매 종료');
  const winner = g.room.pendingAction?.type === 'TARGET_SELECTION' ? pendingInitiator(g) : -1;
  t.note(`누군가의 방패 단독 입찰 결과: 낙찰자=${winner >= 0 ? winner + '번' : '없음'}, 1번 패=[${g.hand(1).join(', ')}]`);
  if (winner >= 0) {
    g.c(winner).act('store_mayuk_sword');
    await g.waitPhase('MAIN');
  }
});

scenario('누군가의 방패: 고해성사에서 악의 1장으로 세어진다', {
  card: '누군가의 방패',
  rule: RULE_SOMEONE + ' / [고해성사] 자신의 패에서 악의 3장을 공개하면 자신의 악의 1장을 버릴 수 있습니다.',
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['누군가의 방패', '시선', '상처'] }, deck: ['고해성사'], eventTimeoutMs: 120000 });
  t.expectEq(g.p(1).currentMalice, 3, '사용 전 악의 3점');
  await drawEvent(g, '고해성사');
  // 올바른 구현이 1번에게 선택을 묻는다면 일반 악의 1장을 버리겠다고 응답
  await t.sleep(50);
  if (g.room.phase !== 'MAIN' && g.requests(1, 'request_cards').length > 0) {
    g.c(1).act('submit_cards', [g.cardId(1, '시선')]);
  }
  await g.waitPhase('MAIN');
  await g.settle();
  t.note(`고해성사 후 1번 패=[${g.hand(1).join(', ')}], 악의=${g.p(1).currentMalice}`);
  t.expectEq(g.p(1).currentMalice, 2, '누군가의 방패 + 악의 2장 = 악의 3장 공개 → 악의 1장을 버릴 수 있어야 함');
});

scenario('누군가의 방패: 보유자는 엑스칼리버를 얻을 수 없다 (악의 0장이 아님)', {
  card: '누군가의 방패',
  rule: RULE_SOMEONE + ' / [엑스칼리버] 이 검을 얻고 싶다면 악의가 0장인 채로 가장 빠르게 자신의 모든 패를 공개해야 합니다.',
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['누군가의 방패'] }, deck: ['엑스칼리버'], eventTimeoutMs: 120000 });
  await drawEvent(g, '엑스칼리버');
  await g.waitFor(() => g.requests(1, 'request_excalibur').length > 0, '엑스칼리버 요청');
  g.c(1).act('claim_excalibur');
  await barrier(g, 1);
  t.expect(!g.hand(1).includes('엑스칼리버'), '누군가의 방패(악의 1)를 가진 1번은 엑스칼리버를 얻으면 안 됨');
});

scenario('누군가의 방패: 룰렛에 이 카드 1장만 낼 수 있는가', {
  card: '누군가의 방패',
  rule: RULE_SOMEONE_EVENT + ' / [룰렛] 카드를 가진 생존자들만 참여해 자신의 패에서 원하는 카드를 1장씩 뒤집어서 냅니다.',
  ambiguous: '룰렛은 반드시 1장만 내는 이벤트인데, 누군가의 방패의 "이벤트에 제출 시 단독으로는 불가능" 규칙이 룰렛에도 적용되나요? 적용된다면 누군가의 방패만 가진 생존자는 룰렛에서 어떻게 하나요?',
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['코인'], 1: ['누군가의 방패'], 2: ['코인'] }, deck: ['룰렛'], eventTimeoutMs: 120000 });
  await drawEvent(g, '룰렛');
  await g.waitFor(() => g.requests(1, 'request_cards').length > 0, '룰렛 제출 요청');
  g.c(1).act('submit_cards', [g.cardId(1, '누군가의 방패')]);
  await barrier(g, 1);
  const resp = g.room.pendingAction?.responses?.[g.c(1).id] as any[] | undefined;
  t.note(`누군가의 방패 단독 룰렛 제출: 기록=${resp ? JSON.stringify(resp.map((c: any) => c.name)) : '없음'}, 1번 패=[${g.hand(1).join(', ')}]`);
  g.c(0).act('submit_cards', [g.cardId(0, '코인')]);
  g.c(2).act('submit_cards', [g.cardId(2, '코인')]);
  await g.waitPhase('MAIN');
  t.note(`룰렛 후 누군가의 방패 보유자: ${[0, 1, 2].filter((i) => g.hand(i).includes('누군가의 방패')).join(', ')}번`);
});

scenario('거울 방패: 마육검 즉시 공격도 마육검 주인에게 반사된다', { card: '거울 방패', rule: RULE_MIRROR }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['시선'], 2: ['거울 방패'] }, deck: ['마육검'], eventTimeoutMs: 120000 });
  await drawEvent(g, '마육검');
  await g.waitFor(() => g.requests(1, 'request_cards').length > 0, '마육검 입찰 요청');
  g.c(1).act('submit_cards', [g.cardId(1, '시선')]);
  await barrier(g, 1);
  g.c(0).act('submit_cards', []);
  g.c(2).act('submit_cards', []);
  await g.waitFor(() => g.room.pendingAction?.type === 'TARGET_SELECTION' && pendingInitiator(g) === 1, '1번 낙찰');
  g.c(1).act('use_mayuk_sword_now', g.c(2).id);
  await waitTarget(g, 2, '마육검 → 2번');
  shield(g, 2, '거울 방패');
  await waitTarget(g, 1, '1번에게 반사');
  g.c(1).act('skip_defense');
  await g.waitFor(() => !g.p(1).isAlive, '1번 사망');
  await g.waitPhase('MAIN');
  t.expect(g.p(0).isAlive && g.p(2).isAlive, '0, 2번 생존');
});

scenario('거울 방패: 2인 게임에서 반사로 공격자가 죽으면 게임이 한 번만 끝난다', { card: '거울 방패', rule: RULE_MIRROR }, async (t) => {
  const g = await t.game({ players: 2, hands: { 0: ['성정'], 1: ['거울 방패'] }, eventTimeoutMs: 120000 });
  await attack(g, 0, '성정', 1);
  shield(g, 1, '거울 방패');
  await waitTarget(g, 0, '0번에게 반사');
  g.c(0).act('skip_defense');
  await g.waitPhase('ENDED');
  await g.settle();
  t.expect(!g.p(0).isAlive && g.p(1).isAlive, '0번 사망, 1번 생존');
  t.expectEq(g.c(1).gameOvers.length, 1, 'game_over는 1번만');
  const top = g.c(1).gameOvers[0]?.[0];
  t.expectEq(top?.playerId, g.c(1).id, '1번이 1위');
});

scenario('거울 방패: 반사된 필멸의 창을 원래 공격자가 막으면 창은 그의 오른쪽으로 간다', { card: '거울 방패', rule: RULE_MIRROR_SPEAR + ' / [필멸의 창] 이 창으로 공격당한 자가 방패로 막으면 오른쪽 생존자로 향합니다.' }, async (t) => {
  const g = await t.game({ players: 4, hands: { 0: ['필멸의 창', '황금 방패'], 1: ['거울 방패'] }, eventTimeoutMs: 120000 });
  await attack(g, 0, '필멸의 창', 1);
  shield(g, 1, '거울 방패');
  await waitTarget(g, 0, '0번에게 반사');
  shield(g, 0, '황금 방패');
  await g.waitFor(() => pendingTarget(g) !== 0, '창 이동');
  t.expectEq(pendingTarget(g), 1, '0번이 막았으므로 0번 오른쪽(1번)으로');
  t.expectEq(pendingInitiator(g), 0, '창을 넘긴 사람은 0번');
  g.c(1).act('skip_defense');
  await g.waitFor(() => !g.p(1).isAlive, '1번 사망');
  await g.waitPhase('MAIN');
});

scenario('수호천사: 필멸의 창을 제3자가 대신 막으면 창은 누구의 오른쪽으로 가는가', {
  card: '수호천사',
  rule: RULE_ANGEL + ' / [필멸의 창] 이 창으로 공격당한 자가 방패로 막으면 오른쪽 생존자로 향합니다.',
  ambiguous: '필멸의 창 공격을 제3자가 수호천사로 대신 막았을 때, 창은 공격당한 사람의 오른쪽으로 가나요, 수호천사를 쓴 사람의 오른쪽으로 가나요? 그리고 다음에 거울 방패로 반사할 때 "창을 넘긴 직전 생존자"는 누구인가요?',
}, async (t) => {
  const g = await t.game({ players: 4, hands: { 0: ['필멸의 창'], 2: ['수호천사'] }, eventTimeoutMs: 120000 });
  await attack(g, 0, '필멸의 창', 1);
  shield(g, 2, '수호천사');
  await g.waitFor(() => pendingTarget(g) !== 1 || g.room.phase === 'MAIN', '창 이동');
  t.note(`2번이 1번 대신 막은 뒤: 단계=${g.room.phase}, 다음 피격=${pendingTarget(g)}번, 창을 넘긴 사람=${pendingInitiator(g)}번`);
  if (g.room.phase === 'WAITING_FOR_DEFENSE') {
    const victim = pendingTarget(g);
    g.c(victim).act('skip_defense');
    await g.waitPhase('MAIN');
    t.note(`${victim}번 포기 → 생존=${g.p(victim).isAlive}`);
  }
});

scenario('거울 방패: 반사한 순간 침묵을 맞으면 거울 방패는 패로 돌아오고 공격은 반사한 사람에게 남는다', {
  card: '거울 방패',
  rule: RULE_SILENCE + ' / ' + RULE_MIRROR,
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정', '침묵'], 1: ['거울 방패'] }, eventTimeoutMs: 120000 });
  await attack(g, 0, '성정', 1);
  shield(g, 1, '거울 방패');
  await waitTarget(g, 0, '0번에게 반사');
  // 원래 공격자 0번이 거울 방패를 낸 1번을 침묵
  g.c(0).act('interrupt_action', g.cardId(0, '침묵'), g.c(1).id);
  await barrier(g, 0);
  t.note(`침묵 후: 단계=${g.room.phase}, 피격 대상=${pendingTarget(g)}번, 1번 침묵=${g.p(1).isSilenced}, 1번 패=[${g.hand(1).join(', ')}], 무덤의 거울 방패=${graveCount(g, '거울 방패')}장`);
  t.expect(g.p(1).isSilenced, '침묵 대상 1번이 침묵 상태여야 함');
  t.expectEq(g.hand(1), ['거울 방패'], '침묵으로 무효화된 거울 방패는 1번 패로 돌아와야 함');
  t.expectEq(g.room.phase, 'WAITING_FOR_DEFENSE', '반사가 무효화되어 공격은 계속되어야 함');
  t.expectEq(pendingTarget(g), 1, '공격은 다시 1번을 향해야 함');
  shield(g, 1, '거울 방패');
  await barrier(g, 1);
  t.expectEq(g.hand(1), ['거울 방패'], '침묵 상태에서는 다시 낼 수 없음');
  g.c(1).act('skip_defense');
  await g.waitFor(() => !g.p(1).isAlive, '1번 사망');
});
