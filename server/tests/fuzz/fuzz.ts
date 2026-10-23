import fs from 'fs';
import path from 'path';
import { startTestServer, CrashRecord } from '../harness/server';
import { TestClient, waitUntil, sleep } from '../harness/client';
import { InvariantTracker, Violation, VIOLATION_INFO } from '../harness/invariants';
import { DEFAULT_NAMES } from '../harness/game';
import { Bot, mulberry32, ChaosRecord } from './bot';

// 무작위 봇 N명으로 게임을 끝까지 수백 판 돌리며 불변식 위반 / 서버 예외 / 멈춤을 수집합니다.
//
// 사용법: npm run test:fuzz -- --games 300 --chaos 0.03 --seed 42
//   --games N        판 수 (기본 200)
//   --concurrency K  동시에 돌릴 방 수 (기본 6)
//   --seed S         시작 시드 (판마다 seed+i)
//   --min/--max      인원 범위 (기본 2~6)
//   --chaos R        봇이 잘못된 입력을 보낼 확률 (기본 0.02, 0이면 정상 플레이만)
//   --afk R          봇이 요청을 무시할 확률 (기본 0.1)
//   --leave R        한 판에서 누군가 중간에 나갈 확률 (기본 0.15)
//   --join R         한 판에서 누군가 중간에 들어올 확률 (기본 0)
//   --scale X        서버 타이머 배율 (기본 0.01 → 30초=300ms)
//   --reset 1        chaos 입력에 return_to_lobby 포함 (게임 도중 초기화 시험)
//   --out NAME       보고서 파일 이름 (기본: fuzz-seed<S>-chaos<R> → tests/reports/NAME.md/json)

function arg(name: string, def: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? Number(process.argv[i + 1]) : def;
}

const OPTS = {
  games: arg('games', 200),
  concurrency: arg('concurrency', 6),
  seed: arg('seed', 1),
  min: arg('min', 2),
  max: arg('max', 6),
  chaos: arg('chaos', 0.02),
  afk: arg('afk', 0.1),
  leave: arg('leave', 0.15),
  join: arg('join', 0),
  scale: arg('scale', 0.01),
  stuckMs: arg('stuck', 3000),
  maxGameMs: arg('maxGame', 60000),
  reset: arg('reset', 0),
};

// 동시에 여러 퍼즈를 돌려도 서로 덮어쓰지 않도록 시드/옵션을 파일 이름에 넣습니다.
const REPORT_NAME = (() => {
  const i = process.argv.indexOf('--out');
  return i !== -1 ? process.argv[i + 1] : `fuzz-seed${OPTS.seed}-chaos${OPTS.chaos}`;
})();

const EXTRA_INFO: Record<string, { severity: string; title: string }> = {
  STUCK: { severity: 'critical', title: '게임이 진행되지 않고 멈춤 (워치독)' },
  GAME_TIMEOUT: { severity: 'major', title: '제한 시간 안에 게임이 끝나지 않음' },
  MISSING_GAME_OVER: { severity: 'major', title: '게임이 끝났는데 game_over 이벤트를 못 받음' },
  DUPLICATE_GAME_OVER: { severity: 'major', title: 'game_over 이벤트를 두 번 이상 받음' },
};

interface GameResult {
  no: number;
  seed: number;
  players: number;
  outcome: 'ended' | 'stuck' | 'timeout' | 'reset' | 'setup-failed';
  endReason: string;
  violations: Violation[];
  log: string[];
  events: string[];
  ms: number;
  actions: number;
  chaos: ChaosRecord[];
}

const allChaos: ChaosRecord[] = [];
const eventCounts = new Map<string, number>();

