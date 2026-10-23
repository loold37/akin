import fs from 'fs';
import path from 'path';
import { createGame, GameCtx, GameOptions } from './game';
import { startTestServer } from './server';
import { sleep, waitUntil } from './client';
import { Violation } from './invariants';

// 아주 작은 시나리오 테스트 러너.
// 규칙대로라면 일어나야 하는 일을 단언하고, 실패하면 = 현재 구현이 규칙과 다르다는 뜻입니다.

export interface ScenarioMeta {
  /** 관련 카드 이름 (보고서 그룹핑용) */
  card?: string;
  /** 근거가 되는 규칙 문장 (card.json의 description/detailedRule 인용) */
  rule?: string;
  /** 규칙 해석이 애매한 경우의 질문. 이 시나리오는 합격/불합격 대신 "확인 필요"로 보고됩니다. */
  ambiguous?: string;
  /** 시나리오가 의도적으로 일으키는 불변식 위반 코드 (예: 잘못된 입력 테스트) */
  allowViolations?: string[];
  timeoutMs?: number;
}

export interface ScenarioApi {
  game(opts?: GameOptions): Promise<GameCtx>;
  expect(cond: unknown, message: string): void;
  expectEq<T>(actual: T, expected: T, message: string): void;
  /** 관찰한 현재 동작을 기록합니다 (보고서에 그대로 실림). */
  note(message: string): void;
  sleep(ms: number): Promise<void>;
  waitUntil(pred: () => boolean, timeoutMs?: number, label?: string): Promise<void>;
}

export type ScenarioStatus = 'PASS' | 'FAIL' | 'CRASH' | 'ERROR' | 'QUESTION';

export interface ScenarioResult {
  name: string;
  file: string;
  card?: string;
  rule?: string;
  ambiguous?: string;
  status: ScenarioStatus;
  error?: string;
  notes: string[];
  violations: Violation[];
  crashes: string[];
  ms: number;
}

class AssertionFailure extends Error {}

interface Registered {
  name: string;
  meta: ScenarioMeta;
  fn: (t: ScenarioApi) => Promise<void>;
  file: string;
}

const registry: Registered[] = [];
let currentFile = '';

export function setCurrentFile(file: string): void {
  currentFile = file;
}

export function scenario(name: string, meta: ScenarioMeta, fn: (t: ScenarioApi) => Promise<void>): void {
  registry.push({ name, meta, fn, file: currentFile });
}

