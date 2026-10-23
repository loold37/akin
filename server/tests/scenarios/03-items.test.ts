import { scenario } from '../harness/runner';
import type { GameCtx } from '../harness/game';

// 아이템 카드 7종: 독재, 침묵, 인연의 끈, 긴급탈출키트, 선의, 스캐빈져, 인간 방패
// 규칙(card.json)대로라면 일어나야 하는 일을 단언합니다. 실패 = 현재 구현이 규칙과 다름.

// ── 공통 도우미 ─────────────────────────────────────────────────────

const RULE = {
  독재: '이 카드를 사용하면 생존자 회 시 절대적인 권한을 갖습니다. / 이벤트 카드 텍스트에 \'생존자 회의\'라는 단어가 정확히 명시되어 있는 카드(천사의 심판대, 악마의 고해소, 미끼 등)에서만 사용 가능합니다.',
  침묵: '한 생존자를 선택해 이번 차례에 도구를 못 내게 합니다. 도구를 낸 순간도 침묵이 가능하며 차례와 관계없이 사용 가능합니다. / 침묵에 걸린 상대방은 이번 차례에 앞서 냈던 도구(방패 등)를 다시 패로 회수해야 하며 해당 카드의 효과는 무효화됩니다. 이벤트 진행 중 제출해야 하는 도구 역시 낼 수 없게 됩니다.',
  인연: '이 카드를 차례 중 사용하면 두 생존자를 한쪽이 죽을 시 같이 죽는 인연으로 만듭니다. 단 아무 생존자나 언제든 무기로 인연을 끊을 수 있습니다.',
  키트: '이 카드를 사용하면 이벤트를 한 개 취소합니다. 자신의 차례가 아니거나 이벤트가 진행 중 일지라도 사용 가능합니다. / 즉시 발동하여 현재 진행 중인 이벤트의 효과를 완전히 무효화합니다.',
  선의: '이 카드를 지니고 있다면 악의를 1장 줄여 계산합니다. / (단, 이 카드만으로 악의 판정을 유리하게 우회하여 이벤트를 회피할 수는 없음)',
  스캐빈져: '이 카드를 사용하면 다른 생존자가 죽을 때 그자의 패를 모두 가져옵니다. 차례와 관계없이 다른 생존자가 죽는 그 순간만 사용 가능합니다.',
  인간방패: '이 카드를 사용하면 다른 생존자를 방패로 사용해 희생시킵니다. 단 방패로 선택된 자도 방패를 사용해 공격을 막을 수 있습니다. / 자신을 공격한 최초 공격 당사자 본인을 인간 방패로 지정하여 역으로 막아내는 것은 불가능합니다.',
};

const grave = (g: GameCtx): string[] => g.room.graveyard.map((c) => c.name);
const pending = (g: GameCtx): any => g.room.pendingAction as any;

/** i번이 카드를 뽑아 eventName 이벤트를 발동시키고, 이벤트가 무덤에 들어갈 때까지 기다립니다. */
async function drawEvent(g: GameCtx, i: number, eventName: string): Promise<void> {
  g.c(i).act('draw_card');
  await g.waitFor(() => grave(g).includes(eventName), `${eventName} 발동`);
}

async function waitVote(g: GameCtx, label = '투표 시작'): Promise<void> {
  await g.waitFor(() => pending(g)?.type === 'VOTE', label);
}

async function waitReveal(g: GameCtx): Promise<void> {
  await g.waitFor(() => !!pending(g)?.revealedCards, '패 공개 시작');
}

function confirmAll(g: GameCtx): void {
  g.clients.forEach((c, i) => {
    if (g.p(i).isAlive) c.act('confirm_reveal');
  });
}

async function waitSettledMain(g: GameCtx, label = 'MAIN 복귀'): Promise<void> {
  await g.waitFor(() => (g.room.phase === 'MAIN' || g.room.phase === 'ENDED') && !g.room.pendingAction, label);
}

function vote(g: GameCtx, voter: number, target: number | string, dict = false): void {
  g.c(voter).act('submit_vote', typeof target === 'number' ? g.c(target).id : target, dict);
}

/** from번이 무기로 to번을 공격하고 방어 단계가 될 때까지 기다립니다. */
async function attack(g: GameCtx, from: number, to: number, weapon: string): Promise<void> {
  g.c(from).act('play_tool', g.cardId(from, weapon), g.c(to).id);
  await g.waitPhase('WAITING_FOR_DEFENSE');
}

function interrupt(g: GameCtx, who: number, item: string, target?: number): void {
  const id = g.cardId(who, item);
  if (target === undefined) g.c(who).act('interrupt_action', id);
  else g.c(who).act('interrupt_action', id, g.c(target).id);
}

// ═══════════════════════════════════════════════════════════════════
// 독재
// ═══════════════════════════════════════════════════════════════════

scenario('독재: 천사의 심판대에서 독재로 지목한 생존자가 다수결을 이긴다', { card: '독재', rule: RULE.독재 }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['독재'], 1: ['시선'], 2: ['상처'] }, deck: ['천사의 심판대'] });
  await drawEvent(g, 0, '천사의 심판대');
  await waitVote(g);
  vote(g, 0, 2, true);
  vote(g, 1, 1);
  vote(g, 2, 1);
  await waitReveal(g);
  t.expectEq(pending(g).revealedPlayerId, g.c(2).id, '독재로 지목한 다온이 심판대에 올라야 함');
  confirmAll(g);
  await waitSettledMain(g);
  t.expect(!g.p(2).isAlive, '악의를 가진 다온이 처형되어야 함');
  t.expect(g.p(1).isAlive, '다수결로 뽑힌 나래는 살아 있어야 함');
  t.expect(!g.hand(0).includes('독재'), '사용한 독재는 패에서 빠져야 함');
  t.expect(grave(g).includes('독재'), '사용한 독재는 무덤으로 가야 함');
});

scenario('독재: 악마의 고해소에서도 독재로 대상을 정한다', { card: '독재', rule: RULE.독재 }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['독재'], 1: ['시선', '상처', '흑역사'], 2: [] }, deck: ['악마의 고해소'] });
  await drawEvent(g, 0, '악마의 고해소');
  await waitVote(g);
  vote(g, 0, 2, true);
  vote(g, 1, 1);
  vote(g, 2, 1);
  await waitReveal(g);
  t.expectEq(pending(g).revealedPlayerId, g.c(2).id, '독재로 지목한 다온이 고해소에 들어가야 함');
  confirmAll(g);
  await waitSettledMain(g);
  t.expect(!g.p(2).isAlive, '악의 0장인 다온이 처형되어야 함');
  t.expect(g.p(1).isAlive, '나래는 살아 있어야 함');
  t.expect(grave(g).includes('독재'), '사용한 독재는 무덤으로 가야 함');
});

scenario('독재: 미끼 투표에서 독재로 미끼를 정한다', { card: '독재', rule: RULE.독재 }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['독재'] }, deck: ['미끼'] });
  await drawEvent(g, 0, '미끼');
  await waitVote(g);
  vote(g, 1, 2, true);
  vote(g, 0, 0);
  vote(g, 2, 0);
  await waitSettledMain(g);
  t.expect(!g.p(2).isAlive, '독재로 지목된 다온이 미끼가 되어야 함');
  t.expect(g.p(0).isAlive, '다수결로 뽑힌 가람은 살아 있어야 함');
  t.expect(grave(g).includes('독재'), '사용한 독재는 무덤으로 가야 함');
});

scenario('독재: 제물 실패 후 생존자 회의에서 독재가 적용된다', { card: '독재', rule: RULE.독재 }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['독재'] }, deck: ['제물'] });
  await drawEvent(g, 0, '제물');
  for (let i = 0; i < 3; i++) g.c(i).act('submit_cards', []);
  await waitVote(g, '제물 실패 후 생존자 회의');
  vote(g, 1, 2, true);
  vote(g, 0, 0);
  vote(g, 2, 0);
  await waitSettledMain(g);
  t.expect(!g.p(2).isAlive, '독재로 지목된 다온이 제물이 되어야 함');
  t.expect(g.p(0).isAlive, '다수결로 뽑힌 가람은 살아 있어야 함');
  t.expect(grave(g).includes('독재'), '사용한 독재는 무덤으로 가야 함');
});

scenario('독재: 구덩이(생존자 회의 아님)에서는 독재를 쓸 수 없고 카드도 남는다', {
  card: '독재',
  rule: RULE.독재 + ' / 구덩이: 투표를 진행해 한 명이라도 구출을 반대하면 구덩이에 갇혀 죽게 됩니다.',
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['독재'] }, deck: ['구덩이'] });
  await drawEvent(g, 0, '구덩이');
  await waitVote(g);
  vote(g, 1, 'SAVE', true);
  vote(g, 0, 'SAVE');
  vote(g, 2, 'DROP');
  await waitSettledMain(g);
  t.expect(!g.p(0).isAlive, '한 명이라도 반대했으므로 가람은 죽어야 함 (독재 무효)');
  t.expect(g.hand(1).includes('독재'), '구덩이에서는 독재가 소모되지 않아야 함');
});