async function playGame(no: number, seed: number): Promise<GameResult> {
  const srv = await startTestServer();
  const rng = mulberry32(seed);
  const n = OPTS.min + Math.floor(rng() * (OPTS.max - OPTS.min + 1));
  const code = `F${no}S${seed}`;
  const started = Date.now();
  const log: string[] = [];
  const push = (line: string) => {
    log.push(`${String(Date.now() - started).padStart(5)}ms ${line}`);
    if (log.length > 400) log.splice(0, 200);
  };
  const violations: Violation[] = [];
  const extra = (code: string, message: string) => {
    violations.push({ code, severity: (EXTRA_INFO[code]?.severity ?? 'major') as any, message, at: Date.now(), count: 1 });
    push(`🚨 [${code}] ${message}`);
  };

  const clients: TestClient[] = [];
  const bots: Bot[] = [];
  const result: GameResult = { no, seed, players: n, outcome: 'setup-failed', endReason: '', violations, log, events: [], ms: 0, actions: 0, chaos: [] };

  const knownIds = () => {
    const room = srv.rooms.get(code);
    const cards = room ? room.players.flatMap((p) => [...p.hand.malices, ...p.hand.weapons, ...p.hand.shields, ...p.hand.treasures, ...p.hand.items].map((c) => c.id)) : [];
    return { players: room ? room.players.map((p) => p.id) : [], cards };
  };
  const addBot = (c: TestClient) => {
    const bot = new Bot(c, { rng, afkRate: OPTS.afk, chaosRate: OPTS.chaos, chatRate: 0.01, knownIds, log: push, chaosReset: !!OPTS.reset });
    bots.push(bot);
  };

  try {
    for (let i = 0; i < n; i++) {
      const c = new TestClient(srv.url, DEFAULT_NAMES[i]);
      await c.connect();
      c.join(code);
      clients.push(c);
      await waitUntil(() => (srv.rooms.get(code)?.players.length ?? 0) === i + 1, 3000, '입장');
    }
    clients[0].onEvent(() => {
      const e = clients[0].events[clients[0].events.length - 1];
      if (e.ev === 'action_result' || e.ev === 'chat_message') push(`📣 ${e.args.join(': ')}`);
      if (e.ev === 'events_triggered') {
        for (const ev of e.args[0] ?? []) {
          result.events.push(ev.name);
          eventCounts.set(ev.name, (eventCounts.get(ev.name) ?? 0) + 1);
        }
      }
    });
    clients[0].act('start_game');
    await waitUntil(() => srv.rooms.get(code)?.phase === 'MAIN', 3000, '게임 시작');
  } catch (e: any) {
    result.endReason = `셋업 실패: ${e.message}`;
    clients.forEach((c) => c.close());
    return result;
  }

  const room = srv.rooms.get(code)!;
  const tracker = new InvariantTracker(room, (v) => push(`🚨 [${v.code}] ${v.message}`));
  clients.forEach(addBot);
  push(`게임 시작: ${n}명, 덱 ${room.deck.length}장`);

  // 중간 퇴장 / 중간 입장
  if (rng() < OPTS.leave) {
    const at = 200 + Math.floor(rng() * 3000);
    const who = Math.floor(rng() * n);
    const explicit = rng() < 0.5;
    setTimeout(() => {
      if (room.phase === 'ENDED') return;
      const c = clients[who];
      push(`🚪 ${c.name} ${explicit ? 'leave_room' : '연결 끊김'} (차례: ${room.players.find((p) => p.id === room.currentTurnPlayerId)?.name})`);
      bots[who].stop();
      if (explicit) c.act('leave_room');
      else c.close();
    }, at);
  }
  if (rng() < OPTS.join) {
    setTimeout(async () => {
      if (room.phase === 'ENDED') return;
      const c = new TestClient(srv.url, '난입자');
      await c.connect();
      c.join(code);
      clients.push(c);
      addBot(c);
      push(`🆕 게임 도중 난입자가 join_room`);
    }, 300 + Math.floor(rng() * 2000));
  }

  // 진행 감시
  const pendingIds = new WeakMap<object, number>();
  let pendingSeq = 0;
  const signature = () => {
    const p = room.pendingAction as any;
    if (p && !pendingIds.has(p)) pendingIds.set(p, ++pendingSeq);
    return [
      room.phase, room.currentTurnPlayerId, room.deck.length, room.graveyard.length, p ? pendingIds.get(p) : 0,
      p ? Object.keys(p.responses ?? {}).length : 0, p?.targetId, room.turnDeadline, room.getAlivePlayers().length,
    ].join('|');
  };
  let lastSig = signature();
  let lastChange = Date.now();

  const outcome = await new Promise<'ended' | 'stuck' | 'timeout' | 'reset'>((resolve) => {
    const iv = setInterval(() => {
      try {
        tracker.check();
      } catch (e: any) {
        push(`[검사 오류] ${e.message}`);
      }
      const sig = signature();
      if (sig !== lastSig) {
        lastSig = sig;
        lastChange = Date.now();
      }
      if (room.phase === 'ENDED') {
        clearInterval(iv);
        resolve('ended');
      } else if (room.phase === 'WAITING') {
        clearInterval(iv);
        resolve('reset');
      } else if (Date.now() - lastChange > OPTS.stuckMs) {
        clearInterval(iv);
        resolve('stuck');
      } else if (Date.now() - started > OPTS.maxGameMs) {
        clearInterval(iv);
        resolve('timeout');
      }
    }, 2);
  });

  if (outcome === 'stuck') {
    const p = room.pendingAction as any;
    extra('STUCK', `${room.phase} 단계에서 ${OPTS.stuckMs}ms 동안 변화 없음 (이벤트: ${room.activeEvent?.name ?? '-'}, 대기 액션: ${p ? `${p.type}/${p.eventName ?? '무기 공격'}` : '없음'}, 차례: ${room.players.find((x) => x.id === room.currentTurnPlayerId)?.name}, 생존: ${room.getAlivePlayers().map((x) => x.name).join(',')})`);
  } else if (outcome === 'timeout') {
    extra('GAME_TIMEOUT', `${OPTS.maxGameMs}ms 안에 끝나지 않음 (단계 ${room.phase})`);
  } else {
    // 종료 후에도 상태가 바뀌지 않는지 잠시 더 지켜봅니다.
    const endWatch = Date.now();
    while (Date.now() - endWatch < 150) {
      tracker.check();
      await sleep(5);
    }
    const alive = room.getAlivePlayers();
    result.endReason = alive.length <= 1 ? `최후의 1인 (${alive[0]?.name ?? '전멸'})` : room.deck.length === 0 ? '덱 소진' : `기타 (생존 ${alive.length}, 덱 ${room.deck.length})`;
    for (const c of clients) {
      if (!c.socket.connected || !room.players.some((p) => p.id === c.id)) continue;
      if (c.gameOvers.length === 0) extra('MISSING_GAME_OVER', `${c.name}이(가) game_over를 받지 못함 (${result.endReason})`);
      if (c.gameOvers.length > 1) extra('DUPLICATE_GAME_OVER', `${c.name}이(가) game_over를 ${c.gameOvers.length}번 받음`);
    }
  }

  tracker.check();
  violations.push(...tracker.violations);
  tracker.dispose();
  bots.forEach((b) => b.stop());
  result.actions = bots.reduce((s, b) => s + b.actions, 0);
  result.chaos = bots.flatMap((b) => b.chaos);
  allChaos.push(...result.chaos);
  if (allChaos.length > 5000) allChaos.splice(0, 2500);
  room.resetToLobby();
  clients.forEach((c) => c.close());
  result.outcome = outcome;
  result.ms = Date.now() - started;
  return result;
}

