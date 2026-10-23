import { scenario } from '../harness/runner';
import type { GameCtx } from '../harness/game';
import { TestClient } from '../harness/client';
import { startTestServer } from '../harness/server';

// 치명 버그(S1~S5) 수정 후 독립 리뷰에서 찾은, 게임 종료 직전 경계 상황들.

const scoreOf = (g: GameCtx, i: number) => g.c(i).gameOvers[0]?.find((s) => s.playerId === g.c(i).id);

async function drawVoteEvent(g: GameCtx, drawer: number): Promise<void> {
  g.c(drawer).act('draw_card');
  await g.waitFor(() => g.requests(drawer, 'request_vote').length > 0, '투표 요청');
}

scenario('게임 종료 순서: 미끼 투표 후 상대가 나가면 남은 표로 마지막 생존자가 처형되지 않는다', {
  card: '미끼',
  rule: '생존자가 1명만 남으면 그 즉시 게임이 끝나야 하며, 남아 있던 투표가 결과를 뒤집으면 안 됨',
}, async (t) => {
  const g = await t.game({ players: 2, deck: ['미끼'] });
  await drawVoteEvent(g, 0);
  g.c(0).act('submit_vote', g.c(1).id, false);
  await g.waitFor(() => Object.keys(g.room.pendingAction?.responses ?? {}).length === 1, '가람 투표 기록');
  g.c(1).act('leave_room');
  await g.waitPhase('ENDED');
  await g.settle();
  t.expect(g.p(0).isAlive, '가람은 마지막 생존자로 살아 있어야 함');
  t.expectEq(g.c(0).gameOvers.length, 1, 'game_over는 한 번');
  t.expect((scoreOf(g, 0)?.score ?? 0) > 0, `가람이 승점을 받아야 함 (실제: ${JSON.stringify(scoreOf(g, 0))})`);
});

scenario('게임 종료 순서: 눈 없는 괴물 중 미끼 투표 후 상대가 소리를 내 죽으면 마지막 생존자는 산다', {
  card: '눈 없는 괴물',
  rule: '소리를 낸 생존자는 괴물에게 들켜 죽게 됩니다 + 최후의 1인이 정해지면 게임 종료',
}, async (t) => {
  const g = await t.game({ players: 2, deck: ['미끼'] });
  (g.room as any).silenceMode = true;
  (g.room as any).silenceTurnCount = 5;
  await drawVoteEvent(g, 0);
  g.c(0).act('submit_vote', g.c(1).id, false);
  await g.waitFor(() => Object.keys(g.room.pendingAction?.responses ?? {}).length === 1, '가람 투표 기록');
  g.c(1).act('send_chat', '앗');
  await g.waitPhase('ENDED');
  await g.settle();
  t.expect(!g.p(1).isAlive, '소리를 낸 나래는 사망');
  t.expect(g.p(0).isAlive, '가람은 살아 있어야 함');
  t.expectEq(g.c(0).gameOvers.length, 1, 'game_over는 한 번');
  t.expect((scoreOf(g, 0)?.score ?? 0) > 0, '가람이 승점을 받아야 함');
});

scenario('게임 종료 순서: 천사의 심판대 투표 후 상대가 나가면 살아남은 사람의 사망 안내가 나가지 않는다', {
  card: '천사의 심판대',
  rule: '최후의 1인이 정해지면 게임 종료. 일어나지 않은 처형을 안내하면 안 됨',
}, async (t) => {
  const g = await t.game({ players: 2, hands: { 0: ['시선'] }, deck: ['천사의 심판대'] });
  await drawVoteEvent(g, 0);
  g.c(0).act('submit_vote', g.c(1).id, false);
  await g.waitFor(() => Object.keys(g.room.pendingAction?.responses ?? {}).length === 1, '가람 투표 기록');
  g.c(1).act('leave_room');
  await g.waitPhase('ENDED');
  await g.settle();
  t.expect(g.p(0).isAlive, '가람은 살아 있어야 함');
  const wrong = g.msgs(0).filter((m) => m.includes('[가람]님이 심판을 받아 사망'));
  t.expectEq(wrong, [], '가람이 죽었다는 안내가 나가면 안 됨');
});

scenario('게임 종료 순서: 마육검 입찰 중 게임이 끝나면 입찰한 악의가 돌아와 악인으로 정산된다', {
  card: '마육검',
  rule: '악의를 "공개"하는 경매이므로 카드는 패에 남음. 악인 최후의 1인은 참가 인원만큼 승점',
}, async (t) => {
  const g = await t.game({ players: 2, hands: { 0: ['시선', '상처', '흑역사'] }, deck: ['마육검'] });
  t.expectEq(g.p(0).alignment, 'EVIL', '전제: 가람은 악의 3점 악인');
  g.c(0).act('draw_card');
  await g.waitFor(() => g.room.activeEvent?.name === '마육검', '마육검 경매 시작');
  g.c(0).act('submit_cards', g.handCards(0).map((c) => c.id));
  await g.waitFor(() => g.hand(0).length === 0, '입찰 카드 제출');
  g.c(1).act('leave_room');
  await g.waitPhase('ENDED');
  await g.settle();
  t.expectEq(g.hand(0).sort(), ['상처', '시선', '흑역사'].sort(), '입찰한 악의가 패로 돌아와야 함');
  t.expectEq(g.p(0).alignment, 'EVIL', '정산 시 악인');
  const s = scoreOf(g, 0);
  t.expect(s?.reason.includes('악인') && s.score === 2, `악인 최후의 1인 정산이어야 함 (실제: ${JSON.stringify(s)})`);
});