scenario('독재: 인체 연성 부활 투표(생존자 회의 아님)에서는 독재를 쓸 수 없다', {
  card: '독재',
  rule: RULE.독재 + ' / 인체 연성: 모든 생존자가 힘을 합쳐 참가자 수만큼 악의를 제외한 카드를 버리면 죽은 자를 한 명 부활시킵니다. (\'생존자 회의\' 문구 없음)',
}, async (t) => {
  const g = await t.game({
    players: 5,
    dead: [3, 4],
    hands: { 0: ['독재', '코인'], 1: ['성배'], 2: ['복권'] },
    deck: ['인체 연성'],
  });
  await drawEvent(g, 0, '인체 연성');
  await g.waitFor(() => pending(g)?.type === 'CARD_SUBMISSION', '인체 연성 제출 단계');
  g.c(0).act('submit_cards', [g.cardId(0, '코인')]);
  g.c(1).act('submit_cards', [g.cardId(1, '성배')]);
  g.c(2).act('submit_cards', [g.cardId(2, '복권')]);
  await waitVote(g, '부활 투표 시작');
  vote(g, 0, 3, true);
  vote(g, 1, 4);
  vote(g, 2, 4);
  await waitSettledMain(g);
  t.note(`부활: 라온=${g.p(3).isAlive}, 마루=${g.p(4).isAlive} / 가람 패: ${g.hand(0).join(', ') || '없음'}`);
  t.expect(g.p(4).isAlive && !g.p(3).isAlive, '독재는 무효이므로 2표를 받은 마루가 부활해야 함');
  t.expect(g.hand(0).includes('독재'), '인체 연성에서는 독재가 소모되지 않아야 함');
});

scenario('독재: 독재 카드 없이 독재 플래그만 보내면 1표로 계산된다', { card: '독재', rule: RULE.독재 }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['시선'], 2: ['상처'] }, deck: ['천사의 심판대'] });
  await drawEvent(g, 0, '천사의 심판대');
  await waitVote(g);
  vote(g, 0, 2, true); // 독재 카드가 없는데 플래그만 켬 (조작된 클라이언트)
  vote(g, 1, 1);
  vote(g, 2, 1);
  await waitReveal(g);
  t.expectEq(pending(g).revealedPlayerId, g.c(1).id, '독재 카드가 없으므로 다수결(나래)대로 결정되어야 함');
  confirmAll(g);
  await waitSettledMain(g);
  t.expect(!g.p(1).isAlive && g.p(2).isAlive, '나래만 처형되어야 함');
});

scenario('독재: 독재를 켜지 않고 투표하면 카드가 소모되지 않는다', { card: '독재', rule: RULE.독재 }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['독재'], 1: ['시선'], 2: ['상처'] }, deck: ['천사의 심판대'] });
  await drawEvent(g, 0, '천사의 심판대');
  await waitVote(g);
  vote(g, 0, 2, false);
  vote(g, 1, 1);
  vote(g, 2, 1);
  await waitReveal(g);
  t.expectEq(pending(g).revealedPlayerId, g.c(1).id, '다수결(나래)대로 결정되어야 함');
  confirmAll(g);
  await waitSettledMain(g);
  t.expect(g.hand(0).includes('독재'), '쓰지 않은 독재는 패에 남아야 함');
});

scenario('독재: 죽은 자의 투표 때문에 독재 소지자의 투표 기회가 사라지면 안 된다', {
  card: '독재',
  rule: RULE.독재 + ' / 천사의 심판대: 생존자 회의를 통해 한 명을 결정합니다.',
}, async (t) => {
  const g = await t.game({ players: 4, dead: [3], hands: { 0: ['상처'], 1: ['시선'], 2: ['독재'] }, deck: ['천사의 심판대'] });
  await drawEvent(g, 0, '천사의 심판대');
  await waitVote(g);
  vote(g, 3, 1); // 죽은 라온의 투표 (조작된 클라이언트)
  vote(g, 0, 1);
  vote(g, 1, 1);
  await g.settle();
  t.note(`생존자 2명 + 사망자 1명 투표 후: pendingAction=${pending(g)?.type ?? '없음'}${pending(g)?.revealedCards ? '(패 공개 중)' : ''}`);
  t.expectEq(pending(g)?.type, 'VOTE', '생존자 다온이 아직 투표하지 않았으므로 회의가 계속되어야 함');
  vote(g, 2, 0, true);
  await waitReveal(g);
  t.expectEq(pending(g).revealedPlayerId, g.c(0).id, '다온의 독재로 가람이 지목되어야 함');
});

// ═══════════════════════════════════════════════════════════════════
// 침묵
// ═══════════════════════════════════════════════════════════════════

scenario('침묵: 공격받은 생존자가 침묵을 쓰면 공격이 무효가 되고 공격자는 이번 차례에 도구를 못 낸다', { card: '침묵', rule: RULE.침묵 }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정', '인연의 끈'], 1: ['침묵'] } });
  await attack(g, 0, 1, '성정');
  interrupt(g, 1, '침묵'); // UI 경로: 방어 패널에서 대상 없이 발동
  await waitSettledMain(g, '침묵으로 공격 무효');
  t.expect(g.p(1).isAlive, '나래는 살아 있어야 함');
  t.expect(g.p(0).isSilenced, '공격자 가람이 침묵 상태여야 함');
  t.expect(!g.hand(1).includes('침묵') && grave(g).includes('침묵'), '사용한 침묵은 무덤으로 가야 함');
  g.c(0).act('play_item', g.cardId(0, '인연의 끈'), [g.c(1).id, g.c(2).id]);
  await g.settle();
  t.expect(!g.room.linkedPlayers, '침묵된 가람은 이번 차례에 인연의 끈을 쓸 수 없어야 함');
  t.expect(g.hand(0).includes('인연의 끈'), '인연의 끈은 패에 남아 있어야 함');
  g.c(0).act('end_turn');
  await g.waitFor(() => g.room.currentTurnPlayerId === g.c(1).id, '차례 넘김');
  t.expect(!g.p(0).isSilenced, '차례가 넘어가면 침묵이 풀려야 함');
});

scenario('침묵: 침묵당한 공격자는 이미 낸 무기를 패로 회수한다', { card: '침묵', rule: RULE.침묵 }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정'], 1: ['침묵'] } });
  await attack(g, 0, 1, '성정');
  interrupt(g, 1, '침묵');
  await waitSettledMain(g, '침묵으로 공격 무효');
  t.note(`가람 패: ${g.hand(0).join(', ') || '없음'} / 무덤: ${grave(g).join(', ')}`);
  t.expect(g.hand(0).includes('성정'), '침묵당한 가람은 낸 무기(성정)를 패로 회수해야 함');
  t.expect(!grave(g).includes('성정'), '회수한 성정은 무덤에 있으면 안 됨');
});

scenario('침묵: 공격자가 방어자를 지정해 침묵시키면 방어자는 방패를 낼 수 없다', { card: '침묵', rule: RULE.침묵 }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정', '침묵'], 1: ['황금 방패'] } });
  await attack(g, 0, 1, '성정');
  interrupt(g, 0, '침묵', 1);
  await g.settle();
  t.note(`침묵 후: 단계=${g.room.phase}, 가람 침묵카드=${g.hand(0).includes('침묵')}, 나래 침묵상태=${g.p(1).isSilenced}`);
  t.expect(g.p(1).isSilenced, '지정한 방어자 나래가 침묵 상태여야 함');
  g.c(1).act('play_shield', g.cardId(1, '황금 방패'));
  await g.settle();
  t.expect(g.hand(1).includes('황금 방패'), '침묵된 나래는 방패를 낼 수 없어야 함');
  if (g.room.phase === 'WAITING_FOR_DEFENSE') g.c(1).act('skip_defense');
  await g.waitServerMs(30000);
  t.expect(!g.p(1).isAlive, '방패를 못 낸 나래는 공격에 맞아 죽어야 함');
});

scenario('침묵: 제3자가 방어자를 지정하면 공격자가 아니라 방어자가 침묵된다', { card: '침묵', rule: RULE.침묵 }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정'], 1: ['황금 방패'], 2: ['침묵'] } });
  await attack(g, 0, 1, '성정');
  interrupt(g, 2, '침묵', 1);
  await g.settle();
  t.note(`침묵 후: 단계=${g.room.phase}, 가람 침묵=${g.p(0).isSilenced}, 나래 침묵=${g.p(1).isSilenced}`);
  t.expect(g.p(1).isSilenced, '다온이 지정한 나래가 침묵되어야 함');
  t.expect(!g.p(0).isSilenced, '지정하지 않은 공격자 가람은 침묵되면 안 됨');
  t.expectEq(g.room.phase, 'WAITING_FOR_DEFENSE', '가람의 공격은 계속 진행 중이어야 함');
});

