# 악인 온라인 게임 테스트 도구

실제 서버(`src/index.ts`)를 테스트 프로세스 안에서 띄우고, socket.io 클라이언트(봇)로 접속해 게임을 진행하며 검사합니다.
서버 코드는 수정하지 않고 사용하며, 서버가 직접 건 타이머만 배율을 줄여(기본 1/20) 빠르게 돌립니다.

```bash
cd server
npm run test:scenarios            # 카드별 규칙 시나리오 전체
npm run test:scenarios -- 피바라기  # 카드명/시나리오명/파일명 일부로 필터
npm run test:fuzz                  # 무작위 봇 200판
npm run test:fuzz -- --games 500 --chaos 0.05 --join 0.05 --seed 7
npm run test:crash-proof           # 예외 처리기 없는 실제 서버 프로세스가 정상 UI 조작만으로 죽는지 재현
```

결과는 `tests/reports/`에 Markdown과 JSON으로 저장됩니다(커밋 대상 아님). 퍼즈 보고서 이름은 `fuzz-seed<시드>-chaos<확률>`이며 `--out 이름`으로 바꿀 수 있습니다.

## 두 가지 도구

| 도구 | 하는 일 | 찾는 문제 |
|---|---|---|
| 시나리오 테스트 (`tests/scenarios/*.test.ts`) | 패·덱·차례를 원하는 상태로 만들어 놓고 카드 하나의 효과를 단계별로 확인 | 카드 효과가 `card.json` 규칙과 다른 경우 |
| 퍼즈 테스트 (`tests/fuzz/`) | 2~6명의 무작위 봇이 게임을 끝까지 수백 판 진행. 일부 봇은 잠수하거나 잘못된 입력을 보내고, 중간에 나가거나 들어옴 | 서버 예외(운영에서는 서버 종료), 게임 멈춤, 카드 증발, 차례 꼬임 |

두 도구 모두 매 순간 **불변식**(`harness/invariants.ts`)을 검사합니다.
예: 카드 보존, 패와 악의 점수 일치, MAIN 단계에서 턴 타이머가 살아 있는지, 대기 중 액션에 제한시간이 있는지, 차례가 다음 생존자에게 넘어가는지, 게임 종료 후 상태가 바뀌지 않는지.

## 시나리오 결과 읽는 법

- ✅ PASS: 규칙대로 동작
- ❌ FAIL: 단언 실패 또는 불변식 위반 = **현재 구현이 규칙과 다름 (버그)**
- 💥 CRASH: 서버 핸들러에서 잡히지 않은 예외 발생. 운영 서버라면 프로세스가 죽어 모든 방이 끊깁니다
- ⚠️ ERROR: 기다리던 일이 일어나지 않음(시간 초과 등). 서버가 멈췄거나 테스트가 잘못됐을 수 있음
- ❓ QUESTION: 규칙 해석이 애매해 판정 대신 현재 동작을 기록한 항목

## 시나리오 작성법

```ts
import { scenario } from '../harness/runner';

scenario('피바라기: 방어하지 않으면 지목된 생존자가 죽는다', {
  card: '피바라기',
  rule: '지금 이 검을 다른 생존자에게 사용해야만 합니다. 단, 이 검도 방패로 막을 수 있습니다.',
}, async (t) => {
  const g = await t.game({
    players: 3,
    hands: { 1: ['황금 방패'] },  // 플레이어 번호 → 패
    deck: ['피바라기'],           // 덱 맨 위부터 (첫 번째가 다음 드로우)
  });
  g.c(0).act('draw_card');                              // 0번이 카드를 뽑음 (roomCode 자동)
  await g.waitFor(() => g.requests(0, 'request_target').length > 0, '대상 선택 요청');
  g.c(0).act('submit_target', g.c(2).id);
  await g.waitPhase('WAITING_FOR_DEFENSE');
  g.c(2).act('skip_defense');
  await g.waitFor(() => !g.p(2).isAlive, '2번 사망');
  t.expect(g.p(1).isAlive, '1번은 살아 있어야 함');
});
```

### `t.game(options)` → `GameCtx`

