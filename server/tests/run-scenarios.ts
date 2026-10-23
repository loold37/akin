import fs from 'fs';
import path from 'path';
import { startTestServer } from './harness/server';
import { runScenarios, setCurrentFile, writeReport, scenario } from './harness/runner';

// 사용법: npm run test:scenarios [-- <카드명/시나리오명/파일명 일부>]
// 서버 타이머를 1/20로 줄여 실행합니다 (30초 이벤트 → 1.5초, 30초 패 공개 → 1.5초).
// 필터가 파일명과 겹치면 그 파일만 불러옵니다. "이름1|이름2"처럼 여러 개를 줄 수도 있습니다.

async function main() {
  const filter = process.argv[2];
  await startTestServer({ timeScale: Number(process.env.TIME_SCALE ?? 0.05), verbose: !!process.env.VERBOSE });

  const dir = path.join(__dirname, 'scenarios');
  const all = fs.readdirSync(dir).filter((f) => f.endsWith('.test.ts')).sort();
  const byName = filter && !filter.includes('|') ? all.filter((f) => f.includes(filter)) : [];
  const files = byName.length ? byName : all;
  for (const file of files) {
    setCurrentFile(file);
    try {
      require(path.join(dir, file));
    } catch (e: any) {
      const message = String(e?.message ?? e).split('\n')[0];
      scenario(`(파일 로드 실패) ${file}`, {}, async () => {
        throw new Error(message);
      });
    }
  }

  const results = await runScenarios(byName.length ? undefined : filter);
  const md = writeReport(results, path.join(__dirname, 'reports'), filter);
  const bad = results.filter((r) => r.status === 'FAIL' || r.status === 'CRASH' || r.status === 'ERROR').length;
  process.stdout.write(`\n보고서: ${path.relative(process.cwd(), md)}\n`);
  process.stdout.write(`결과: ${results.length}개 중 문제 ${bad}개\n`);
  process.exit(bad > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