scenario('침묵: 공격 전(MAIN 단계)에도 차례 주인을 지정해 침묵시킬 수 있다', { card: '침묵', rule: RULE.침묵 }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정'], 1: ['침묵'] } });
  interrupt(g, 1, '침묵', 0);
  await g.settle();
  t.note(`침묵 후: 나래 침묵카드=${g.hand(1).includes('침묵')}, 가람 침묵=${g.p(0).isSilenced}`);
  t.expect(g.p(0).isSilenced, '차례와 관계없이 지정한 가람이 침묵되어야 함');
  g.c(0).act('play_tool', g.cardId(0, '성정'), g.c(2).id);
  await g.settle();
  t.expectEq(g.room.phase, 'MAIN', '침묵된 가람은 무기 공격을 할 수 없어야 함');
});

scenario('침묵: 침묵당한 생존자는 같은 차례 이벤트에서 도구를 제출할 수 없다 (무장해제)', { card: '침묵', rule: RULE.침묵 }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정', '황금칼', '시선'], 1: ['침묵'] }, deck: ['무장해제'] });
  await attack(g, 0, 1, '성정');
  interrupt(g, 1, '침묵');
  await waitSettledMain(g, '침묵으로 공격 무효');
  t.expect(g.p(0).isSilenced, '가람이 침묵 상태여야 함');
  await drawEvent(g, 0, '무장해제');
  g.c(0).act('submit_cards', [g.cardId(0, '황금칼'), g.cardId(0, '시선')]);
  await g.settle();
  t.note(`제출 후 가람 패: ${g.hand(0).join(', ') || '없음'}`);
  t.expect(g.hand(0).includes('황금칼'), '침묵된 가람은 무장해제에 무기(도구)를 낼 수 없어 황금칼이 남아야 함');
  t.expect(g.hand(0).includes('시선'), '제출이 거부되었으므로 시선도 남아야 함');
});

scenario('침묵: 침묵당한 생존자는 미끼 괴물을 무기로 처치할 수 없다', {
  card: '침묵',
  rule: RULE.침묵 + ' / 미끼: 생존자 중 한 명이 무기 1장으로 괴물을 물리치지 않는다면 ...',
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정', '황금칼'], 1: ['침묵'] }, deck: ['미끼'] });
  await attack(g, 0, 1, '성정');
  interrupt(g, 1, '침묵');
  await waitSettledMain(g, '침묵으로 공격 무효');
  t.expect(g.p(0).isSilenced, '가람이 침묵 상태여야 함');
  await drawEvent(g, 0, '미끼');
  await waitVote(g);
  g.c(0).act('kill_bait_monster', g.cardId(0, '황금칼'));
  await g.settle();
  t.note(`처치 시도 후: pendingAction=${pending(g)?.type ?? '없음'}, 가람 패=${g.hand(0).join(', ') || '없음'}`);
  t.expect(g.hand(0).includes('황금칼'), '침묵된 가람은 무기(도구)를 낼 수 없어 황금칼이 남아야 함');
  t.expectEq(pending(g)?.type, 'VOTE', '괴물이 처치되지 않았으므로 미끼 투표가 계속되어야 함');
});

scenario('침묵: 거울 방패로 반사한 생존자를 침묵시키면 거울 방패가 패로 돌아오고 반사가 무효가 된다', { card: '침묵', rule: RULE.침묵 }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정', '침묵'], 1: ['거울 방패'] } });
  await attack(g, 0, 1, '성정');
  g.c(1).act('play_shield', g.cardId(1, '거울 방패'));
  await g.waitFor(() => pending(g)?.targetId === g.c(0).id, '반사되어 가람이 방어 대상');
  interrupt(g, 0, '침묵'); // UI 경로: 반사 공격의 대상(가람)이 방어 패널에서 침묵 발동 → 반사한 나래가 침묵
  await g.settle();
  t.note(`침묵 후: 단계=${g.room.phase}, 나래 침묵=${g.p(1).isSilenced}, 나래 패=${g.hand(1).join(', ') || '없음'}, 무덤=${grave(g).join(', ')}`);
  t.expect(g.p(1).isSilenced, '반사한 나래가 침묵되어야 함');
  t.expect(g.hand(1).includes('거울 방패'), '침묵된 나래는 낸 거울 방패를 패로 회수해야 함');
  if (g.room.phase === 'WAITING_FOR_DEFENSE' && pending(g)?.targetId === g.c(1).id) g.c(1).act('skip_defense');
  await g.waitServerMs(30000);
  t.expect(g.p(0).isAlive, '반사가 무효이므로 가람은 살아 있어야 함');
  t.expect(!g.p(1).isAlive, '반사가 무효이고 침묵으로 다른 방패도 못 내므로 나래가 공격에 맞아야 함');
});

scenario('침묵: 난투 중 침묵당한 생존자는 같은 차례에 방패도 낼 수 없다', { card: '침묵', rule: RULE.침묵 }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['침묵', '황금칼'], 1: ['성정', '황금 방패'] }, deck: ['난투'] });
  g.c(0).act('draw_card');
  await g.waitFor(() => g.room.freeForAll && g.room.phase === 'MAIN', '난투 시작');
  await attack(g, 1, 0, '성정');
  interrupt(g, 0, '침묵');
  await waitSettledMain(g, '침묵으로 나래 공격 무효');
  t.expect(g.p(1).isSilenced, '나래가 침묵 상태여야 함');
  await attack(g, 0, 1, '황금칼');
  g.c(1).act('play_shield', g.cardId(1, '황금 방패'));
  await g.settle();
  t.expectEq(g.room.phase, 'WAITING_FOR_DEFENSE', '침묵된 나래의 방패는 무시되어야 함');
  g.c(1).act('skip_defense');
  await g.waitFor(() => !g.p(1).isAlive, '나래 사망');
  t.expect(g.hand(1).includes('황금 방패'), '쓰지 못한 방패는 패에 남아 있어야 함');
});

scenario('침묵: 피바라기(이벤트 공격)는 침묵으로 무효화되지 않는다', {
  card: '침묵',
  rule: RULE.침묵 + ' / 피바라기: 당신은 피를 바라는 검을 주웠습니다! 지금 이 검을 다른 생존자에게 사용해야만 합니다.',
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['침묵'] }, deck: ['피바라기'] });
  await drawEvent(g, 0, '피바라기');
  await g.waitFor(() => g.requests(0, 'request_target').length > 0, '대상 선택 요청');
  g.c(0).act('submit_target', g.c(1).id);
  await g.waitPhase('WAITING_FOR_DEFENSE');
  interrupt(g, 1, '침묵');
  await g.settle();
  t.expectEq(g.room.phase, 'WAITING_FOR_DEFENSE', '피바라기 공격은 계속되어야 함');
  t.expect(g.hand(1).includes('침묵'), '거부된 침묵은 패에 남아야 함');
});

scenario('침묵: 마육검을 얻자마자 휘두르는 공격도 침묵으로 막을 수 있나', {
  card: '침묵',
  rule: RULE.침묵 + ' / 마육검: 얻는 즉시 사용할 수 있습니다. 즉시 사용치 않으면 패에 넣고 일반 무기가 됩니다.',
  ambiguous: '마육검을 얻자마자 즉시 휘두르는 공격은 "도구를 낸 순간"으로 보아 침묵으로 무효화할 수 있나요, 아니면 피바라기처럼 이벤트 공격이라 막을 수 없나요?',
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['시선'], 1: ['침묵'] }, deck: ['마육검'] });
  await drawEvent(g, 0, '마육검');
  g.c(0).act('submit_cards', [g.cardId(0, '시선')]);
  g.c(1).act('submit_cards', []);
  g.c(2).act('submit_cards', []);
  await g.waitFor(() => g.requests(0, 'request_mayuk_choice').length > 0, '마육검 사용 선택');
  g.c(0).act('use_mayuk_sword_now', g.c(1).id);
  await g.waitPhase('WAITING_FOR_DEFENSE');
  interrupt(g, 1, '침묵');
  await g.settle();
  t.note(`침묵 시도 후: 단계=${g.room.phase}, 나래 침묵카드 보유=${g.hand(1).includes('침묵')}, 가람 침묵=${g.p(0).isSilenced}`);
  t.note(`나래가 받은 메시지: ${g.msgs(1).filter((m) => m.includes('침묵')).slice(-1)[0] ?? '-'}`);
});

scenario('침묵: 같은 차례에 먼저 쓴 인연의 끈도 회수·무효가 되나', {
  card: '침묵',
  rule: RULE.침묵,
  ambiguous: '"침묵에 걸린 상대방은 이번 차례에 앞서 냈던 도구를 다시 패로 회수"는 방금 낸 도구에만 해당하나요, 아니면 같은 차례에 먼저 사용한 인연의 끈 같은 도구도 회수되고 효과(인연)가 풀려야 하나요?',
}, async (t) => {
  const g = await t.game({ players: 4, hands: { 0: ['인연의 끈', '성정'], 1: ['침묵'] } });
  g.c(0).act('play_item', g.cardId(0, '인연의 끈'), [g.c(2).id, g.c(3).id]);
  await g.waitFor(() => !!g.room.linkedPlayers, '인연 연결');
  await attack(g, 0, 1, '성정');
  interrupt(g, 1, '침묵');
  await waitSettledMain(g);
  t.note(`침묵 후: 인연=${g.room.linkedPlayers ? '유지' : '해제'}, 가람 패=${g.hand(0).join(', ') || '없음'}`);
});

