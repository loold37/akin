import net from 'net';
import type { Server as HttpServer } from 'http';
import type { GameRoom } from '../../src/GameRoom';
import { setTimeScale } from './timescale';

// 실제 서버(src/index.ts)를 테스트 프로세스 안에서 띄웁니다.
// 같은 프로세스이므로 rooms 맵을 직접 들여다보고 덱/패를 조작할 수 있습니다.

export interface CrashRecord {
  at: number;
  kind: 'uncaughtException' | 'unhandledRejection' | 'handlerError';
  message: string;
  stack: string;
}

export interface TestServer {
  url: string;
  port: number;
  rooms: Map<string, GameRoom>;
  crashes: CrashRecord[];
  serverLogs: string[];
  close(): Promise<void>;
}

let instance: TestServer | null = null;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

export async function startTestServer(opts: { timeScale?: number; verbose?: boolean } = {}): Promise<TestServer> {
  if (instance) return instance;

  setTimeScale(opts.timeScale ?? 1);
  const port = await freePort();
  process.env.PORT = String(port);

  const crashes: CrashRecord[] = [];
  const serverLogs: string[] = [];

  // 운영 환경이라면 프로세스가 죽는 예외들입니다. 테스트에서는 기록만 하고 계속 진행합니다.
  process.on('uncaughtException', (err) => {
    crashes.push({ at: Date.now(), kind: 'uncaughtException', message: String(err?.message ?? err), stack: String(err?.stack ?? '') });
  });
  process.on('unhandledRejection', (err: any) => {
    crashes.push({ at: Date.now(), kind: 'unhandledRejection', message: String(err?.message ?? err), stack: String(err?.stack ?? '') });
  });

  // 서버가 핸들러 예외를 잡아 console.error('[핸들러 오류] …')로 남기는 경우도 예외로 기록합니다.
  // (프로세스는 살아남지만 그 핸들러의 처리가 중간에 끊긴 것이므로 여전히 버그입니다.)
  const realError = console.error;
  console.error = (...args: any[]) => {
    const first = String(args[0] ?? '');
    if (first.startsWith('[핸들러 오류]')) {
      const err = args.find((a) => a instanceof Error) as Error | undefined;
      crashes.push({ at: Date.now(), kind: 'handlerError', message: `${first} ${err?.message ?? ''}`.trim(), stack: String(err?.stack ?? '') });
      if (!opts.verbose) return;
    }
    realError(...args);
  };

  const realLog = console.log;
  console.log = (...args: any[]) => {
    const line = args.map(String).join(' ');
    serverLogs.push(line);
    if (serverLogs.length > 2000) serverLogs.splice(0, 1000);
    if (opts.verbose) realLog(...args);
  };

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('../../src/index') as { server: HttpServer; rooms: Map<string, GameRoom>; io: any };
  if (!mod.rooms) {
    throw new Error('src/index.ts가 rooms를 export하지 않습니다. 파일 끝의 `export { app, io, server, rooms }`를 확인하세요.');
  }
  if (!mod.server.listening) {
    await new Promise<void>((resolve) => mod.server.once('listening', () => resolve()));
  }

  instance = {
    url: `http://127.0.0.1:${port}`,
    port,
    rooms: mod.rooms,
    crashes,
    serverLogs,
    close: () =>
      new Promise<void>((resolve) => {
        mod.io.close();
        mod.server.close(() => resolve());
      }),
  };
  return instance;
}