| 옵션 | 기본값 | 설명 |
|---|---|---|
| `players` | 3 | 인원 (이름: 가람, 나래, 다온, 라온, 마루, 바다) |
| `hands` | 모두 빈 패 | `{ 0: ['시선', '성정'] }`. 이름이 겹치는 카드는 번호로: `'십자가#201'`(무기), `'십자가#502'`(보물) |
| `deck` | `[]` | 덱 맨 위부터의 카드. 그 아래에 `filler`장의 `코인`이 깔림 |
| `filler` | 10 | 덱 아래 무해한 카드 수 (0이면 `deck`만 남음) |
| `turn` | 0 | 누구의 차례로 시작할지 |
| `hasDrawn` | false | 현재 차례 플레이어가 이미 뽑은 상태로 시작 |
| `dead` | `[]` | 죽은 상태로 시작할 플레이어 번호 (패는 그대로) |
| `eventTimeoutMs` | 30000 | 서버 기준 이벤트 제한시간 |
| `turnDurationMs` | 600000 | 서버 기준 턴 제한시간. 시나리오 도중 턴이 넘어가지 않게 길게 잡혀 있음 |

### `GameCtx`

| 이름 | 설명 |
|---|---|
| `g.c(i)` | i번 플레이어의 소켓 클라이언트. `act(ev, ...args)`는 roomCode를 붙여 emit, `raw(ev, ...args)`는 그대로 emit |
| `g.p(i)` | i번 플레이어의 **서버 쪽** Player 객체 (`isAlive`, `hand`, `currentMalice`, `alignment` 등 실시간) |
| `g.room` | 서버 GameRoom 객체 (`phase`, `pendingAction`, `deck`, `graveyard`, `currentTurnPlayerId` …) |
| `g.hand(i)` / `g.handCards(i)` | i번 패의 카드 이름 / 카드 객체 |
| `g.cardId(i, name)` | i번 패에서 이름으로 카드 id 찾기 |
| `g.give(i, ...cards)` / `g.setDeck(cards)` | 진행 중에 패/덱 추가 조작 |
| `g.waitFor(pred, label)` / `g.waitPhase(phase)` | 조건이 될 때까지 대기 (기본 3초, 넘으면 ERROR) |
| `g.settle()` | 모든 클라이언트가 잠시 조용해질 때까지 대기 (“아무 일도 안 일어나야 한다”를 확인할 때) |
| `g.waitServerMs(30000)` | 서버 기준 30초 제한시간이 지나도록 대기 (실제로는 1.5초) |
| `g.requests(i, 'request_vote')` | i번이 받은 요청 이벤트들의 인자 목록 |
| `g.msgs(i)` | i번이 받은 action_result / 채팅 메시지 |
| `g.indexOf(socketId)` | 소켓 id → 플레이어 번호 |

### `t`

`t.expect(cond, msg)`, `t.expectEq(actual, expected, msg)`, `t.note(msg)`(관찰 기록), `t.sleep(ms)`.

### 시나리오 메타

- `card`, `rule`: 보고서 그룹핑과 근거 문장
- `ambiguous: '질문'`: 규칙이 애매하면 단언 대신 `t.note()`로 현재 동작을 남기고 이 필드에 질문을 적습니다
- `allowViolations: ['CARD_LOST']`: 일부러 일으키는 불변식 위반 코드

## 퍼즈 옵션

`--games` 판 수, `--concurrency` 동시 방 수, `--seed` 시드, `--min/--max` 인원, `--chaos` 잘못된 입력 확률, `--afk` 잠수 확률, `--leave` 중간 퇴장 확률, `--join` 중간 입장 확률, `--scale` 타이머 배율(기본 0.01), `--stuck` 멈춤 판정 ms.
보고서에는 위반 종류별 발생 판 수, 시드, 직전 로그 30줄이 들어 있어 같은 시드로 다시 돌려 볼 수 있습니다(소켓 타이밍 때문에 완전히 같지는 않음).

## 구조

```
tests/
  harness/  server.ts(서버 기동·예외 수집) client.ts(소켓 클라이언트) game.ts(게임 셋업·리깅)
            cards.ts(카드 팩토리) invariants.ts(불변식) timescale.ts(타이머 배율) runner.ts(러너·보고서)
  scenarios/ 카드별 시나리오
  fuzz/      bot.ts(무작위 봇) fuzz.ts(퍼즈 러너)
  crash-proof.ts  실제 서버 프로세스를 자식으로 띄워 크래시 재현
```

서버 쪽 변경은 `src/index.ts` 마지막의 `export { app, io, server, rooms }` 한 줄뿐입니다(동작 변화 없음).
