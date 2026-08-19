// ── Card Types ──────────────────────────────────────────────────────
export type CardCategory = 'MALICE' | 'TOOL' | 'EVENT';
export type ToolType = 'WEAPON' | 'SHIELD' | 'ITEM' | 'TREASURE';
export type Alignment = 'GOOD' | 'EVIL';

// 모든 카드의 고유 이름 정의 (Union Type)
export type MaliceCardName = 
  | '시선' | '빈상자' | '상처' | '코즈믹 호러' | '흑역사' 
  | '어제의 동료' | '계시' | '사랑이란 변명' | '암전' | '탐욕' 
  | '질투' | '짙은 악의';

export type EventCardName = 
  | '피바라기' | '선택 (善)' | '선택 (惡)' | '카르마' | '예언' 
  | '무장해제' | '빙의' | '난투' | '면죄부' | '룰렛' 
  | '엑스칼리버' | '제물' | '마육검' | '악마의 고해소' | '무소유' 
  | '화살 함정' | '미끼' | '폴터가이스트' | '인체 연성' | '뒤바뀐 영혼' 
  | '천사의 심판대' | '고해성사' | '구덩이' | '선물' | '눈 없는 괴물';

export type WeaponCardName = 
  | '십자가' | '성정' | '황금칼' | '필멸의 창' | '누군가의 뼈' | '교화의 창' | '엑스칼리버' | '마육검';

export type ShieldCardName = 
  | '황금 방패' | '골든 레코드' | '부처님 손바닥' | '수호천사' | '거울 방패' | '누군가의 방패';

export type TreasureCardName = 
  | '성배' | '십자가' | '코인' | '복권' | '교환권' | '누군가의 로켓';

export type ItemCardName = 
  | '독재' | '침묵' | '인연의 끈' | '긴급탈출키트' | '선의' | '스캐빈져' | '인간 방패';

export type ToolCardName = WeaponCardName | ShieldCardName | TreasureCardName | ItemCardName;
export type CardName = MaliceCardName | EventCardName | ToolCardName;

export interface BaseCard {
  id: string;
  cardId?: number; // card.json의 고유 ID (101~612)
  name: CardName;
  description: string;
  detailedRule?: string | null;
}

export interface MaliceCard extends BaseCard {
  category: 'MALICE';
  name: MaliceCardName;
  maliceValue: number;
}

export interface ToolCard extends BaseCard {
  category: 'TOOL';
  name: ToolCardName;
  toolType: ToolType;
  maliceValue: number; // 특수 악의 도구용
  maliceModifier?: number; // 선의 등
  isSpecial: boolean;
}

// 이벤트 카드의 행동 유형 세분화
export type EventActionType = 
  | 'IMMEDIATE_EFFECT' // 단순 효과 적용 후 종료
  | 'REQUIRE_TARGET_SELECT' // 대상 지정 필요 (선택, 뒤바뀐 영혼 등)
  | 'REQUIRE_VOTE' // 전체 투표 필요 (심판대, 고해소, 제물, 구덩이 등)
  | 'REQUIRE_CARD_SUBMISSION' // 카드 제출 필요 (룰렛, 제물 등)
  | 'SILENCE_MODE' // 침묵 모드 돌입 (눈없는 괴물)
  | 'AUCTION' // 경매 진행 (마육검)
  | 'FREE_FOR_ALL' // 난투 등 룰 변경
  | 'WAITING_FOR_DEFENSE' // 방어 대기 (화살 함정 등)
  | 'EXCALIBUR_RACE'; // 엑스칼리버 획득 대기

export interface EventCard extends BaseCard {
  category: 'EVENT';
  name: EventCardName;
  actionType: EventActionType;
}

export type Card = MaliceCard | ToolCard | EventCard;

// ── Player Types ────────────────────────────────────────────────────
export interface PlayerHand {
  malices: MaliceCard[];
  weapons: ToolCard[];
  shields: ToolCard[];
  treasures: ToolCard[];
  items: ToolCard[];
}

export interface Player {
  id: string;
  name: string;
  isAlive: boolean;
  hand: PlayerHand;
  currentMalice: number;
  alignment: Alignment;
  isMyTurn: boolean;
  hasDrawnThisTurn: boolean;
  hasUsedWeaponThisTurn: boolean;
  isSilenced: boolean;
  linkedPlayerId?: string | null; // 인연의 끈
}

// ── Public Info (타인에게 노출되는 정보만) ───────────────────────────
export interface HandCount {
  malices: number;
  weapons: number;
  shields: number;
  treasures: number;
  items: number;
}

export interface PublicPlayerInfo {
  id: string;
  name: string;
  isAlive: boolean;
  handCount: HandCount;
  isMyTurn: boolean;
  isSilenced: boolean;
}

// ── Game State ──────────────────────────────────────────────────────
// 상태 머신 세분화
export type GamePhase = 
  | 'WAITING'         // 로비
  | 'INITIAL_DRAW'    // 시작 시 2장 뽑기
  | 'MAIN'            // 일반 턴 진행 중
  | 'RESOLVING_EVENT' // 이벤트 처리 대기 중 (투표, 타겟 등)
  | 'WAITING_FOR_DEFENSE' // 누군가 공격받아 방패를 낼 수 있는 시간 대기 중
  | 'DEAD_INTERACTION'// 죽은 자의 액션 대기 (폴터가이스트 등)
  | 'ENDED';          // 게임 종료