scenario('침묵: 죽은 생존자는 침묵을 쓸 수 없다', { card: '침묵', rule: RULE.침묵 }, async (t) => {
  const g = await t.game({ players: 4, dead: [3], hands: { 0: ['성정'], 3: ['침묵'] } });
  await attack(g, 0, 1, '성정');
  interrupt(g, 3, '침묵');
  await g.settle();
  t.expectEq(g.room.phase, 'WAITING_FOR_DEFENSE', '죽은 라온의 침묵은 무시되어야 함');
  t.expect(!g.p(0).isSilenced, '가람은 침묵되면 안 됨');
  t.expect(g.hand(3).includes('침묵'), '침묵 카드는 그대로 남아야 함');
});

// ═══════════════════════════════════════════════════════════════════
// 인연의 끈
// ═══════════════════════════════════════════════════════════════════

scenario('인연의 끈: 묶인 생존자가 무기로 죽으면 짝도 함께 죽는다', { card: '인연의 끈', rule: RULE.인연 }, async (t) => {
  const g = await t.game({ players: 4, hands: { 0: ['인연의 끈', '성정'] } });
  g.c(0).act('play_item', g.cardId(0, '인연의 끈'), [g.c(1).id, g.c(2).id]);
  await g.waitFor(() => !!g.room.linkedPlayers, '인연 연결');
  t.expect(!g.hand(0).includes('인연의 끈') && grave(g).includes('인연의 끈'), '사용한 인연의 끈은 무덤으로 가야 함');
  await attack(g, 0, 1, '성정');
  g.c(1).act('skip_defense');
  await waitSettledMain(g);
  t.expect(!g.p(1).isAlive, '공격받은 나래 사망');
  t.expect(!g.p(2).isAlive, '인연으로 묶인 다온도 함께 사망해야 함');
  t.expect(g.p(0).isAlive && g.p(3).isAlive, '가람과 라온은 생존');
  t.expect(!g.room.linkedPlayers, '죽은 뒤 인연은 사라져야 함');
});

scenario('인연의 끈: 이벤트(구덩이)로 죽어도 짝이 함께 죽는다', { card: '인연의 끈', rule: RULE.인연 }, async (t) => {
  const g = await t.game({ players: 4, hands: { 0: ['인연의 끈'] }, deck: ['구덩이'] });
  g.c(0).act('play_item', g.cardId(0, '인연의 끈'), [g.c(0).id, g.c(1).id]);
  await g.waitFor(() => !!g.room.linkedPlayers, '인연 연결');
  await drawEvent(g, 0, '구덩이');
  await waitVote(g);
  vote(g, 0, 'SAVE');
  vote(g, 1, 'SAVE');
  vote(g, 2, 'DROP');
  vote(g, 3, 'SAVE');
  await waitSettledMain(g);
  t.expect(!g.p(0).isAlive, '구덩이에 빠진 가람 사망');
  t.expect(!g.p(1).isAlive, '인연으로 묶인 나래도 함께 사망해야 함');
  t.expect(g.p(2).isAlive && g.p(3).isAlive, '다온, 라온 생존');
});

scenario('인연의 끈: 함께 죽어 생존자가 1명이 되면 게임이 끝난다', { card: '인연의 끈', rule: RULE.인연 }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['인연의 끈', '성정'] } });
  g.c(0).act('play_item', g.cardId(0, '인연의 끈'), [g.c(1).id, g.c(2).id]);
  await g.waitFor(() => !!g.room.linkedPlayers, '인연 연결');
  await attack(g, 0, 1, '성정');
  g.c(1).act('skip_defense');
  await g.waitPhase('ENDED');
  t.expect(!g.p(1).isAlive && !g.p(2).isAlive, '나래와 다온 모두 사망');
  await g.waitFor(() => g.c(0).gameOvers.length > 0, '게임 종료 알림');
});

scenario('인연의 끈: 자기 차례가 아니면 사용할 수 없다', { card: '인연의 끈', rule: RULE.인연 }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['인연의 끈'] } });
  g.c(1).act('play_item', g.cardId(1, '인연의 끈'), [g.c(0).id, g.c(2).id]);
  await g.settle();
  t.expect(!g.room.linkedPlayers, '차례가 아닌 나래는 인연의 끈을 쓸 수 없어야 함');
  t.expect(g.hand(1).includes('인연의 끈'), '카드는 패에 남아야 함');
});

scenario('인연의 끈: 같은 사람을 두 번·죽은 생존자를 묶을 수 없다', { card: '인연의 끈', rule: RULE.인연 }, async (t) => {
  const g = await t.game({ players: 4, dead: [3], hands: { 0: ['인연의 끈'] } });
  const id = g.cardId(0, '인연의 끈');
  g.c(0).act('play_item', id, [g.c(1).id, g.c(1).id]);
  g.c(0).act('play_item', id, [g.c(1).id, g.c(3).id]);
  g.c(0).act('play_item', id, [g.c(1).id]);
  g.c(0).act('play_item', id, null);
  await g.settle();
  t.expect(!g.room.linkedPlayers, '잘못된 대상으로는 인연이 생기면 안 됨');
  t.expect(g.hand(0).includes('인연의 끈'), '카드는 패에 남아야 함');
});

scenario('인연의 끈: 묶인 당사자는 차례와 관계없이 무기를 버려 인연을 끊는다', { card: '인연의 끈', rule: RULE.인연 }, async (t) => {
  const g = await t.game({ players: 4, hands: { 0: ['인연의 끈', '성정'], 2: ['황금칼'] } });
  g.c(0).act('play_item', g.cardId(0, '인연의 끈'), [g.c(1).id, g.c(2).id]);
  await g.waitFor(() => !!g.room.linkedPlayers, '인연 연결');
  g.c(2).act('cut_fate_link', g.cardId(2, '황금칼'));
  await g.waitFor(() => !g.room.linkedPlayers, '인연 끊김');
  t.expect(!g.hand(2).includes('황금칼') && grave(g).includes('황금칼'), '인연을 끊은 무기는 무덤으로 가야 함');
  await attack(g, 0, 1, '성정');
  g.c(1).act('skip_defense');
  await waitSettledMain(g);
  t.expect(!g.p(1).isAlive, '나래 사망');
  t.expect(g.p(2).isAlive, '인연을 끊었으므로 다온은 살아야 함');
});

scenario('인연의 끈: 묶인 생존자가 공격받는 도중에도 짝이 인연을 끊을 수 있다', { card: '인연의 끈', rule: RULE.인연 }, async (t) => {
  const g = await t.game({ players: 4, hands: { 0: ['인연의 끈', '성정'], 2: ['황금칼'] } });
  g.c(0).act('play_item', g.cardId(0, '인연의 끈'), [g.c(1).id, g.c(2).id]);
  await g.waitFor(() => !!g.room.linkedPlayers, '인연 연결');
  await attack(g, 0, 1, '성정');
  g.c(2).act('cut_fate_link', g.cardId(2, '황금칼'));
  await g.waitFor(() => !g.room.linkedPlayers, '인연 끊김');
  g.c(1).act('skip_defense');
  await waitSettledMain(g);
  t.expect(!g.p(1).isAlive, '나래 사망');
  t.expect(g.p(2).isAlive, '방어 단계 중에 인연을 끊었으므로 다온은 살아야 함');
});

scenario('인연의 끈: 묶이지 않은 생존자도 무기로 인연을 끊을 수 있다', { card: '인연의 끈', rule: RULE.인연 }, async (t) => {
  const g = await t.game({ players: 4, hands: { 0: ['인연의 끈', '성정'], 3: ['황금칼'] } });
  g.c(0).act('play_item', g.cardId(0, '인연의 끈'), [g.c(1).id, g.c(2).id]);
  await g.waitFor(() => !!g.room.linkedPlayers, '인연 연결');
  g.c(3).act('cut_fate_link', g.cardId(3, '황금칼'));
  await g.settle();
  t.note(`라온이 받은 메시지: ${g.msgs(3).slice(-1)[0] ?? '-'}`);
  t.expect(!g.room.linkedPlayers, '아무 생존자(라온)나 무기로 인연을 끊을 수 있어야 함');
  t.expect(grave(g).includes('황금칼'), '끊는 데 쓴 황금칼은 무덤으로 가야 함');
});

scenario('인연의 끈: 무기가 아닌 카드로는 인연을 끊을 수 없다', { card: '인연의 끈', rule: RULE.인연 }, async (t) => {
  const g = await t.game({ players: 4, hands: { 0: ['인연의 끈'], 1: ['황금 방패'] } });
  g.c(0).act('play_item', g.cardId(0, '인연의 끈'), [g.c(1).id, g.c(2).id]);
  await g.waitFor(() => !!g.room.linkedPlayers, '인연 연결');
  g.c(1).act('cut_fate_link', g.cardId(1, '황금 방패'));
  await g.settle();
  t.expect(!!g.room.linkedPlayers, '방패로는 인연을 끊을 수 없어야 함');
  t.expect(g.hand(1).includes('황금 방패'), '방패는 패에 남아야 함');
});