scenario('게임 종료 후: 인연의 끈을 끊어도 무기가 소모되지 않는다', {
  card: '인연의 끈',
  rule: '게임이 끝난 뒤에는 어떤 행동으로도 패가 바뀌면 안 됨',
}, async (t) => {
  const g = await t.game({ players: 2, hands: { 0: ['성정'] }, deck: [], filler: 0 });
  (g.room as any).linkedPlayers = [g.c(0).id, g.c(1).id];
  g.c(0).act('draw_card');
  await g.waitPhase('ENDED');
  g.c(0).act('cut_fate_link', g.cardId(0, '성정'));
  await g.settle();
  t.expectEq(g.hand(0), ['성정'], '게임 종료 후에는 무기가 그대로');
});

// ── S26: 소켓 id를 방 코드로 입장해 남의 비공개 정보 엿보기 ──

async function withSpy(g: GameCtx, fn: (spy: TestClient) => Promise<void>): Promise<void> {
  const spy = new TestClient(g.srv.url, '스파이');
  await spy.connect();
  try {
    await fn(spy);
  } finally {
    spy.close();
  }
}

scenario('S26: 다른 플레이어의 소켓 id를 방 코드로 입장해도 그 사람의 패와 개인 안내를 받을 수 없다', {
  card: '보안',
  rule: '각 플레이어의 패는 본인만 볼 수 있어야 함 (총 장수 외 비공개)',
}, async (t) => {
  const g = await t.game({ players: 2, hands: { 0: ['성정', '황금 방패'] }, deck: ['시선'] });
  const victimCards = g.handCards(0).map((c) => c.id);
  await withSpy(g, async (spy) => {
    spy.join(g.c(0).id);
    await g.settle();
    g.c(0).act('draw_card');
    await g.waitFor(() => g.p(0).hasDrawnThisTurn, '가람 드로우');
    g.broadcast();
    await g.settle();
    const leakedStates = spy.eventsOf('game_state_update').filter((e) =>
      JSON.stringify(e.args[0]?.myInfo?.hand ?? {}).includes(victimCards[0]),
    );
    t.expectEq(leakedStates.length, 0, '가람의 패가 담긴 상태를 스파이가 받으면 안 됨');
    const leakedPrivate = spy.messages().filter((m) => m.includes('카드를 획득했습니다'));
    t.expectEq(leakedPrivate, [], '가람의 개인 안내(뽑은 카드 이름)를 스파이가 받으면 안 됨');
  });
});

scenario('S26: 다른 플레이어의 소켓 id를 방 코드로 쓰면 입장이 거부되고 그 사람 화면도 오염되지 않는다', {
  card: '보안',
  rule: '방 코드로 남의 개인 채널에 들어갈 수 없어야 함',
}, async (t) => {
  const g = await t.game({ players: 2 });
  await withSpy(g, async (spy) => {
    const before = g.c(0).eventsOf('room_state_update').length;
    spy.join(g.c(0).id);
    await g.settle();
    t.expect(!g.srv.rooms.has(g.c(0).id), '소켓 id 이름의 방이 만들어지면 안 됨');
    t.expectEq(g.c(0).eventsOf('room_state_update').length, before, '가람이 스파이 방의 인원 정보를 받으면 안 됨');
  });
});

scenario('S26: 개인 요청(선물 대상 선택)은 뽑은 사람에게만 간다', {
  card: '선물',
  rule: '이 카드를 뽑은 자는 자신의 패에서 원하는 카드 1장을 골라 다른 생존자에게 선물합니다.',
}, async (t) => {
  const g = await t.game({ players: 3, hands: { 0: ['코인'] }, deck: ['선물'] });
  await withSpy(g, async (spy) => {
    spy.join(g.c(0).id);
    await g.settle();
    g.c(0).act('draw_card');
    await g.waitFor(() => g.requests(0, 'request_target').length > 0, '가람에게 선물 대상 요청');
    await g.settle();
    t.expectEq(spy.eventsOf('request_target').length, 0, '스파이는 가람의 개인 요청을 받으면 안 됨');
    t.expectEq(g.requests(1, 'request_target').length, 0, '다른 플레이어도 받지 않음');
  });
});

scenario('S26: 대문자 변환으로 길어진 방 코드(합자 7글자 → 21자)도 입장할 수 있다', {
  card: '보안',
  rule: '클라이언트가 보낼 수 있는 방 코드(입력 10자 + toUpperCase)는 모두 받아야 함',
}, async (t) => {
  const srv = await startTestServer();
  const code = 'ﬃﬃﬃﬃﬃﬃﬃ'.trim().toUpperCase();
  t.expectEq(code.length, 21, '전제: 21자로 늘어남');
  const c = new TestClient(srv.url, '가람');
  await c.connect();
  try {
    c.join(code);
    await t.waitUntil(() => srv.rooms.get(code)?.players.length === 1, 2000, '입장');
  } finally {
    srv.rooms.get(code)?.resetToLobby();
    c.close();
  }
});