function fmt(v: unknown): string {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

async function runOne(s: Registered): Promise<ScenarioResult> {
  const srv = await startTestServer();
  const games: GameCtx[] = [];
  const notes: string[] = [];
  const crashBefore = srv.crashes.length;
  const start = Date.now();

  const api: ScenarioApi = {
    game: async (opts) => {
      const g = await createGame(opts);
      games.push(g);
      return g;
    },
    expect: (cond, message) => {
      if (!cond) throw new AssertionFailure(message);
    },
    expectEq: (actual, expected, message) => {
      if (fmt(actual) !== fmt(expected)) {
        throw new AssertionFailure(`${message} — 기대: ${fmt(expected)}, 실제: ${fmt(actual)}`);
      }
    },
    note: (m) => notes.push(m),
    sleep,
    waitUntil,
  };

  let status: ScenarioStatus = 'PASS';
  let error: string | undefined;
  try {
    await Promise.race([
      s.fn(api),
      sleep(s.meta.timeoutMs ?? 20000).then(() => {
        throw new Error(`시나리오 시간 초과 (${s.meta.timeoutMs ?? 20000}ms)`);
      }),
    ]);
  } catch (e: any) {
    if (e instanceof AssertionFailure) {
      status = 'FAIL';
      error = e.message;
    } else {
      status = 'ERROR';
      error = String(e?.message ?? e);
    }
  }

  // 마지막 메시지/타이머가 처리될 시간을 조금 줍니다.
  await sleep(30);
  const violations: Violation[] = [];
  for (const g of games) {
    try {
      g.check();
    } catch {
      /* 방이 이미 없어졌으면 무시 */
    }
    violations.push(...g.tracker.violations);
  }
  for (const g of games) await g.close();

  const crashes = srv.crashes.slice(crashBefore).map((c) => `${c.message}\n${c.stack.split('\n').slice(1, 4).join('\n')}`);
  const allowed = new Set(s.meta.allowViolations ?? []);
  const unexpected = violations.filter((v) => !allowed.has(v.code));

  if (crashes.length > 0) {
    status = 'CRASH';
  } else if (status === 'PASS' && unexpected.some((v) => v.severity !== 'minor')) {
    status = 'FAIL';
    error = `불변식 위반: ${unexpected.filter((v) => v.severity !== 'minor').map((v) => `[${v.code}] ${v.message}`).join(' / ')}`;
  }
  if (s.meta.ambiguous && (status === 'PASS' || status === 'FAIL')) {
    if (status === 'FAIL' && error) notes.push(`(단언 결과) ${error}`);
    status = 'QUESTION';
  }

  return {
    name: s.name,
    file: s.file,
    card: s.meta.card,
    rule: s.meta.rule,
    ambiguous: s.meta.ambiguous,
    status,
    error,
    notes,
    violations: unexpected,
    crashes,
    ms: Date.now() - start,
  };
}

const ICON: Record<ScenarioStatus, string> = { PASS: '✅', FAIL: '❌', CRASH: '💥', ERROR: '⚠️', QUESTION: '❓' };

export async function runScenarios(filter?: string): Promise<ScenarioResult[]> {
  // "a|b|c"처럼 |로 여러 필터를 주면 하나라도 맞는 시나리오를 실행합니다.
  const parts = filter ? filter.split('|').filter(Boolean) : [];
  const matches = (s: Registered) =>
    parts.some((f) => s.name.includes(f) || (s.meta.card ?? '').includes(f) || s.file.includes(f));
  const selected = registry.filter((s) => parts.length === 0 || matches(s));
  const results: ScenarioResult[] = [];
  for (const s of selected) {
    const r = await runOne(s);
    results.push(r);
    const line = `${ICON[r.status]} [${r.card ?? '-'}] ${r.name} (${r.ms}ms)`;
    process.stdout.write(line + '\n');
    if (r.error) process.stdout.write(`     → ${r.error}\n`);
    for (const n of r.notes) process.stdout.write(`     · ${n}\n`);
    for (const c of r.crashes) process.stdout.write(`     💥 ${c.split('\n')[0]}\n`);
  }
  return results;
}

export function writeReport(results: ScenarioResult[], outDir: string, filter?: string): string {
  fs.mkdirSync(outDir, { recursive: true });
  // 필터를 주고 돌리면 별도 파일에 써서, 여러 사람이 동시에 다른 파일을 돌려도 덮어쓰지 않게 합니다.
  const base = !filter ? 'scenarios-latest' : filter.includes('|') ? 'scenarios-selection' : `scenarios-${filter.replace(/[^\w가-힣.-]+/g, '_').slice(0, 60)}`;
  fs.writeFileSync(path.join(outDir, `${base}.json`), JSON.stringify(results, null, 2));

  const count = (st: ScenarioStatus) => results.filter((r) => r.status === st).length;
  const lines: string[] = [];
  lines.push('# 시나리오 테스트 결과', '');
  lines.push(`총 ${results.length}개 — ✅ ${count('PASS')} / ❌ ${count('FAIL')} / 💥 ${count('CRASH')} / ⚠️ ${count('ERROR')} / ❓ ${count('QUESTION')}`, '');
  for (const st of ['CRASH', 'FAIL', 'ERROR', 'QUESTION', 'PASS'] as ScenarioStatus[]) {
    const group = results.filter((r) => r.status === st);
    if (group.length === 0) continue;
    lines.push(`## ${ICON[st]} ${st} (${group.length})`, '');
    for (const r of group) {
      lines.push(`- **[${r.card ?? '-'}] ${r.name}** \`${r.file}\``);
      if (r.rule) lines.push(`  - 규칙: ${r.rule}`);
      if (r.ambiguous) lines.push(`  - 질문: ${r.ambiguous}`);
      if (r.error) lines.push(`  - 결과: ${r.error}`);
      for (const n of r.notes) lines.push(`  - 관찰: ${n}`);
      for (const c of r.crashes) lines.push(`  - 서버 예외: \`${c.split('\n')[0]}\``);
    }
    lines.push('');
  }
  const mdPath = path.join(outDir, `${base}.md`);
  fs.writeFileSync(mdPath, lines.join('\n'));
  return mdPath;
}

export { createGame, GameCtx };