// ═══════════════════════════════════════════════════════════════════
// 긴급탈출키트
// ═══════════════════════════════════════════════════════════════════

scenario('긴급탈출키트: 차례가 아닌 생존자가 투표 중인 천사의 심판대를 취소한다', { card: '긴급탈출키트', rule: RULE.키트 }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['시선'], 2: ['긴급탈출키트'] }, deck: ['천사의 심판대'] });
  await drawEvent(g, 0, '천사의 심판대');
  await waitVote(g);
  interrupt(g, 2, '긴급탈출키트');
  await waitSettledMain(g, '이벤트 취소');
  t.expect([0, 1, 2].every((i) => g.p(i).isAlive), '아무도 죽지 않아야 함');
  t.expect(!g.hand(2).includes('긴급탈출키트') && grave(g).includes('긴급탈출키트'), '사용한 키트는 무덤으로 가야 함');
  t.expect(!g.p(0).hasDrawnThisTurn, '이벤트를 뽑은 가람은 아직 드로우 전이어야 함');
  g.c(0).act('draw_card');
  await g.waitFor(() => g.p(0).hasDrawnThisTurn, '다시 드로우');
  await g.waitServerMs(30000);
  t.expect(g.p(1).isAlive, '취소된 심판이 나중에 실행되면 안 됨');
});

scenario('긴급탈출키트: 화살 함정(방어 대기 중)도 취소된다', { card: '긴급탈출키트', rule: RULE.키트 }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['긴급탈출키트'] }, deck: ['화살 함정'] });
  await drawEvent(g, 0, '화살 함정');
  await g.waitPhase('WAITING_FOR_DEFENSE');
  interrupt(g, 0, '긴급탈출키트');
  await waitSettledMain(g, '이벤트 취소');
  await g.waitServerMs(30000);
  t.expect(g.p(0).isAlive, '화살 함정이 취소되어 가람은 살아야 함');
  t.expect(grave(g).includes('긴급탈출키트'), '사용한 키트는 무덤으로 가야 함');
});

scenario('긴급탈출키트: 피바라기 방어 단계에서도 이벤트로서 취소된다', {
  card: '긴급탈출키트',
  rule: RULE.키트 + ' / 피바라기는 이벤트 카드입니다.',
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['긴급탈출키트'] }, deck: ['피바라기'] });
  await drawEvent(g, 0, '피바라기');
  await g.waitFor(() => g.requests(0, 'request_target').length > 0, '대상 선택 요청');
  g.c(0).act('submit_target', g.c(1).id);
  await g.waitPhase('WAITING_FOR_DEFENSE');
  interrupt(g, 1, '긴급탈출키트');
  await waitSettledMain(g, '이벤트 취소');
  await g.waitServerMs(30000);
  t.expect(g.p(1).isAlive, '피바라기가 취소되어 나래는 살아야 함');
});

scenario('긴급탈출키트: 무기 공격은 취소할 수 없다', { card: '긴급탈출키트', rule: RULE.키트 + ' (이벤트가 아닌 무기 공격은 대상이 아님)' }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정'], 1: ['긴급탈출키트'] } });
  await attack(g, 0, 1, '성정');
  interrupt(g, 1, '긴급탈출키트');
  await g.settle();
  t.expectEq(g.room.phase, 'WAITING_FOR_DEFENSE', '무기 공격은 계속되어야 함');
  t.expect(g.hand(1).includes('긴급탈출키트'), '거부된 키트는 패에 남아야 함');
  g.c(1).act('skip_defense');
  await g.waitFor(() => !g.p(1).isAlive, '나래 사망');
});

scenario('긴급탈출키트: 진행 중인 이벤트가 없으면 사용할 수 없다', { card: '긴급탈출키트', rule: RULE.키트 }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['긴급탈출키트'] } });
  interrupt(g, 1, '긴급탈출키트');
  await g.settle();
  t.expect(g.hand(1).includes('긴급탈출키트'), '취소할 이벤트가 없으면 키트는 소모되지 않아야 함');
  t.expectEq(g.room.phase, 'MAIN', 'MAIN 유지');
});

scenario('긴급탈출키트: 패 공개 중 아무도 확인하기 전에 쓰면 처형이 취소된다', { card: '긴급탈출키트', rule: RULE.키트 }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['시선'], 2: ['긴급탈출키트'] }, deck: ['천사의 심판대'] });
  await drawEvent(g, 0, '천사의 심판대');
  await waitVote(g);
  for (let i = 0; i < 3; i++) vote(g, i, 1);
  await waitReveal(g);
  interrupt(g, 2, '긴급탈출키트');
  await waitSettledMain(g, '이벤트 취소');
  await g.waitServerMs(30000);
  t.expect(g.p(1).isAlive, '심판이 취소되어 나래는 살아야 함');
});

scenario('긴급탈출키트: 패 공개를 누군가 확인한 뒤에 써도 이벤트가 취소된다', { card: '긴급탈출키트', rule: RULE.키트 }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['시선'], 2: ['긴급탈출키트'] }, deck: ['천사의 심판대'] });
  await drawEvent(g, 0, '천사의 심판대');
  await waitVote(g);
  for (let i = 0; i < 3; i++) vote(g, i, 1);
  await waitReveal(g);
  g.c(0).act('confirm_reveal');
  await g.waitFor(() => pending(g)?.responses?.[g.c(0).id] === true, '가람 확인');
  interrupt(g, 2, '긴급탈출키트');
  await g.settle();
  t.note(`키트 사용 후: 단계=${g.room.phase}, pendingAction=${g.room.pendingAction ? '남아 있음' : '없음'}, 다온 키트 보유=${g.hand(2).includes('긴급탈출키트')}`);
  t.expectEq(g.room.phase, 'MAIN', '이벤트가 취소되어 MAIN으로 돌아와야 함');
  await g.waitServerMs(30000);
  t.expect(g.p(1).isAlive, '심판이 취소되어 나래는 살아야 함');
});

scenario('긴급탈출키트: 마육검 경매를 취소하면 공개한 악의가 돌아온다', { card: '긴급탈출키트', rule: RULE.키트 }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['시선'], 2: ['긴급탈출키트'] }, deck: ['마육검'] });
  await drawEvent(g, 0, '마육검');
  g.c(1).act('submit_cards', [g.cardId(1, '시선')]);
  await g.waitFor(() => !!pending(g)?.responses?.[g.c(1).id], '나래 입찰');
  interrupt(g, 2, '긴급탈출키트');
  await waitSettledMain(g, '이벤트 취소');
  t.expect(g.hand(1).includes('시선'), '입찰로 낸 시선이 나래에게 돌아와야 함');
  t.expectEq(g.p(1).currentMalice, 1, '나래 악의 1점');
  t.expect(!g.handCards(1).some((c) => c.name === '마육검'), '마육검은 누구에게도 가면 안 됨');
});

scenario('긴급탈출키트: 인체 연성 제출 중 취소하면 낸 카드가 돌아온다', { card: '긴급탈출키트', rule: RULE.키트 }, async (t) => {
  const g = await t.game({ players: 4, dead: [3], hands: { 1: ['성배'], 2: ['긴급탈출키트'] }, deck: ['인체 연성'] });
  await drawEvent(g, 0, '인체 연성');
  g.c(1).act('submit_cards', [g.cardId(1, '성배')]);
  await g.waitFor(() => !!pending(g)?.responses?.[g.c(1).id], '나래 제출');
  interrupt(g, 2, '긴급탈출키트');
  await waitSettledMain(g, '이벤트 취소');
  t.expect(g.hand(1).includes('성배'), '제출한 성배가 나래에게 돌아와야 함');
  t.expect(!g.p(3).isAlive, '부활은 일어나지 않아야 함');
});

scenario('긴급탈출키트: 제물 제출 중 취소하면 낸 카드가 돌아온다', { card: '긴급탈출키트', rule: RULE.키트 }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['성배'], 2: ['긴급탈출키트'] }, deck: ['제물'] });
  await drawEvent(g, 0, '제물');
  g.c(1).act('submit_cards', [g.cardId(1, '성배')]);
  await g.waitFor(() => !!pending(g)?.responses?.[g.c(1).id], '나래 제출');
  interrupt(g, 2, '긴급탈출키트');
  await waitSettledMain(g, '이벤트 취소');
  t.expect(g.hand(1).includes('성배'), '제출한 성배가 나래에게 돌아와야 함');
  await g.waitServerMs(30000);
  t.expect([0, 1, 2].every((i) => g.p(i).isAlive), '제물 투표가 열리면 안 됨');
});

