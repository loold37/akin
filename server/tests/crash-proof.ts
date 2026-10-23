import { fork, ChildProcess } from 'child_process';
import net from 'net';
import { TestClient, waitUntil } from './harness/client';

// 실제 서버 프로세스(예외 처리기 없음)를 띄워, 정상 UI로 가능한 조작만으로 프로세스가 죽는지 확인합니다.
// 시나리오: [천사의 심판대] 패 공개 중 한 명이 "확인"을 누른 뒤, 다른 한 명이 패에서 [긴급탈출키트]를 사용
//   → index.ts의 긴급탈출키트 처리에서 responses 값(true)에 forEach를 호출해 TypeError → Node 프로세스 종료
//
// 사용법: npm run test:crash-proof

if (process.env.CRASH_PROOF_CHILD) {
  // ── 자식: 운영과 같은 서버. 방 상태 조작용 IPC만 추가로 받습니다.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { rooms, server } = require('../src/index');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { makeCard } = require('./harness/cards');
  const send = (m: unknown) => process.send?.(m);
  if (server.listening) send({ type: 'ready' });
  else server.once('listening', () => send({ type: 'ready' }));

  process.on('message', (msg: any) => {
    if (msg?.type !== 'rig') return;
    const room = rooms.get(msg.code);
    const [drawer, other] = room.players;
    for (const p of room.players) p.hand = { malices: [], weapons: [], shields: [], treasures: [], items: [] };
    room.addCardToHand(drawer, makeCard('시선'));
    room.addCardToHand(other, makeCard('긴급탈출키트'));
    room.players.forEach((p: any) => room.recalculateMalice(p));
    room.deck = [makeCard('코인'), makeCard('코인'), makeCard('천사의 심판대')];
    room.currentTurnIndex = 0;
    room.currentTurnPlayerId = drawer.id;
    room.players.forEach((p: any) => {
      p.isMyTurn = p.id === drawer.id;
      p.hasDrawnThisTurn = false;
    });
    room.onStateChange?.();
    send({ type: 'rigged' });
  });
} else {
  main().catch((e) => {
    console.error(e);
    process.exit(2);
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

function once(child: ChildProcess, type: string): Promise<void> {
  return new Promise((resolve) => {
    const onMsg = (m: any) => {
      if (m?.type === type) {
        child.off('message', onMsg);
        resolve();
      }
    };
    child.on('message', onMsg);
  });
}

async function main() {
  const port = await freePort();
  let stderr = '';
  const child = fork(__filename, [], {
    env: { ...process.env, CRASH_PROOF_CHILD: '1', PORT: String(port) },
    execArgv: ['-r', 'ts-node/register/transpile-only'],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  child.stderr?.on('data', (d) => (stderr += d.toString()));
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  await once(child, 'ready');

  const url = `http://127.0.0.1:${port}`;
  const code = 'CRASH' + Math.random().toString(36).slice(2, 6).toUpperCase();
  const a = new TestClient(url, '가람');
  const b = new TestClient(url, '나래');
  await a.connect();
  await b.connect();
  a.join(code);
  await waitUntil(() => a.roomPlayers.length === 1, 3000, '가람 입장');
  b.join(code);
  await waitUntil(() => b.roomPlayers.length === 2, 3000, '나래 입장');
  a.act('start_game');
  await waitUntil(() => a.state?.phase === 'MAIN', 3000, '게임 시작');

  child.send({ type: 'rig', code });
  await once(child, 'rigged');
  await waitUntil(() => a.state?.myInfo.hand.malices.length === 1, 3000, '리깅 반영');

  console.log('1) 가람이 카드를 뽑음 → [천사의 심판대]');
  a.act('draw_card');
  await waitUntil(() => a.eventsOf('request_vote').length > 0, 3000, '투표 요청');
  console.log('2) 두 사람 모두 가람에게 투표');
  a.act('submit_vote', a.id, false);
  b.act('submit_vote', a.id, false);
  await waitUntil(() => !!a.state?.revealedCardsInfo, 3000, '패 공개 화면');
  console.log('3) 가람이 패 공개 "확인" 클릭');
  a.act('confirm_reveal');
  await waitUntil(() => (a.state?.revealedCardsInfo?.confirmedPlayerIds.length ?? 0) === 1, 3000, '확인 반영');
  console.log('4) 나래가 패에서 [긴급탈출키트] 사용');
  b.act('interrupt_action', b.state!.myInfo.hand.items[0].id);

  const exitCode = await Promise.race([exited, new Promise<'alive'>((r) => setTimeout(() => r('alive'), 3000))]);
  a.close();
  b.close();
  if (exitCode === 'alive') {
    console.log('\n결과: 서버가 살아 있습니다 (재현 안 됨 — 이미 수정되었을 수 있음).');
    child.kill();
    process.exit(0);
  }
  console.log(`\n결과: 💥 서버 프로세스가 종료되었습니다 (exit code ${exitCode}). 이 서버의 모든 방이 끊깁니다.`);
  console.log(stderr.split('\n').filter((l) => /Error|at Socket/.test(l)).slice(0, 3).join('\n'));
  process.exit(1);
}