export interface RevealedCardsInfo {
  playerId: string;
  playerName: string;
  cards: Card[];
  reason: string;
  confirmedPlayerIds: string[];
}

// 각 플레이어에게 전송되는 마스킹된 게임 상태
export interface SanitizedGameState {
  roomCode: string;
  myInfo: {
    hand: PlayerHand;
    currentMalice: number;
    alignment: Alignment;
    hasDrawnThisTurn: boolean;
    hasUsedWeaponThisTurn?: boolean;
  };
  players: PublicPlayerInfo[];
  currentTurnPlayerId: string | null;
  phase: GamePhase;
  deckRemaining: number;
  // 이벤트 진행 상태 등을 추가로 내려보내야 함
  activeEventName?: EventCardName | null;
  activeEventDescription?: string | null;
  activeEventDetailedRule?: string | null;
  defenseTargetId?: string | null;
  defenseInitiatorId?: string | null;
  defenseWeaponName?: string | null;
  defenseSkippedPlayerIds?: string[];
  defenseHasGuardianAngel?: boolean;
  excaliburSkippedPlayerIds?: string[];
  mayukWinnerId?: string | null;
  linkedPlayers?: [string, string] | null;
  silenceMode: boolean;
  freeForAll: boolean;
  actionDeadline?: number | null;
  eventTimeoutSeconds?: number;
  submittedPlayerIds?: string[];
  revealedCardsInfo?: RevealedCardsInfo | null;
  turnDeadline?: number | null;
  turnRemainingSeconds?: number;
  isTurnTimerPaused?: boolean;
}

// ── Draw Result ─────────────────────────────────────────────────────
export interface DrawResult {
  triggeredEvents: EventCard[];
  finalCard: Card | null;
  deckEmpty: boolean;
}

// ── Socket.io Events ────────────────────────────────────────────────
export interface ClientToServerEvents {
  join_room: (roomCode: string, playerName: string) => void;
  start_game: (roomCode: string) => void;
  draw_card: (roomCode: string) => void;
  resume_draw: (roomCode: string) => void; // 연속 드로우용
  end_turn: (roomCode: string) => void;
  play_tool: (roomCode: string, cardId: string, targetId?: string) => void;
  play_shield: (roomCode: string, cardId: string, targetId?: string) => void;
  skip_defense: (roomCode: string) => void; // 방어 포기 (즉시 맞기)
  confirm_reveal: (roomCode: string) => void; // 패 공개 확인 완료
  // 이벤트/투표 상호작용
  submit_vote: (roomCode: string, targetId: string, useDictatorship?: boolean) => void;
  submit_target: (roomCode: string, targetId: string) => void;
  submit_gift: (roomCode: string, cardId: string, targetId: string) => void; // [선물] 카드와 대상 지정
  submit_transmutation: (roomCode: string, targetDeadPlayerId: string, cardIds: string[]) => void; // [인체 연성] 사망자 부활 & 도구 2장
  submit_cards: (roomCode: string, cardIds: string[]) => void;
  claim_excalibur: (roomCode: string) => void; // [엑스칼리버] 전 패 공개 & 획득 도전
  skip_excalibur: (roomCode: string) => void; // [엑스칼리버] 포기
  store_mayuk_sword: (roomCode: string) => void; // [마육검] 패에 보관
  use_mayuk_sword_now: (roomCode: string, targetId: string) => void; // [마육검] 즉시 공격 사용
  cut_fate_link: (roomCode: string, weaponCardId: string) => void; // [인연의 끈] 칼로 끊기
  kill_bait_monster: (roomCode: string, cardId: string) => void; // [미끼] 칼 카드로 괴물 즉시 처치
  submit_prophecy: (roomCode: string, cardIds: string[]) => void; // [예언] 덱 맨 위 카드 순서 재배열
  interrupt_action: (roomCode: string, cardId: string, targetId?: string) => void; // 긴급탈출키트, 인간방패 등
  play_item: (roomCode: string, cardId: string, targetIds?: string[]) => void; // 인연의 끈 등
  send_chat: (roomCode: string, message: string) => void;
  leave_room: (roomCode: string) => void; // 방 나가기
  return_to_lobby: (roomCode: string) => void; // 게임 종료 후 대기실로 복귀
}

export interface PlayerScore {
  playerId: string;
  name: string;
  score: number;
  reason: string;
}

export interface ServerToClientEvents {
  room_state_update: (players: PublicPlayerInfo[]) => void;
  game_state_update: (gameState: SanitizedGameState) => void;
  events_triggered: (events: EventCard[]) => void;
  action_result: (message: string) => void;
  chat_message: (playerName: string, message: string) => void;
  player_died: (playerId: string, playerName: string, revealedHand: PlayerHand) => void;
  game_over: (scores: PlayerScore[]) => void;
  game_started: () => void;
  // 이벤트 UI 요청
  request_vote: (eventName: string, candidates: string[], initiatorId?: string) => void;
  request_target: (eventName: string, validTargets: string[]) => void;
  request_cards: (eventName: string, count: number) => void;
  request_excalibur: (eventName: string) => void;
  request_mayuk_choice: (eventName: string, validTargets: string[]) => void;
  request_prophecy: (eventName: string, cards: Card[], initiatorId: string) => void;
}