scenario('긴급탈출키트: 무장해제 중 취소하면 이미 버린 무기·악의도 돌아오나', {
  card: '긴급탈출키트',
  rule: RULE.키트,
  ambiguous: '무장해제·면죄부처럼 제출 즉시 카드가 버려지는 이벤트를 긴급탈출키트로 취소하면, 이미 버린 무기·악의(보물·악의)도 "효과를 완전히 무효화"하여 패로 돌려줘야 하나요, 아니면 이미 처리된 사람은 그대로인가요?',
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['황금칼', '시선'], 2: ['긴급탈출키트'] }, deck: ['무장해제'] });
  await drawEvent(g, 0, '무장해제');
  g.c(1).act('submit_cards', [g.cardId(1, '황금칼'), g.cardId(1, '시선')]);
  await g.waitFor(() => !!pending(g)?.responses?.[g.c(1).id], '나래 제출');
  interrupt(g, 2, '긴급탈출키트');
  await waitSettledMain(g, '이벤트 취소');
  t.note(`취소 후 나래 패: ${g.hand(1).join(', ') || '없음'} / 무덤: ${grave(g).join(', ')}`);
  t.note('서버 코드(index.ts:935-944)는 "이미 제출된 카드가 있다면 주인에게 돌려줌"을 의도하지만, 무장해제/면죄부 응답은 카드 객체가 아니라 id 문자열 배열이라 addCardToHand가 아무 것도 하지 않음');
  t.expect(g.hand(1).includes('황금칼') && g.hand(1).includes('시선'), '무효화되었다면 버린 카드가 돌아와야 함');
});

scenario('긴급탈출키트: 무소유 분배 대기 중 취소하면 패가 그대로 남는다', { card: '긴급탈출키트', rule: RULE.키트 }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['시선', '코인'], 1: ['긴급탈출키트'] }, deck: ['무소유'] });
  g.c(0).act('draw_card');
  await g.waitFor(() => g.room.activeEvent?.name === '무소유' || grave(g).includes('무소유'), '무소유 발동', 1000);
  interrupt(g, 1, '긴급탈출키트');
  await g.settle();
  await g.waitServerMs(3000);
  t.expect(grave(g).includes('긴급탈출키트'), '키트가 사용되어야 함 (분배 3초 안)');
  t.expectEq(g.hand(0).sort(), ['시선', '코인'].sort(), '가람의 패가 분배되지 않고 남아야 함');
});

scenario('긴급탈출키트: 눈 없는 괴물처럼 MAIN으로 돌아온 지속 이벤트도 취소할 수 있나', {
  card: '긴급탈출키트',
  rule: RULE.키트,
  ambiguous: '눈 없는 괴물(침묵 모드)이나 난투처럼 MAIN 단계로 돌아온 뒤에도 효과가 남아 있는 이벤트를 긴급탈출키트로 취소할 수 있나요?',
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['긴급탈출키트'] }, deck: ['눈 없는 괴물'] });
  g.c(0).act('draw_card');
  await g.waitFor(() => g.room.silenceMode, '눈 없는 괴물 발동');
  interrupt(g, 1, '긴급탈출키트');
  await g.settle();
  t.note(`키트 사용 시도 후: silenceMode=${g.room.silenceMode}, 나래 키트 보유=${g.hand(1).includes('긴급탈출키트')}`);
  t.note(`나래가 받은 메시지: ${g.msgs(1).slice(-1)[0] ?? '-'}`);
});

scenario('긴급탈출키트: 마육검을 얻자마자 휘두르는 공격(이벤트 효과)도 취소할 수 있나', {
  card: '긴급탈출키트',
  rule: RULE.키트 + ' / 마육검(이벤트): 얻는 즉시 사용할 수 있습니다.',
  ambiguous: '마육검(또는 룰렛)처럼 이벤트 진행 중에 생긴 무기 공격의 방어 단계는 "진행 중인 이벤트"로 보아 긴급탈출키트로 취소할 수 있나요, 아니면 무기 공격이라 취소할 수 없나요?',
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['시선'], 1: ['긴급탈출키트'] }, deck: ['마육검'] });
  await drawEvent(g, 0, '마육검');
  g.c(0).act('submit_cards', [g.cardId(0, '시선')]);
  g.c(1).act('submit_cards', []);
  g.c(2).act('submit_cards', []);
  await g.waitFor(() => g.requests(0, 'request_mayuk_choice').length > 0, '마육검 사용 선택');
  g.c(0).act('use_mayuk_sword_now', g.c(1).id);
  await g.waitPhase('WAITING_FOR_DEFENSE');
  interrupt(g, 1, '긴급탈출키트');
  await g.settle();
  t.note(`키트 시도 후: 단계=${g.room.phase}, 나래 키트 보유=${g.hand(1).includes('긴급탈출키트')}`);
  t.note(`나래가 받은 메시지: ${g.msgs(1).filter((m) => m.includes('긴급탈출키트')).slice(-1)[0] ?? '-'}`);
});

scenario('긴급탈출키트: 침묵당한 생존자는 사용할 수 없다', { card: '긴급탈출키트', rule: RULE.키트 + ' / ' + RULE.침묵 }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정', '긴급탈출키트'], 1: ['침묵', '시선'] }, deck: ['천사의 심판대'] });
  await attack(g, 0, 1, '성정');
  interrupt(g, 1, '침묵');
  await waitSettledMain(g, '침묵으로 공격 무효');
  await drawEvent(g, 0, '천사의 심판대');
  await waitVote(g);
  interrupt(g, 0, '긴급탈출키트');
  await g.settle();
  t.expectEq(pending(g)?.type, 'VOTE', '침묵된 가람의 키트는 무시되어야 함');
  t.expect(g.hand(0).includes('긴급탈출키트'), '키트는 패에 남아야 함');
});

scenario('긴급탈출키트: 죽은 생존자는 사용할 수 없다', { card: '긴급탈출키트', rule: RULE.키트 }, async (t) => {
  const g = await t.game({ players: 4, dead: [3], hands: { 3: ['긴급탈출키트'] }, deck: ['천사의 심판대'] });
  await drawEvent(g, 0, '천사의 심판대');
  await waitVote(g);
  interrupt(g, 3, '긴급탈출키트');
  await g.settle();
  t.expect(pending(g)?.type === 'VOTE', '죽은 라온의 키트는 무시되고 투표가 계속되어야 함');
  t.expect(g.hand(3).includes('긴급탈출키트'), '키트는 그대로 남아야 함');
});

// ═══════════════════════════════════════════════════════════════════
// 선의
// ═══════════════════════════════════════════════════════════════════

scenario('선의: 지니고 있으면 악의를 1 줄여 계산하고, 내주면 다시 늘어난다', { card: '선의', rule: RULE.선의 }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['시선', '상처', '흑역사', '선의'], 1: ['시선'] }, deck: ['선물'] });
  t.expectEq(g.p(0).currentMalice, 2, '악의 3장 + 선의 = 2점');
  t.expectEq(g.p(0).alignment, 'GOOD', '2점이므로 선인');
  g.c(0).act('play_item', g.cardId(0, '선의'), []);
  await g.settle();
  t.expect(g.hand(0).includes('선의'), '선의는 내도 버려지지 않고 패에 남아야 함 (지속형)');
  await drawEvent(g, 0, '선물');
  await g.waitFor(() => g.requests(0, 'request_target').some((a) => a[0] === '선물'), '선물 요청');
  g.c(0).act('submit_gift', g.cardId(0, '선의'), g.c(1).id);
  await waitSettledMain(g);
  t.expectEq(g.p(0).currentMalice, 3, '선의를 내준 가람은 3점');
  t.expectEq(g.p(0).alignment, 'EVIL', '3점이므로 악인');
  t.expectEq(g.p(1).currentMalice, 0, '선의를 받은 나래는 1 - 1 = 0점');
});

scenario('선의: 천사의 심판대에서 악의 1장 + 선의여도 처형된다', { card: '선의', rule: RULE.선의 }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['시선', '선의'] }, deck: ['천사의 심판대'] });
  t.expectEq(g.p(1).currentMalice, 0, '점수상 악의 0점');
  await drawEvent(g, 0, '천사의 심판대');
  await waitVote(g);
  for (let i = 0; i < 3; i++) vote(g, i, 1);
  await waitReveal(g);
  confirmAll(g);
  await waitSettledMain(g);
  t.expect(!g.p(1).isAlive, '악의 카드 1장이 있으므로 선의가 있어도 처형되어야 함');
});

scenario('선의: 선택(善)에서 공개 대상이 악의 1장 + 선의여도 뽑은 자가 죽는다', {
  card: '선의',
  rule: RULE.선의 + ' / 선택 (善): 그중 악의가 1장이라도 있다면 이 카드를 뽑은 자는 죽습니다.',
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['시선', '선의'] }, deck: ['선택 (善)'] });
  await drawEvent(g, 0, '선택 (善)');
  await g.waitFor(() => g.requests(0, 'request_target').length > 0, '대상 선택 요청');
  g.c(0).act('submit_target', g.c(1).id);
  await waitReveal(g);
  confirmAll(g);
  await waitSettledMain(g);
  t.expect(!g.p(0).isAlive, '공개 대상에게 악의 카드가 있으므로 뽑은 가람이 죽어야 함');
  t.expect(g.p(1).isAlive, '나래는 생존');
});

