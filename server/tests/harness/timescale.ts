import util from 'util';

// 서버 코드(server/src)가 직접 건 setTimeout에만 배율을 적용합니다.
// 30초 이벤트 / 60초 턴 / 30초 패 공개 타이머를 테스트에서 수십 배 빠르게 돌리기 위한 장치이며,
// socket.io 내부 타이머나 테스트 코드의 타이머는 건드리지 않습니다.
const SERVER_SRC = /[\\/]server[\\/]src[\\/]/;

let scale = 1;
let installed = false;

export function setTimeScale(next: number): void {
  scale = next;
  install();
}

export function getTimeScale(): number {
  return scale;
}

/** 서버 기준 ms를 실제로 기다려야 하는 ms로 변환합니다. */
export function scaled(serverMs: number): number {
  return Math.max(1, Math.round(serverMs * scale));
}

function install(): void {
  if (installed) return;
  installed = true;

  const realSetTimeout = global.setTimeout;
  const patched = function (handler: any, ms?: number, ...args: any[]) {
    if (scale !== 1 && typeof ms === 'number' && ms > 0) {
      // stack[0] = "Error", [1] = patched, [2] = setTimeout을 호출한 코드
      const callerFrame = (new Error().stack ?? '').split('\n')[2] ?? '';
      if (SERVER_SRC.test(callerFrame)) {
        ms = Math.max(1, Math.round(ms * scale));
      }
    }
    return realSetTimeout(handler, ms, ...args);
  };
  (patched as any)[util.promisify.custom] = (realSetTimeout as any)[util.promisify.custom];
  (global as any).setTimeout = patched;
}

/** Node Timeout 객체가 아직 발화/취소되지 않았는지 확인합니다. */
export function isTimerPending(timer: any): boolean {
  if (!timer) return false;
  return timer._destroyed === false;
}