interface Bucket {
  code: string;
  severity: string;
  title: string;
  games: number;
  occurrences: number;
  examples: Array<{ game: number; seed: number; players: number; message: string; log: string[] }>;
}

function summarize(results: GameResult[], crashes: CrashRecord[]) {
  const buckets = new Map<string, Bucket>();
  for (const r of results) {
    const seenInGame = new Set<string>();
    for (const v of r.violations) {
      const info = (VIOLATION_INFO as any)[v.code] ?? EXTRA_INFO[v.code] ?? { severity: v.severity, title: v.code };
      const b: Bucket = buckets.get(v.code) ?? { code: v.code, severity: info.severity, title: info.title, games: 0, occurrences: 0, examples: [] };
      b.occurrences += v.count;
      if (!seenInGame.has(v.code)) {
        b.games++;
        seenInGame.add(v.code);
        if (b.examples.length < 4) {
          const idx = r.log.findIndex((l) => l.includes(`[${v.code}]`));
          const end = idx === -1 ? r.log.length : idx + 1;
          b.examples.push({ game: r.no, seed: r.seed, players: r.players, message: v.message, log: r.log.slice(Math.max(0, end - 30), end) });
        }
      }
      buckets.set(v.code, b);
    }
  }

  const crashGroups = new Map<string, { message: string; frame: string; count: number; stack: string; chaosBefore: ChaosRecord[] }>();
  for (const c of crashes) {
    const frame = c.stack.split('\n').find((l) => l.includes('/server/src/')) ?? c.stack.split('\n')[1] ?? '';
    const key = c.message + '|' + frame.trim();
    const g = crashGroups.get(key);
    if (g) {
      g.count++;
      continue;
    }
    crashGroups.set(key, {
      message: c.message,
      frame: frame.trim(),
      count: 1,
      stack: c.stack.split('\n').slice(0, 6).join('\n'),
      chaosBefore: allChaos.filter((x) => x.t <= c.at && c.at - x.t < 60).slice(-6),
    });
  }

  const order = { critical: 0, major: 1, minor: 2 } as Record<string, number>;
  return {
    buckets: [...buckets.values()].sort((a, b) => order[a.severity] - order[b.severity] || b.games - a.games),
    crashes: [...crashGroups.values()].sort((a, b) => b.count - a.count),
  };
}