scenario('선의: 누군가의 뼈 + 선의(악의 0점)로는 엑스칼리버를 얻을 수 없다', {
  card: '선의',
  rule: RULE.선의 + ' / 엑스칼리버: 이 검을 얻고 싶다면 악의가 0장인 채로 가장 빠르게 자신의 모든 패를 공개해야 합니다. / 누군가의 뼈: 이 무기는 악의인 동시에 무기입니다.',
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['누군가의 뼈', '선의'] }, deck: ['엑스칼리버'] });
  t.expectEq(g.p(1).currentMalice, 0, '점수상 악의 0점 (뼈 1 + 선의 -1)');
  await drawEvent(g, 0, '엑스칼리버');
  await g.waitFor(() => g.requests(1, 'request_excalibur').length > 0, '엑스칼리버 요청');
  g.c(1).act('claim_excalibur');
  await g.settle();
  t.note(`나래 패: ${g.hand(1).join(', ')} / 받은 메시지: ${g.msgs(1).slice(-1)[0] ?? '-'}`);
  t.expect(!g.hand(1).includes('엑스칼리버'), '악의 카드(누군가의 뼈)를 가진 채로는 선의가 있어도 엑스칼리버를 얻으면 안 됨');
});

scenario('선의: 시선 + 선의로는 엑스칼리버를 얻을 수 없다', { card: '선의', rule: RULE.선의 }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['시선', '선의'] }, deck: ['엑스칼리버'] });
  await drawEvent(g, 0, '엑스칼리버');
  await g.waitFor(() => g.requests(1, 'request_excalibur').length > 0, '엑스칼리버 요청');
  g.c(1).act('claim_excalibur');
  await g.settle();
  t.expect(!g.hand(1).includes('엑스칼리버'), '악의 카드가 있으므로 엑스칼리버를 얻으면 안 됨');
});

scenario('선의: 게임 종료 정산에서 악의 3장 + 선의는 선인으로 계산된다', { card: '선의', rule: RULE.선의 }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['시선', '상처', '흑역사', '선의'] }, deck: [], filler: 0 });
  g.c(0).act('draw_card');
  await g.waitFor(() => g.c(0).gameOvers.length > 0, '게임 종료');
  const score = g.c(0).gameOvers[0].find((s) => s.playerId === g.c(0).id);
  t.note(`가람 정산: ${JSON.stringify(score)}`);
  t.expect(!!score && score.score > 0, '선의로 악의 2점(선인)이므로 생존 탈출 점수를 받아야 함');
});

// ═══════════════════════════════════════════════════════════════════
// 스캐빈져
// ═══════════════════════════════════════════════════════════════════

scenario('스캐빈져: 다른 생존자가 죽으면 그자의 패를 모두 가져온다', { card: '스캐빈져', rule: RULE.스캐빈져 }, async (t) => {
  const g = await t.game({ players: 4, hands: { 0: ['성정'], 1: ['코인', '시선', '침묵'], 2: ['스캐빈져'] } });
  await attack(g, 0, 1, '성정');
  g.c(1).act('skip_defense');
  await g.waitFor(() => !g.p(1).isAlive, '나래 사망');
  await waitSettledMain(g);
  t.expectEq(g.hand(2).sort(), ['시선', '침묵', '코인'].sort(), '다온이 나래의 패 3장을 모두 가져와야 함');
  t.expectEq(g.hand(1), [], '나래의 패는 비어야 함');
  t.expectEq(g.p(2).currentMalice, 1, '가져온 시선으로 다온의 악의 1점');
});

scenario('스캐빈져: 사용한 스캐빈져 카드는 무덤으로 간다', { card: '스캐빈져', rule: RULE.스캐빈져 + ' (사용한 아이템은 버려짐)' }, async (t) => {
  const g = await t.game({ players: 4, hands: { 0: ['성정'], 1: ['코인'], 2: ['스캐빈져'] } });
  await attack(g, 0, 1, '성정');
  g.c(1).act('skip_defense');
  await g.waitFor(() => !g.p(1).isAlive, '나래 사망');
  await waitSettledMain(g);
  t.note(`무덤: ${grave(g).join(', ')} / 다온 패: ${g.hand(2).join(', ')}`);
  t.expect(!g.hand(2).includes('스캐빈져'), '사용한 스캐빈져는 패에서 빠져야 함');
  t.expect(grave(g).includes('스캐빈져'), '사용한 스캐빈져는 무덤으로 가야 함 (사라지면 안 됨)');
});

scenario('스캐빈져: 소지자 본인이 죽을 때는 발동하지 않는다', { card: '스캐빈져', rule: RULE.스캐빈져 }, async (t) => {
  const g = await t.game({ players: 4, hands: { 0: ['성정'], 2: ['스캐빈져', '코인'] } });
  await attack(g, 0, 2, '성정');
  g.c(2).act('skip_defense');
  await g.waitFor(() => !g.p(2).isAlive, '다온 사망');
  await waitSettledMain(g);
  t.expectEq(g.hand(2).sort(), ['스캐빈져', '코인'].sort(), '죽은 다온의 패는 그대로여야 함');
  t.expect(!grave(g).includes('스캐빈져'), '스캐빈져가 쓰이면 안 됨');
});

// 2026-10-23 확인: 스캐빈져는 소지자가 사용 여부를 고르는 카드다 (자동 발동 아님).
scenario('스캐빈져: 소지자가 사용하겠다고 하지 않으면 죽은 자의 패를 가져오지 않는다', {
  card: '스캐빈져',
  rule: RULE.스캐빈져,
}, async (t) => {
  const g = await t.game({ players: 4, hands: { 0: ['성정'], 1: ['시선', '상처', '흑역사'], 2: ['스캐빈져'] } });
  await attack(g, 0, 1, '성정');
  g.c(1).act('skip_defense');
  await g.waitFor(() => !g.p(1).isAlive, '나래 사망');
  await waitSettledMain(g);
  t.note(`다온은 아무 입력 없이 자동으로 패를 받음: ${g.hand(2).join(', ') || '없음'} (악의 ${g.p(2).currentMalice}점, ${g.p(2).alignment})`);
  t.note(`다온이 받은 요청 이벤트: ${['request_target', 'request_vote', 'request_cards'].map((e) => `${e}=${g.requests(2, e).length}`).join(', ')}`);
  t.expectEq(g.hand(2), ['스캐빈져'], '사용을 선택하지 않았으므로 다온의 패는 스캐빈져 그대로');
  t.expect(g.p(2).alignment === 'GOOD', '원치 않는 악의를 받아 악인이 되면 안 됨');
});

scenario('스캐빈져: 두 명이 가지고 있으면 누가 가져가나', {
  card: '스캐빈져',
  rule: RULE.스캐빈져,
  ambiguous: '스캐빈져를 가진 생존자가 둘 이상이면 누가 가져가나요? (먼저 사용 선언한 사람? 좌석 순? 실제 덱에는 1장뿐이라 실전에서는 드묾)',
}, async (t) => {
  const g = await t.game({ players: 4, hands: { 0: ['성정'], 1: ['스캐빈져'], 2: ['코인'], 3: ['스캐빈져'] } });
  await attack(g, 0, 2, '성정');
  g.c(2).act('skip_defense');
  await g.waitFor(() => !g.p(2).isAlive, '다온 사망');
  await waitSettledMain(g);
  t.note(`나래 패: ${g.hand(1).join(', ') || '없음'} / 라온 패: ${g.hand(3).join(', ') || '없음'} → 좌석 순으로 앞선 사람이 자동으로 가져감 (GameRoom.ts:218-225)`);
});

scenario('스캐빈져: 침묵당한 생존자는 스캐빈져를 쓸 수 없다', {
  card: '스캐빈져',
  rule: RULE.스캐빈져 + ' / 침묵: 한 생존자를 선택해 이번 차례에 도구를 못 내게 합니다.',
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정', '스캐빈져'], 1: ['침묵'], 2: ['시선', '코인'] }, deck: ['피바라기'] });
  await attack(g, 0, 1, '성정');
  interrupt(g, 1, '침묵');
  await waitSettledMain(g, '침묵으로 공격 무효');
  t.expect(g.p(0).isSilenced, '가람이 침묵 상태여야 함');
  await drawEvent(g, 0, '피바라기');
  await g.waitFor(() => g.requests(0, 'request_target').length > 0, '대상 선택 요청');
  g.c(0).act('submit_target', g.c(2).id);
  await g.waitPhase('WAITING_FOR_DEFENSE');
  g.c(2).act('skip_defense');
  await g.waitFor(() => !g.p(2).isAlive, '다온 사망');
  await waitSettledMain(g);
  t.note(`가람 패: ${g.hand(0).join(', ') || '없음'} / 다온 패: ${g.hand(2).join(', ') || '없음'}`);
  t.expect(g.hand(0).includes('스캐빈져'), '침묵된 가람은 이번 차례에 스캐빈져를 쓸 수 없어야 함');
  t.expectEq(g.hand(2).sort(), ['시선', '코인'].sort(), '다온의 패는 그대로 남아야 함');
});

