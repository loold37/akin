// 게임 밸런스 상수 — 이 값들만 수정하면 전체 게임 로직이 자동으로 반영됩니다.
export let EVENT_TIMEOUT_SECONDS = 30; // 기본 이벤트 및 액션 제한시간 (30초)
export let EVENT_TIMEOUT_MS = EVENT_TIMEOUT_SECONDS * 1000;

export function setEventTimeoutSeconds(seconds: number): void {
  EVENT_TIMEOUT_SECONDS = seconds;
  EVENT_TIMEOUT_MS = seconds * 1000;
}

export const MALICE_PER_CARD = 1;
export const DEEP_MALICE_VALUE = 2; // 짙은 악의: 악의 2점
export const EVIL_THRESHOLD = 3; // 악의 3점 이상 시 악인 (EVIL) 전환
export const CARDS_PER_PLAYER = 10;
export const INITIAL_DRAW_COUNT = 2;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;