function writeReport(results: GameResult[], crashes: CrashRecord[], wallMs: number): string {
  const { buckets, crashes: crashGroups } = summarize(results, crashes);
  const outDir = path.join(__dirname, '..', 'reports');
  fs.mkdirSync(outDir, { recursive: true });
  const endReasons = new Map<string, number>();
  for (const r of results) {
    const key = r.outcome === 'ended' ? r.endReason.replace(/\(.*\)/, '').trim() : r.outcome;
    endReasons.set(key, (endReasons.get(key) ?? 0) + 1);
  }

  const lines: string[] = [];
  lines.push('# 퍼즈(무작위 봇) 테스트 결과', '');
  lines.push(`- 옵션: \`${JSON.stringify(OPTS)}\``);
  lines.push(`- ${results.length}판, ${(wallMs / 1000).toFixed(1)}초, 봇 행동 ${results.reduce((s, r) => s + r.actions, 0)}회`);
  lines.push(`- 종료 사유: ${[...endReasons].map(([k, v]) => `${k} ${v}`).join(', ')}`);
  lines.push(`- 발동된 이벤트: ${[...eventCounts].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`, '');

  lines.push(`## 💥 서버 예외 (운영 환경에서는 서버 프로세스가 종료됨): ${crashGroups.length}종`, '');
  for (const c of crashGroups) {
    lines.push(`### \`${c.message}\` — ${c.count}회`, '', '```', c.stack, '```');
    if (c.chaosBefore.length) {
      lines.push('직전에 들어온 잘못된 입력:', '```');
      for (const x of c.chaosBefore) lines.push(`${x.bot}: ${x.ev}(${x.args.map((a) => JSON.stringify(a)?.slice(0, 40)).join(', ')})`);
      lines.push('```');
    }
    lines.push('');
  }

  lines.push(`## 🚨 불변식 위반: ${buckets.length}종`, '');
  for (const b of buckets) {
    lines.push(`### [${b.severity}] ${b.code} — ${b.title}`, '', `${b.games}판에서 발생 (총 ${b.occurrences}회)`, '');
    for (const ex of b.examples) {
      lines.push(`- ${ex.game}번째 판 (seed ${ex.seed}, ${ex.players}명): ${ex.message}`);
    }
    const ex = b.examples[0];
    if (ex) lines.push('', '<details><summary>첫 사례 직전 로그</summary>', '', '```', ...ex.log, '```', '</details>');
    lines.push('');
  }

  const base = REPORT_NAME;
  const md = path.join(outDir, `${base}.md`);
  fs.writeFileSync(md, lines.join('\n'));
  fs.writeFileSync(path.join(outDir, `${base}.json`), JSON.stringify({ opts: OPTS, buckets, crashes: crashGroups, games: results.map((r) => ({ ...r, log: r.violations.length ? r.log : [] })) }, null, 2));
  return md;
}

async function main() {
  const srv = await startTestServer({ timeScale: OPTS.scale });
  const start = Date.now();
  const results: GameResult[] = [];
  let next = 0;

  const worker = async () => {
    while (next < OPTS.games) {
      const i = next++;
      const r = await playGame(i + 1, OPTS.seed + i);
      results.push(r);
      const vs = r.violations.length ? ` 🚨 ${[...new Set(r.violations.map((v) => v.code))].join(',')}` : '';
      process.stdout.write(`#${String(r.no).padStart(3)} ${r.players}명 ${r.outcome.padEnd(7)} ${r.endReason.padEnd(18)} ${String(r.ms).padStart(5)}ms${vs}\n`);
    }
  };
  await Promise.all(Array.from({ length: OPTS.concurrency }, worker));
  await sleep(200);

  results.sort((a, b) => a.no - b.no);
  const md = writeReport(results, srv.crashes, Date.now() - start);
  const { buckets, crashes } = summarize(results, srv.crashes);
  process.stdout.write(`\n서버 예외 ${crashes.length}종, 불변식 위반 ${buckets.length}종\n`);
  for (const c of crashes) process.stdout.write(`  💥 ${c.message} (${c.count}회) ${c.frame}\n`);
  for (const b of buckets) process.stdout.write(`  🚨 [${b.severity}] ${b.code}: ${b.games}판 — ${b.examples[0]?.message ?? ''}\n`);
  process.stdout.write(`\n보고서: ${path.relative(process.cwd(), md)}\n`);
  process.exit(crashes.length || buckets.some((b) => b.severity !== 'minor') ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