scenario('스캐빈져: 인연의 끈으로 두 명이 함께 죽으면 누구의 패를 가져오나', {
  card: '스캐빈져',
  rule: RULE.스캐빈져 + ' / ' + RULE.인연,
  ambiguous: '인연의 끈으로 두 명이 동시에 죽을 때 스캐빈져 소지자는 둘 중 누구의 패를 가져오나요(직접 고르나요, 둘 다 가져오나요)? 현재는 나중에 죽은(인연으로 따라 죽은) 사람의 패를 자동으로 가져옵니다.',
}, async (t) => {
  const g = await t.game({ players: 4, hands: { 0: ['인연의 끈', '성정'], 1: ['코인'], 2: ['성배'], 3: ['스캐빈져'] } });
  g.c(0).act('play_item', g.cardId(0, '인연의 끈'), [g.c(1).id, g.c(2).id]);
  await g.waitFor(() => !!g.room.linkedPlayers, '인연 연결');
  await attack(g, 0, 1, '성정');
  g.c(1).act('skip_defense');
  await g.waitFor(() => !g.p(1).isAlive && !g.p(2).isAlive, '나래·다온 사망');
  await waitSettledMain(g);
  t.note(`라온 패: ${g.hand(3).join(', ') || '없음'} / 나래(먼저 죽음) 패: ${g.hand(1).join(', ') || '없음'} / 다온(따라 죽음) 패: ${g.hand(2).join(', ') || '없음'}`);
});

// ═══════════════════════════════════════════════════════════════════
// 인간 방패
// ═══════════════════════════════════════════════════════════════════

scenario('인간 방패: 지정된 생존자가 방어하지 않으면 대신 죽는다', { card: '인간 방패', rule: RULE.인간방패 }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정'], 1: ['인간 방패'] } });
  await attack(g, 0, 1, '성정');
  interrupt(g, 1, '인간 방패', 2);
  await g.waitFor(() => pending(g)?.targetId === g.c(2).id, '다온이 새 방어 대상');
  t.expect(!g.hand(1).includes('인간 방패') && grave(g).includes('인간 방패'), '사용한 인간 방패는 무덤으로');
  g.c(2).act('skip_defense');
  await waitSettledMain(g);
  t.expect(!g.p(2).isAlive, '인간 방패가 된 다온이 죽어야 함');
  t.expect(g.p(1).isAlive, '원래 대상 나래는 살아야 함');
});

scenario('인간 방패: 지정된 생존자는 방패로 막을 수 있다', { card: '인간 방패', rule: RULE.인간방패 }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정'], 1: ['인간 방패'], 2: ['황금 방패'] } });
  await attack(g, 0, 1, '성정');
  interrupt(g, 1, '인간 방패', 2);
  await g.waitFor(() => pending(g)?.targetId === g.c(2).id, '다온이 새 방어 대상');
  g.c(2).act('play_shield', g.cardId(2, '황금 방패'));
  await waitSettledMain(g);
  await g.waitServerMs(30000);
  t.expect(g.p(1).isAlive && g.p(2).isAlive, '방패로 막았으므로 둘 다 살아야 함');
});

scenario('인간 방패: 최초 공격자 본인은 지정할 수 없다', { card: '인간 방패', rule: RULE.인간방패 }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정'], 1: ['인간 방패'] } });
  await attack(g, 0, 1, '성정');
  interrupt(g, 1, '인간 방패', 0);
  await g.settle();
  t.expectEq(pending(g)?.targetId, g.c(1).id, '방어 대상은 그대로 나래여야 함');
  t.expect(g.hand(1).includes('인간 방패'), '거부된 인간 방패는 패에 남아야 함');
});

scenario('인간 방패: 자신·죽은 생존자는 지정할 수 없고 공격 대상만 쓸 수 있다', { card: '인간 방패', rule: RULE.인간방패 }, async (t) => {
  const g = await t.game({ players: 4, dead: [3], hands: { 0: ['성정'], 1: ['인간 방패'], 2: ['인간 방패'] } });
  await attack(g, 0, 1, '성정');
  interrupt(g, 1, '인간 방패', 1);
  interrupt(g, 1, '인간 방패', 3);
  g.c(1).act('interrupt_action', g.cardId(1, '인간 방패'));
  interrupt(g, 2, '인간 방패', 0); // 공격 대상이 아닌 다온
  await g.settle();
  t.expectEq(pending(g)?.targetId, g.c(1).id, '방어 대상은 그대로 나래여야 함');
  t.expect(g.hand(1).includes('인간 방패') && g.hand(2).includes('인간 방패'), '거부된 인간 방패는 모두 패에 남아야 함');
});

scenario('인간 방패: 화살 함정에서 지정된 생존자가 방어하지 않으면 대신 죽는다', {
  card: '인간 방패',
  rule: RULE.인간방패 + ' / 화살 함정: 날아오는 화살들을 생존자 중 한 명이 방패로 막지 않는다면 이 카드를 뽑은 자는 죽게 됩니다.',
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['인간 방패'] }, deck: ['화살 함정'] });
  await drawEvent(g, 0, '화살 함정');
  await g.waitPhase('WAITING_FOR_DEFENSE');
  interrupt(g, 0, '인간 방패', 1);
  await g.waitFor(() => pending(g)?.targetId === g.c(1).id, '나래가 새 방어 대상');
  g.c(1).act('skip_defense');
  await waitSettledMain(g);
  t.expect(!g.p(1).isAlive, '인간 방패가 된 나래가 죽어야 함');
  t.expect(g.p(0).isAlive, '함정을 밟은 가람은 살아야 함');
});

scenario('인간 방패: 화살 함정에서 지정된 생존자는 방패로 막을 수 있다', { card: '인간 방패', rule: RULE.인간방패 }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['인간 방패'], 1: ['황금 방패'] }, deck: ['화살 함정'] });
  await drawEvent(g, 0, '화살 함정');
  await g.waitPhase('WAITING_FOR_DEFENSE');
  interrupt(g, 0, '인간 방패', 1);
  await g.waitFor(() => pending(g)?.targetId === g.c(1).id, '나래가 새 방어 대상');
  g.c(1).act('play_shield', g.cardId(1, '황금 방패'));
  await waitSettledMain(g);
  await g.waitServerMs(30000);
  t.expect(g.p(0).isAlive && g.p(1).isAlive, '방패로 막았으므로 둘 다 살아야 함');
});

scenario('인간 방패: 피바라기를 뽑아 공격한 자는 지정할 수 없다', { card: '인간 방패', rule: RULE.인간방패 }, async (t) => {
  const g = await t.game({ players: 3, hands: { 1: ['인간 방패'] }, deck: ['피바라기'] });
  await drawEvent(g, 0, '피바라기');
  await g.waitFor(() => g.requests(0, 'request_target').length > 0, '대상 선택 요청');
  g.c(0).act('submit_target', g.c(1).id);
  await g.waitPhase('WAITING_FOR_DEFENSE');
  interrupt(g, 1, '인간 방패', 0);
  await g.settle();
  t.expectEq(pending(g)?.targetId, g.c(1).id, '피바라기 공격자 가람은 인간 방패가 될 수 없음');
  interrupt(g, 1, '인간 방패', 2);
  await g.waitFor(() => pending(g)?.targetId === g.c(2).id, '다온이 새 방어 대상');
  g.c(2).act('skip_defense');
  await waitSettledMain(g);
  t.expect(!g.p(2).isAlive && g.p(1).isAlive, '다온이 대신 죽고 나래는 살아야 함');
});

scenario('인간 방패: 필멸의 창이 튕겨 왔을 때 처음 창을 던진 자를 지정할 수 있나', {
  card: '인간 방패',
  rule: RULE.인간방패 + ' / 필멸의 창: 이 창으로 공격당한 자가 방패로 막으면 오른쪽 생존자로 향합니다.',
  ambiguous: '필멸의 창이 나래의 방패에 튕겨 다온에게 왔을 때, 다온에게 "자신을 공격한 최초 공격 당사자"는 처음 창을 던진 가람인가요, 직전에 창을 넘긴 나래인가요? (인간 방패로 지정 불가한 사람)',
}, async (t) => {
  const g = await t.game({ players: 4, hands: { 0: ['필멸의 창'], 1: ['황금 방패'], 2: ['인간 방패'] } });
  await attack(g, 0, 1, '필멸의 창');
  g.c(1).act('play_shield', g.cardId(1, '황금 방패'));
  await g.waitFor(() => pending(g)?.targetId === g.c(2).id, '창이 다온에게 향함');
  interrupt(g, 2, '인간 방패', 1);
  await g.settle();
  const toPasser = pending(g)?.targetId;
  t.note(`직전에 창을 넘긴 나래 지정: ${toPasser === g.c(1).id ? '허용' : '거부'}`);
  if (g.hand(2).includes('인간 방패')) {
    interrupt(g, 2, '인간 방패', 0);
    await g.settle();
    t.note(`처음 창을 던진 가람 지정: ${pending(g)?.targetId === g.c(0).id ? '허용' : '거부'}`);
  }
});

