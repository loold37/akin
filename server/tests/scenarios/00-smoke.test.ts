import { scenario } from '../harness/runner';

// 하네스 자체가 제대로 동작하는지 확인하는 기본 시나리오들.

scenario('일반 카드를 뽑으면 패에 들어가고 차례 종료가 가능해진다', { card: '기본 진행' }, async (t) => {
  const g = await t.game({ players: 2, deck: ['시선'] });
  g.c(0).act('draw_card');
  await g.waitFor(() => g.p(0).hasDrawnThisTurn, '드로우');
  t.expectEq(g.hand(0), ['시선'], '뽑은 카드가 패에 있어야 함');
  t.expectEq(g.p(0).currentMalice, 1, '악의 1점');
  g.c(0).act('end_turn');
  await g.waitFor(() => g.room.currentTurnPlayerId === g.c(1).id, '차례 넘김');
});

scenario('무기 공격을 방어하지 않으면 대상이 죽는다', { card: '십자가', rule: '자신의 차례 중 언제든지 다른 생존자를 1회 공격할 수 있으며, 사용 후 버려야 합니다.' }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['십자가#201'] } });
  g.c(0).act('play_tool', g.cardId(0, '십자가'), g.c(1).id);
  await g.waitPhase('WAITING_FOR_DEFENSE');
  g.c(1).act('skip_defense');
  await g.waitFor(() => !g.p(1).isAlive, '피격자 사망');
  await g.waitPhase('MAIN');
  t.expectEq(g.hand(0), [], '사용한 무기는 버려짐');
  t.expect(g.room.graveyard.some((c) => c.name === '십자가'), '무덤에 십자가가 있어야 함');
});

scenario('일반 방패로 공격을 막으면 둘 다 산다', { card: '황금 방패', rule: '다른 생존자가 무기로 공격할 때 차례와 관계없이 즉시 막을 수 있으며, 사용 후 버립니다.' }, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['성정'], 1: ['황금 방패'] } });
  g.c(0).act('play_tool', g.cardId(0, '성정'), g.c(1).id);
  await g.waitPhase('WAITING_FOR_DEFENSE');
  g.c(1).act('play_shield', g.cardId(1, '황금 방패'));
  await g.waitPhase('MAIN');
  t.expect(g.p(1).isAlive, '방어자는 살아 있어야 함');
  t.expectEq(g.hand(1), [], '사용한 방패는 버려짐');
});
