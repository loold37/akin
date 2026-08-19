import {
  Player, Card, GamePhase, ToolCard,
  EventCard, DrawResult, EventCardName,
  SanitizedGameState, PublicPlayerInfo, HandCount, PlayerScore
} from '../../shared/types';
import { generateDeck } from './Deck';
import {
  EVIL_THRESHOLD, MALICE_PER_CARD, CARDS_PER_PLAYER,
  INITIAL_DRAW_COUNT, MIN_PLAYERS,
  EVENT_TIMEOUT_MS, EVENT_TIMEOUT_SECONDS,
} from './constants';
import crypto from 'crypto';

// 상태 머신에서 발생할 수 있는 비동기 대기 이벤트를 다루기 위한 내부 인터페이스
interface PendingAction {
  type: 'VOTE' | 'DEFENSE' | 'CARD_SUBMISSION' | 'TARGET_SELECTION';
  eventName: EventCardName | null;
  initiatorId: string | null;
  targetId: string | null;
  deadline: number;
  responses: Record<string, any>; // 응답 (예: targetId, cardIds, 객체 등)
  weaponCard?: Card; // 추가: 필멸의 창 등 무기 능력을 추적하기 위함
  skippedPlayerIds?: string[]; // 방어 포기(스킵)를 누른 플레이어 목록
  prophecyCards?: Card[]; // [예언] 확인 및 재배치할 덱 맨 위 카드들
  resolve: () => void;
  timer: NodeJS.Timeout | null;
}

export class GameRoom {
  public roomCode: string;
  public players: Player[] = [];
  public deck: Card[] = [];
  public graveyard: Card[] = [];
  public phase: GamePhase = 'WAITING';
  public eventTimeoutMs: number = EVENT_TIMEOUT_MS;
  
  public silenceMode: boolean = false;
  public silenceTurnCount: number = 0;
  public freeForAll: boolean = false;
  private isResolvingAction: boolean = false;
  
  public onGameOver: ((scores: PlayerScore[]) => void) | null = null;
  public onActionRequest: ((action: PendingAction) => void) | null = null;
  public onStateChange: (() => void) | null = null;
  public onBroadcastMessage: ((msg: string) => void) | null = null;
  public onPrivateMessage: ((playerId: string, msg: string) => void) | null = null;

  public returnToMainPhase(): void {
    if (this.phase === 'ENDED' || this.checkLastSurvivor()) {
      if (this.phase !== 'ENDED') {
        const scores = this.handleLastSurvivor();
        if (this.onGameOver) this.onGameOver(scores);
      }
      this.activeEvent = null;
      this.pendingAction = null;
      if (this.onStateChange) {
        this.onStateChange();
      }
      return;
    }

    this.phase = 'MAIN';
    this.activeEvent = null;
    this.pendingAction = null;
    
    // 이벤트나 난투가 끝난 직후, 현재 턴 진행자가 죽어있다면 턴을 넘겨 데드락을 방지합니다.
    if (this.currentTurnPlayerId) {
      const currentPlayer = this.getPlayerById(this.currentTurnPlayerId);
      if (!currentPlayer || !currentPlayer.isAlive) {
        this.nextTurn();
      } else {
        this.resumeTurnTimer();
      }
    } else {
      this.resumeTurnTimer();
    }

    if (this.onStateChange) {
      this.onStateChange();
    }
  }

  public currentTurnPlayerId: string | null = null;
  
  // 상태 머신 확장을 위한 속성
  public activeEvent: EventCard | null = null;
  public pendingAction: PendingAction | null = null;
  public interruptStack: Array<{ playerId: string, cardId: string }> = [];
  public linkedPlayers: [string, string] | null = null; // 인연의 끈

  public turnDurationMs: number = 60000;
  public turnRemainingMs: number = 60000;
  public turnDeadline: number | null = null;
  public turnTimer: NodeJS.Timeout | null = null;
  public isTurnTimerPaused: boolean = false;

  public startTurnTimer(durationMs: number = 60000): void {
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.turnRemainingMs = durationMs;
    this.turnDeadline = Date.now() + durationMs;
    this.isTurnTimerPaused = false;

    this.turnTimer = setTimeout(() => {
      this.handleTurnTimeout();
    }, durationMs);
  }

  public pauseTurnTimer(): void {
    if (this.isTurnTimerPaused || this.phase === 'ENDED' || this.phase === 'WAITING') return;
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
    if (this.turnDeadline) {
      this.turnRemainingMs = Math.max(1000, this.turnDeadline - Date.now());
    }
    this.isTurnTimerPaused = true;
  }

  public resumeTurnTimer(): void {
    if (!this.isTurnTimerPaused || this.phase !== 'MAIN') return;
    this.startTurnTimer(this.turnRemainingMs);
  }

  public handleTurnTimeout(): void {
    if (this.phase !== 'MAIN') return;
    const currentPlayer = this.currentTurnPlayerId ? this.getPlayerById(this.currentTurnPlayerId) : null;
    if (currentPlayer) {
      if (this.onBroadcastMessage) {
        this.onBroadcastMessage(`⏰ [시간 초과] [${currentPlayer.name}] 님의 60초 턴 제한시간이 초과되어 차례가 종료되었습니다.`);
      }
    }
    this.nextTurn();
    if (this.onStateChange) this.onStateChange();
  }

  private currentTurnIndex: number = 0;

  constructor(roomCode: string) {
    this.roomCode = roomCode;
  }

  // ── Player Management ───────────────────────────────────────────

  public addPlayer(id: string, name: string): Player {
    const newPlayer: Player = {
      id,
      name,
      isAlive: true,
      hand: { malices: [], weapons: [], shields: [], treasures: [], items: [] },
      currentMalice: 0,
      alignment: 'GOOD',
      isMyTurn: false,
      hasDrawnThisTurn: false,
      hasUsedWeaponThisTurn: false,
      isSilenced: false,
    };
    this.players.push(newPlayer);
    return newPlayer;
  }

  public removePlayer(id: string): void {
    const idx = this.players.findIndex(p => p.id === id);
    if (idx === -1) return;

    if (this.linkedPlayers && this.linkedPlayers.includes(id)) {
      this.linkedPlayers = null;
    }

    this.players.splice(idx, 1);

    if (this.players.length > 0 && this.currentTurnIndex >= this.players.length) {
      this.currentTurnIndex = 0;
    }

    if (this.phase === 'MAIN' && this.currentTurnPlayerId === id && !this.checkLastSurvivor()) {
      this.nextTurn();
    }
  }

  public getPlayerById(id: string): Player | undefined {
    return this.players.find(p => p.id === id);
  }

  public getAlivePlayers(): Player[] {
    return this.players.filter(p => p.isAlive);
  }

  public killPlayer(playerId: string, emitMsg?: (msg: string) => void): void {
    const player = this.getPlayerById(playerId);
    if (!player || !player.isAlive) return;

    player.isAlive = false;

    // 인연의 끈 처리: 링크를 먼저 null로 초기화하여 순환 재귀 및 유령 상태 방지
    if (this.linkedPlayers) {
      const linked = this.linkedPlayers;
      this.linkedPlayers = null;
      if (linked[0] === playerId) {
         const partner = this.getPlayerById(linked[1]);
         if (partner && partner.isAlive) {
           if (emitMsg) emitMsg(`🔗 인연의 끈으로 인해 ${partner.name}님도 함께 운명을 맞이했습니다.`);
           this.killPlayer(partner.id, emitMsg);
         }
      } else if (linked[1] === playerId) {
         const partner = this.getPlayerById(linked[0]);
         if (partner && partner.isAlive) {
           if (emitMsg) emitMsg(`🔗 인연의 끈으로 인해 ${partner.name}님도 함께 운명을 맞이했습니다.`);
           this.killPlayer(partner.id, emitMsg);
         }
      }
    }

    // 스캐빈져 처리 (Task 5)
    const alivePlayers = this.getAlivePlayers();
    let scavengerOwner = null;
    let scavengerCardId = null;
    for (const p of alivePlayers) {
       const sIdx = p.hand.items.findIndex(c => c.name === '스캐빈져');
       if (sIdx !== -1) {
          scavengerOwner = p;
          scavengerCardId = p.hand.items[sIdx].id;
          break;
       }
    }

    if (scavengerOwner && scavengerCardId) {
       this.removeCardFromHand(scavengerOwner, scavengerCardId);
       
       const allDeadCards = [
         ...player.hand.malices,
         ...player.hand.weapons,
         ...player.hand.shields,
         ...player.hand.treasures,
         ...player.hand.items,
       ];
       for (const c of allDeadCards) {
         this.addCardToHand(scavengerOwner, c);
       }
       player.hand = { malices: [], weapons: [], shields: [], treasures: [], items: [] };
       
       this.recalculateMalice(scavengerOwner);
       this.recalculateMalice(player);
       
       if (emitMsg) {
         emitMsg(`🦅 ${scavengerOwner.name}님이 스캐빈져를 발동하여 ${player.name}님의 유품을 모두 챙겼습니다!`);
       }
    }

    if (this.silenceMode) {
      this.silenceMode = false;
      if (emitMsg) emitMsg('👻 누군가의 비명 소리와 함께 눈 없는 괴물이 물러갔습니다...');
    }

    if (this.pendingAction && !this.isResolvingAction) {
      const currentAlive = this.getAlivePlayers().length;
      if (this.pendingAction.type === 'DEFENSE') {
        // 방어 대기 중 타겟이 사망하면 즉시 방어 단계 해소
        if (this.pendingAction.targetId === playerId) {
          this.pendingAction.resolve();
        }
      } else if (this.pendingAction.type === 'VOTE' || this.pendingAction.type === 'CARD_SUBMISSION' || this.pendingAction.type === 'TARGET_SELECTION') {
        if (Object.keys(this.pendingAction.responses).length >= currentAlive) {
          this.pendingAction.resolve();
        }
      }
    }

    // 모든 사망 처리가 끝난 후, 생존자가 1명 이하면 즉시 게임 종료 판정
    if (this.phase !== 'ENDED' && this.checkLastSurvivor()) {
      const scores = this.handleLastSurvivor();
      if (this.onGameOver) this.onGameOver(scores);
    } else if (this.phase === 'MAIN' && this.currentTurnPlayerId === playerId) {
      // 턴 주인이 MAIN 페이즈 중 사망한 경우 즉시 다음 턴으로 넘겨 데드락 방지
      this.nextTurn();
    }
  }

  // ── Game Lifecycle ──────────────────────────────────────────────

  public startGame(): boolean {
    if (this.players.length < MIN_PLAYERS) return false;

    if (this.pendingAction?.timer) clearTimeout(this.pendingAction.timer);

    this.silenceMode = false;
    this.freeForAll = false;
    this.linkedPlayers = null;
    this.activeEvent = null;
    this.pendingAction = null;

    for (const player of this.players) {
      player.isAlive = true;
      player.hand = { malices: [], weapons: [], shields: [], treasures: [], items: [] };
      player.currentMalice = 0;
      player.alignment = 'GOOD';
      player.isMyTurn = false;
      player.hasDrawnThisTurn = false;
      player.hasUsedWeaponThisTurn = false;
      player.isSilenced = false;
      player.linkedPlayerId = null;
    }

    this.phase = 'INITIAL_DRAW';

    const fullDeck = generateDeck();
    const deckSize = this.players.length * CARDS_PER_PLAYER;
    this.deck = fullDeck.slice(0, Math.min(deckSize, fullDeck.length));
    this.graveyard = [];

    // 초기 2장 드로우 (이벤트는 자동 폐기)
    for (const player of this.players) {
      this.drawInitialCards(player);
    }

    this.phase = 'MAIN';
    this.currentTurnIndex = 0;
    this.currentTurnPlayerId = this.players[0].id;
    this.updatePlayerTurns();
    this.startTurnTimer(this.turnDurationMs);
    return true;
  }

  public resetToLobby(): void {
    if (this.pendingAction?.timer) clearTimeout(this.pendingAction.timer);
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.turnTimer = null;
    this.turnDeadline = null;
    this.isTurnTimerPaused = false;
    this.phase = 'WAITING';
    this.deck = [];
    this.graveyard = [];
    this.currentTurnIndex = 0;
    this.currentTurnPlayerId = null;
    this.activeEvent = null;
    this.pendingAction = null;
    this.silenceMode = false;
    this.freeForAll = false;
    this.linkedPlayers = null;

    for (const p of this.players) {
      p.isAlive = true;
      p.hand = { malices: [], weapons: [], shields: [], treasures: [], items: [] };
      p.currentMalice = 0;
      p.alignment = 'GOOD';
      p.isMyTurn = false;
      p.hasDrawnThisTurn = false;
      p.hasUsedWeaponThisTurn = false;
      p.isSilenced = false;
      p.linkedPlayerId = null;
    }
  }

  private drawInitialCards(player: Player): void {
    let validCards = 0;
    while (validCards < INITIAL_DRAW_COUNT && this.deck.length > 0) {
      const card = this.deck.pop()!;

      if (card.category === 'EVENT') {
        this.graveyard.push(card);
      } else {
        this.addCardToHand(player, card);
        validCards++;
      }
    }
    this.recalculateMalice(player);
  }

  // ── Card Draw (이벤트 발동 트리거) ──────────────────────────────

  public drawCardWithEvents(playerId: string): DrawResult | null {
    if (this.phase !== 'MAIN') return null;
    if (this.currentTurnPlayerId !== playerId) return null;

    const player = this.getPlayerById(playerId);
    if (!player || !player.isAlive) return null;
    if (player.hasDrawnThisTurn) return null;

    const triggeredEvents: EventCard[] = [];

    while (this.deck.length > 0) {
      const card = this.deck.pop()!;

      if (card.category === 'EVENT') {
        triggeredEvents.push(card);
        this.graveyard.push(card);
        
        // 이벤트가 뽑히면 즉시 스택을 정지하고 이벤트를 처리 상태로 넘겨야 함.
        // 현재는 첫 이벤트에서 멈추고 RESOLVING_EVENT 페이즈로 전환하도록 구조 변경
        this.startEventResolution(player, card);
        return {
          triggeredEvents: [card], // 하나씩 처리하도록 변경
          finalCard: null,
          deckEmpty: false,
        };
      } else {
        this.addCardToHand(player, card);
        this.recalculateMalice(player);
        player.hasDrawnThisTurn = true; // 최종 카드 획득 시 드로우 종료
        return {
          triggeredEvents,
          finalCard: card,
          deckEmpty: this.deck.length === 0,
        };
      }
    }

    this.endRound();
    return { triggeredEvents, finalCard: null, deckEmpty: true };
  }

  // ── Event State Machine ─────────────────────────────────────────
  
  private startEventResolution(initiator: Player, eventCard: EventCard): void {
    this.pauseTurnTimer();
    this.phase = 'RESOLVING_EVENT';
    this.activeEvent = eventCard;
    
    if (eventCard.name === '마육검') {
      this.setupMayukSwordAuction(initiator, eventCard);
      return;
    }
    if (eventCard.name === '무소유') {
      this.setupNonPossession(initiator, eventCard);
      return;
    }

    switch(eventCard.actionType) {
      case 'IMMEDIATE_EFFECT':
        // 단순 효과는 즉시 적용 후 다시 MAIN(또는 남은 이벤트 처리)로 복귀
        this.resolveImmediateEvent(initiator, eventCard);
        break;
      case 'REQUIRE_VOTE':
        this.setupVoting(initiator, eventCard);
        break;
      case 'REQUIRE_TARGET_SELECT':
        if (eventCard.name === '선물') {
          this.setupGiftSelection(initiator, eventCard);
        } else {
          this.setupTargetSelection(initiator, eventCard);
        }
        break;
      case 'REQUIRE_CARD_SUBMISSION':
        if (eventCard.name === '무장해제') {
          this.setupDisarmEvent(initiator, eventCard);
        } else if (eventCard.name === '면죄부') {
          this.setupIndulgenceEvent(initiator, eventCard);
        } else if (eventCard.name === '인체 연성') {
          const deadPlayers = this.players.filter(p => !p.isAlive);
          if (deadPlayers.length === 0) {
            if (this.onBroadcastMessage) {
              this.onBroadcastMessage(`💀 부활시킬 사망자가 없어 [인체 연성]이 효과 없이 종료되었습니다.`);
            }
            this.returnToMainPhase();
          } else {
            this.setupTransmutationSubmission(eventCard);
          }
        } else {
          this.setupCardSubmission(eventCard);
        }
        break;
      case 'WAITING_FOR_DEFENSE':
        this.setupDefense(initiator, eventCard);
        break;
      case 'EXCALIBUR_RACE':
        this.setupExcaliburRace(eventCard);
        break;
      case 'SILENCE_MODE':
        this.silenceMode = true;
        this.silenceTurnCount = this.getAlivePlayers().length; // 한 바퀴(현재 생존자 수)
        this.returnToMainPhase();
        break;
      case 'AUCTION':
        this.setupNonPossession(initiator, eventCard);
        break;
      case 'FREE_FOR_ALL':
        this.freeForAll = true;
        this.returnToMainPhase();
        break;
    }
  }

  private setupNonPossession(initiator: Player, eventCard: EventCard): void {
    const timeoutMs = 3000;
    const action: PendingAction = {
      type: 'CARD_SUBMISSION',
      eventName: eventCard.name,
      initiatorId: initiator.id,
      targetId: null,
      deadline: Date.now() + timeoutMs,
      responses: {},
      resolve: () => {
        if (this.pendingAction?.timer) clearTimeout(this.pendingAction.timer);

        const otherAlive = this.getAlivePlayers().filter(p => p.id !== initiator.id);
        const allCards = [
          ...initiator.hand.malices,
          ...initiator.hand.weapons,
          ...initiator.hand.shields,
          ...initiator.hand.treasures,
          ...initiator.hand.items
        ];
        // 섞어서 하나씩 분배
        const shuffledCards = this.shuffleArray(allCards);
        initiator.hand = { malices: [], weapons: [], shields: [], treasures: [], items: [] }; // 일단 다 비움
        
        let cardIdx = 0;
        let playerIdx = 0;
        
        if (otherAlive.length > 0) {
          while (cardIdx < shuffledCards.length) {
            const p = otherAlive[playerIdx % otherAlive.length];
            this.addCardToHand(p, shuffledCards[cardIdx++]);
            playerIdx++;
          }
          for (const p of otherAlive) {
            this.recalculateMalice(p);
          }
        } else {
          // 혼자 살아있다면 남은 카드는 모두 자신에게 반환
          while (cardIdx < shuffledCards.length) {
            this.addCardToHand(initiator, shuffledCards[cardIdx++]);
          }
        }
        
        this.recalculateMalice(initiator);
        if (this.onBroadcastMessage) {
          this.onBroadcastMessage(`✨ [무소유] ${initiator.name}님의 패(${allCards.length}장)가 생존자들에게 모두 분배되었습니다.`);
        }
        this.returnToMainPhase();
      },
      timer: null
    };

    action.timer = setTimeout(() => {
      if (this.pendingAction === action) action.resolve();
    }, timeoutMs);

    this.pendingAction = action;
    if (this.onBroadcastMessage) {
      this.onBroadcastMessage(`🎴 [무소유] ${initiator.name}님이 [무소유]를 뽑았습니다! 3초 후 모든 생존자들에게 패가 분배됩니다.`);
    }
    if (this.onActionRequest) this.onActionRequest(action);
  }

  private setupDefense(initiator: Player, eventCard: EventCard): void {
    this.phase = 'WAITING_FOR_DEFENSE';
    const action: PendingAction = {
      type: 'DEFENSE',
      eventName: eventCard.name,
      initiatorId: initiator.id,
      targetId: initiator.id, // 화살 함정을 밟은 본인이 기본 피격 대상
      deadline: Date.now() + this.eventTimeoutMs,
      responses: {},
      resolve: () => {
        if (this.pendingAction?.timer) clearTimeout(this.pendingAction.timer);
        
        const defended = Object.keys(this.pendingAction!.responses).length > 0;
        if (!defended) {
          if (eventCard.name === '화살 함정') {
            const actualVictimId = this.pendingAction?.targetId || initiator.id;
            this.killPlayer(actualVictimId);
          } else if (eventCard.name === '미끼') {
            this.setupVoting(initiator, eventCard); // 2단계 투표로 전환
            return;
          }
        }

        this.returnToMainPhase();
      },
      timer: null
    };
    action.timer = setTimeout(() => {
      if (this.pendingAction === action) action.resolve();
    }, this.eventTimeoutMs);
    this.pendingAction = action;
    if (this.onActionRequest) this.onActionRequest(action);
  }

  private setupExcaliburRace(eventCard: EventCard): void {
    const action: PendingAction = {
      type: 'CARD_SUBMISSION',
      eventName: eventCard.name,
      initiatorId: null,
      targetId: null,
      deadline: Date.now() + this.eventTimeoutMs,
      responses: {},
      skippedPlayerIds: [],
      resolve: () => {
        if (this.pendingAction?.timer) clearTimeout(this.pendingAction.timer);
        this.returnToMainPhase();
      },
      timer: null
    };
    action.timer = setTimeout(() => {
      if (this.pendingAction === action) action.resolve();
    }, this.eventTimeoutMs);
    this.pendingAction = action;
    if (this.onActionRequest) this.onActionRequest(action);
  }

  private setupMayukSwordAuction(initiator: Player, eventCard: EventCard): void {
    const action: PendingAction = {
      type: 'CARD_SUBMISSION',
      eventName: eventCard.name,
      initiatorId: initiator.id,
      targetId: null,
      deadline: Date.now() + this.eventTimeoutMs,
      responses: {},
      resolve: () => {
        if (this.pendingAction?.timer) clearTimeout(this.pendingAction.timer);

        const alivePlayers = this.getAlivePlayers();
        let maxMaliceBid = 0;
        let earliestSubmitTime = Infinity;
        let winner: Player | null = null;

        for (const player of alivePlayers) {
          const submittedResponse = this.pendingAction?.responses[player.id];
          const submitted = (Array.isArray(submittedResponse) ? submittedResponse : submittedResponse?.cards || []) as Card[];
          const submitTime = (submittedResponse as any)?.submittedAt || (submitted as any)?.submittedAt || Date.now();

          // 제출된 카드들을 다시 본인 패로 복구 (악의를 '공개'하는 경매이므로 카드가 파괴되지 않음)
          for (const card of submitted) {
            this.addCardToHand(player, card);
          }
          this.recalculateMalice(player);

          // 악의 포인트 계산: 순수 악의 + 도구 겸용 악의(누군가의 ~) 점수 합산
          const maliceScore = submitted.reduce((sum: number, c: any) => {
            if (c.name === '짙은 악의') return sum + 2;
            if (c.maliceValue && c.maliceValue > 0) return sum + c.maliceValue;
            if (c.evilScore && c.evilScore > 0) return sum + c.evilScore;
            if (c.category === 'MALICE') return sum + 1;
            return sum;
          }, 0);

          if (maliceScore > maxMaliceBid) {
            maxMaliceBid = maliceScore;
            earliestSubmitTime = submitTime;
            winner = player;
          } else if (maliceScore === maxMaliceBid && maliceScore > 0) {
            // 악의 점수가 동률인 경우 먼저 제출한 플레이어가 우선
            if (submitTime < earliestSubmitTime) {
              earliestSubmitTime = submitTime;
              winner = player;
            }
          }
        }

        if (winner && maxMaliceBid > 0) {
          if (this.onBroadcastMessage) {
            this.onBroadcastMessage(`🩸 ${winner.name}님이 악의 ${maxMaliceBid}포인트를 공개하여 [마육검]을 쟁취했습니다!`);
          }
          // 2단계: 낙찰자의 마육검 사용 여부 선택 (즉시 공격 vs 패에 보관)
          this.setupMayukChoice(winner, eventCard);
        } else {
          if (this.onBroadcastMessage) {
            this.onBroadcastMessage('💨 아무도 악의를 입찰하지 않아 마육검이 어둠 속으로 사라졌습니다.');
          }
          this.returnToMainPhase();
        }
      },
      timer: null
    };

    action.timer = setTimeout(() => {
      if (this.pendingAction === action) action.resolve();
    }, this.eventTimeoutMs);
    this.pendingAction = action;
    if (this.onActionRequest) this.onActionRequest(action);
  }

  public setupMayukChoice(winner: Player, eventCard: EventCard): void {
    const action: PendingAction = {
      type: 'TARGET_SELECTION',
      eventName: eventCard.name,
      initiatorId: winner.id,
      targetId: null,
      deadline: Date.now() + this.eventTimeoutMs,
      responses: {},
      resolve: () => {
        if (this.pendingAction?.timer) clearTimeout(this.pendingAction.timer);
        // 시간 초과 시 자동으로 패에 보관
        const mayukCard: ToolCard = {
          id: 'mayuk_' + Date.now(),
          cardId: 113,
          category: 'TOOL',
          toolType: 'WEAPON',
          name: '마육검',
          description: '악의 경매로 획득한 마육검입니다.',
          detailedRule: '획득하여 즉시 사용할 때만 무기 공격 횟수를 소모하지 않습니다.',
          isSpecial: true,
          maliceValue: 0
        };
        this.addCardToHand(winner, mayukCard);
        this.recalculateMalice(winner);
        if (this.onBroadcastMessage) {
          this.onBroadcastMessage(`📥 시간 초과로 ${winner.name}님의 패에 [마육검]이 일반 무기로 보관되었습니다.`);
        }
        this.returnToMainPhase();
      },
      timer: null
    };

    action.timer = setTimeout(() => {
      if (this.pendingAction === action) action.resolve();
    }, this.eventTimeoutMs);
    this.pendingAction = action;
    if (this.onActionRequest) this.onActionRequest(action);
  }
  
  public setupDisarmEvent(initiator: Player, eventCard: EventCard): void {
    this.phase = 'RESOLVING_EVENT';
    this.activeEvent = eventCard;
    const action: PendingAction = {
      type: 'CARD_SUBMISSION',
      eventName: '무장해제',
      initiatorId: initiator.id,
      targetId: null,
      deadline: Date.now() + this.eventTimeoutMs,
      responses: {},
      resolve: () => {
        if (action.timer) clearTimeout(action.timer);
        this.returnToMainPhase();
      },
      timer: null
    };

    action.timer = setTimeout(() => {
      if (this.pendingAction === action) action.resolve();
    }, this.eventTimeoutMs);
    this.pendingAction = action;
    if (this.onActionRequest) this.onActionRequest(action);
  }

  public setupIndulgenceEvent(initiator: Player, eventCard: EventCard): void {
    this.phase = 'RESOLVING_EVENT';
    this.activeEvent = eventCard;
    const action: PendingAction = {
      type: 'CARD_SUBMISSION',
      eventName: '면죄부',
      initiatorId: initiator.id,
      targetId: null,
      deadline: Date.now() + this.eventTimeoutMs,
      responses: {},
      resolve: () => {
        if (action.timer) clearTimeout(action.timer);
        this.returnToMainPhase();
      },
      timer: null
    };

    action.timer = setTimeout(() => {
      if (this.pendingAction === action) action.resolve();
    }, this.eventTimeoutMs);
    this.pendingAction = action;
    if (this.onActionRequest) this.onActionRequest(action);
  }

  public setupTransmutationSubmission(eventCard: EventCard): void {
    this.phase = 'RESOLVING_EVENT';
    this.activeEvent = eventCard;
    const action: PendingAction = {
      type: 'CARD_SUBMISSION',
      eventName: '인체 연성',
      initiatorId: null,
      targetId: null,
      deadline: Date.now() + this.eventTimeoutMs,
      responses: {},
      resolve: () => {
        if (this.pendingAction?.timer) clearTimeout(this.pendingAction.timer);

        const alivePlayers = this.getAlivePlayers();
        const submittedCards = Object.values(this.pendingAction!.responses).flat() as Card[];

        if (submittedCards.length < alivePlayers.length) {
          // 실패: 낸 카드들 다시 돌려주기
          for (const [pId, cards] of Object.entries(this.pendingAction!.responses)) {
            const p = this.getPlayerById(pId);
            if (p) {
              (cards as Card[]).forEach(c => this.addCardToHand(p, c));
              this.recalculateMalice(p);
            }
          }
          if (this.onBroadcastMessage) {
            this.onBroadcastMessage(
              `⚗️ 모인 제물 카드(${submittedCards.length}장)가 생존자 수(${alivePlayers.length}장)에 미달하여 [인체 연성]이 실패했습니다. 제출한 카드는 모두 반환됩니다.`
            );
          }
          this.returnToMainPhase();
        } else {
          // 성공: 모인 카드 무덤으로
          this.graveyard.push(...submittedCards);
          if (this.onBroadcastMessage) {
            this.onBroadcastMessage(
              `✨ 생존자들의 제물(${submittedCards.length}장)이 목표치(${alivePlayers.length}장)를 달성했습니다! 부활시킬 사망자를 투표합니다.`
            );
          }
          this.setupTransmutationVoting(eventCard);
        }
      },
      timer: null
    };

    action.timer = setTimeout(() => {
      if (this.pendingAction === action) action.resolve();
    }, this.eventTimeoutMs);
    this.pendingAction = action;
    if (this.onActionRequest) this.onActionRequest(action);
  }

  public setupTransmutationVoting(eventCard: EventCard): void {
    const deadPlayers = this.players.filter(p => !p.isAlive);
    if (deadPlayers.length === 0) {
      this.returnToMainPhase();
      return;
    }

    const action: PendingAction = {
      type: 'VOTE',
      eventName: '인체 연성',
      initiatorId: null,
      targetId: null,
      deadline: Date.now() + this.eventTimeoutMs,
      responses: {},
      resolve: () => {
        if (this.isResolvingAction) return;
        this.isResolvingAction = true;

        try {
          if (this.pendingAction?.timer) clearTimeout(this.pendingAction.timer);

          const votes = this.pendingAction!.responses as Record<string, any>;
          const alivePlayers = this.getAlivePlayers();
          const currentDead = this.players.filter(p => !p.isAlive);
          if (currentDead.length === 0) {
            this.returnToMainPhase();
            return;
          }

          // 다수결 집계 (독재 지원, 동률 시 랜덤)
          const counts: Record<string, number> = {};
          currentDead.forEach(p => { counts[p.id] = 0; });

          for (const p of alivePlayers) {
            const v = votes[p.id];
            const isUsingDictator = typeof v === 'object' && v?.useDictatorship;
            const hasDictatorCard = p.hand.items.some(c => c.name === '독재');
            let val = typeof v === 'object' && v ? v.targetId : v;

            // 미투표자는 무작위 사망자 1명에게 투표
            if (!val || !counts.hasOwnProperty(val)) {
              const randomDead = currentDead[Math.floor(Math.random() * currentDead.length)];
              val = randomDead.id;
            }

            if (isUsingDictator && hasDictatorCard) {
              const dictIdx = p.hand.items.findIndex(c => c.name === '독재');
              if (dictIdx !== -1) {
                const removed = p.hand.items.splice(dictIdx, 1)[0];
                this.graveyard.push(removed);
                this.recalculateMalice(p);
              }
              counts[val] = (counts[val] || 0) + 666;
              if (this.onBroadcastMessage) {
                this.onBroadcastMessage(
                  `👑 ${p.name}님이 [독재] 카드를 사용했습니다!`
                );
              }
            } else {
              counts[val] = (counts[val] || 0) + 1;
            }
          }

          let maxVotes = -1;
          for (const count of Object.values(counts)) {
            if (count > maxVotes) maxVotes = count;
          }

          const topCandidates = Object.keys(counts).filter(id => counts[id] === maxVotes);
          let chosenTargetId = topCandidates[0];
          if (topCandidates.length > 1) {
            chosenTargetId = topCandidates[Math.floor(Math.random() * topCandidates.length)];
          }

          const revivedPlayer = this.getPlayerById(chosenTargetId);
          if (revivedPlayer && !revivedPlayer.isAlive) {
            revivedPlayer.isAlive = true;
            revivedPlayer.hand = { malices: [], weapons: [], shields: [], treasures: [], items: [] };
            this.recalculateMalice(revivedPlayer);
            if (this.onBroadcastMessage) {
              this.onBroadcastMessage(`✨ 투표 결과, [${revivedPlayer.name}]님이 생존자들의 제물로 부활했습니다!`);
            }
          }

          this.returnToMainPhase();
        } finally {
          this.isResolvingAction = false;
        }
      },
      timer: null
    };

    action.timer = setTimeout(() => {
      if (this.pendingAction === action) action.resolve();
    }, this.eventTimeoutMs);
    this.pendingAction = action;
    if (this.onActionRequest) this.onActionRequest(action);
  }

  private resolveImmediateEvent(initiator: Player, eventCard: EventCard): void {
    const alivePlayers = this.getAlivePlayers();

    if (eventCard.name === '고해성사') {
      for (const p of alivePlayers) {
        if (p.hand.malices.length >= 3) {
          p.hand.malices.pop();
          this.recalculateMalice(p);
        }
      }
    } else if (eventCard.name === '빙의') {
      const deadPlayers = this.players.filter(p => !p.isAlive);
      if (deadPlayers.length > 0) {
        // 죽은 자들에게 이번 차례를 빼앗겨 즉시 다음 사람에게 턴을 넘깁니다.
        this.nextTurn();
        return;
      }
    } else if (eventCard.name === '예언') {
      this.setupProphecy(initiator, eventCard);
      return;
    }

    this.returnToMainPhase();
  }

  public setupProphecy(initiator: Player, eventCard: EventCard): void {
    this.phase = 'RESOLVING_EVENT';
    const peekCount = Math.min(this.players.length, this.deck.length);
    if (peekCount <= 0) {
      this.returnToMainPhase();
      return;
    }

    // 덱의 맨 위에서 peekCount장 (다음에 드로우될 카드 순서대로)
    // this.deck.pop()으로 드로우되므로, 다음 드로우될 카드는 this.deck[this.deck.length - 1]임.
    const peekedCards = this.deck.slice(-peekCount).reverse();

    const action: PendingAction = {
      type: 'CARD_SUBMISSION',
      eventName: '예언',
      initiatorId: initiator.id,
      targetId: null,
      deadline: Date.now() + this.eventTimeoutMs,
      responses: {},
      prophecyCards: peekedCards,
      resolve: () => {
        if (this.isResolvingAction) return;
        this.isResolvingAction = true;
        try {
          if (this.pendingAction?.timer) clearTimeout(this.pendingAction.timer);
          this.returnToMainPhase();
        } finally {
          this.isResolvingAction = false;
        }
      },
      timer: null
    };

    action.timer = setTimeout(() => {
      if (this.pendingAction === action) action.resolve();
    }, this.eventTimeoutMs);
    this.pendingAction = action;
    if (this.onActionRequest) this.onActionRequest(action);
  }

  public setupCardReveal(
    eventCard: EventCard,
    revealedPlayer: Player,
    reason: string,
    onFinish: () => void
  ): void {
    this.phase = 'RESOLVING_EVENT';
    this.activeEvent = eventCard;

    const allCards: Card[] = [
      ...revealedPlayer.hand.malices,
      ...revealedPlayer.hand.weapons,
      ...revealedPlayer.hand.shields,
      ...revealedPlayer.hand.treasures,
      ...revealedPlayer.hand.items,
    ];

    const action: PendingAction = {
      type: 'CARD_SUBMISSION',
      eventName: eventCard.name,
      initiatorId: null,
      targetId: revealedPlayer.id,
      deadline: Date.now() + 30000,
      responses: {},
      resolve: () => {
        if (this.pendingAction?.timer) clearTimeout(this.pendingAction.timer);
        this.pendingAction = null;
        onFinish();
      },
      timer: null,
    };

    (action as any).revealedPlayerId = revealedPlayer.id;
    (action as any).revealedPlayerName = revealedPlayer.name;
    (action as any).revealedCards = allCards;
    (action as any).revealedReason = reason;

    action.timer = setTimeout(() => {
      if (this.pendingAction === action) action.resolve();
    }, 30000);

    this.pendingAction = action;
    if (this.onActionRequest) this.onActionRequest(action);
    if (this.onStateChange) this.onStateChange();
  }
  
  public setupDefenseAgainstTarget(initiator: Player | null, target: Player, eventCard: EventCard): void {
    this.pauseTurnTimer();
    this.phase = 'WAITING_FOR_DEFENSE';
    const action: PendingAction = {
      type: 'DEFENSE',
      eventName: eventCard.name,
      weaponCard: ((eventCard as any).category === 'TOOL' || eventCard.name === '마육검') ? (eventCard as any) : undefined,
      initiatorId: initiator?.id ?? null,
      targetId: target.id,
      deadline: Date.now() + this.eventTimeoutMs,
      responses: {},
      resolve: () => {
        if (this.isResolvingAction) return;
        this.isResolvingAction = true;
        try {
          if (this.pendingAction?.timer) clearTimeout(this.pendingAction.timer);
          const defended = Object.keys(this.pendingAction?.responses || {}).length > 0;
          const currentTargetId = this.pendingAction?.targetId ?? target.id;
          const currentTarget = this.getPlayerById(currentTargetId);
          const currentInitiatorId = this.pendingAction?.initiatorId ?? initiator?.id;
          const currentInitiator = currentInitiatorId ? this.getPlayerById(currentInitiatorId) : null;
          const initiatorIsDead = currentInitiator ? !currentInitiator.isAlive : false;
          // 방어에 실패했고, 공격자가 반사 피해 등으로 사망하지 않은 경우에만 현재 타겟이 사망
          if (!defended && !initiatorIsDead && currentTarget && currentTarget.isAlive) {
            this.killPlayer(currentTarget.id);
          }
          this.returnToMainPhase();
        } finally {
          this.isResolvingAction = false;
        }
      },
      timer: null
    };
    action.timer = setTimeout(() => {
      if (this.pendingAction === action) action.resolve();
    }, this.eventTimeoutMs);
    this.pendingAction = action;
    if (this.onActionRequest) this.onActionRequest(action);
  }

  private setupVoting(initiator: Player, eventCard: EventCard): void {
    const action: PendingAction = {
      type: 'VOTE',
      eventName: eventCard.name,
      initiatorId: initiator.id,
      targetId: null,
      deadline: Date.now() + this.eventTimeoutMs,
      responses: {},
      resolve: () => {
        if (this.isResolvingAction) return;
        this.isResolvingAction = true;

        try {
          if (this.pendingAction?.timer) clearTimeout(this.pendingAction.timer);
          
          const votes = this.pendingAction!.responses as Record<string, any>;
          const alivePlayers = this.getAlivePlayers();
          
          if (eventCard.name === '구덩이') {
            // [요청 반영] 구덩이는 기명 투표: 각 생존자의 선택 집계
            const saveVoters: Player[] = [];
            const dropVoters: Player[] = [];
            for (const p of alivePlayers) {
              const v = votes[p.id];
              const choice = typeof v === 'object' && v ? v.targetId : v;
              if (choice === 'DROP') {
                dropVoters.push(p);
              } else {
                saveVoters.push(p);
              }
            }
            const saveNames = saveVoters.map(p => p.name).join(', ') || '없음';
            const dropNames = dropVoters.map(p => p.name).join(', ') || '없음';

            if (this.onBroadcastMessage) {
              this.onBroadcastMessage(
                `🗳️ [구덩이 투표 집계] 💚 살린다: [${saveNames}] (${saveVoters.length}명) / 🖤 살리지 않는다: [${dropNames}] (${dropVoters.length}명)`
              );
            }

            // 한 명이라도 '살리지 않는다(DROP)'가 나오면 사망. 시간 내 미투표자는 자동으로 '살린다(SAVE)'. (생존자 회의가 아니므로 독재 적용 불가)
            if (dropVoters.length > 0) {
              this.killPlayer(initiator.id);
              if (this.onBroadcastMessage) {
                this.onBroadcastMessage(
                  `🕳️ 구출을 거부한 생존자([${dropNames}])가 있어, ${initiator.name}님이 구덩이에서 탈출하지 못하고 사망했습니다.`
                );
              }
            } else {
              if (this.onBroadcastMessage) {
                this.onBroadcastMessage(
                  `💚 모든 생존자([${saveNames}])가 살리기로 동의하여 ${initiator.name}님이 무사히 구덩이에서 구출되었습니다!`
                );
              }
            }
          } else {
            // 일반 생존자 투표 집계 (독재 666표, 동률 시 랜덤)
            const counts: Record<string, number> = {};
            alivePlayers.forEach(p => { counts[p.id] = 0; });

            for (const p of alivePlayers) {
              const v = votes[p.id];
              const isUsingDictator = typeof v === 'object' && v?.useDictatorship;
              const hasDictatorCard = p.hand.items.some(c => c.name === '독재');
              let val = typeof v === 'object' && v ? v.targetId : v;

              // 미투표자는 무작위 생존자 1명에게 자동 투표
              if (!val || !counts.hasOwnProperty(val)) {
                const randomAlive = alivePlayers[Math.floor(Math.random() * alivePlayers.length)];
                val = randomAlive.id;
              }

              if (isUsingDictator && hasDictatorCard) {
                const dictIdx = p.hand.items.findIndex(c => c.name === '독재');
                if (dictIdx !== -1) {
                  const removed = p.hand.items.splice(dictIdx, 1)[0];
                  this.graveyard.push(removed);
                  this.recalculateMalice(p);
                }
                counts[val] = (counts[val] || 0) + 666;
                if (this.onBroadcastMessage) {
                  this.onBroadcastMessage(
                    `👑 ${p.name}님이 [독재] 카드를 사용했습니다!`
                  );
                }
              } else {
                counts[val] = (counts[val] || 0) + 1;
              }
            }

            let maxVotes = -1;
            for (const c of Object.values(counts)) {
              if (c > maxVotes) maxVotes = c;
            }

            const topCandidates = Object.keys(counts).filter(id => counts[id] === maxVotes);
            let targetId = topCandidates[0];
            if (topCandidates.length > 1) {
              targetId = topCandidates[Math.floor(Math.random() * topCandidates.length)];
              const targetPlayer = this.getPlayerById(targetId);
              if (this.onBroadcastMessage) {
                this.onBroadcastMessage(
                  `🎲 최고 득표 동률로 무작위 추첨 결과 [${targetPlayer ? targetPlayer.name : targetId}]님이 선택되었습니다.`
                );
              }
            }
            
            const target = this.getPlayerById(targetId);
            if (target) {
              if (eventCard.name === '천사의 심판대') {
                const maliceCount = this.getMaliceCardCount(target);
                const targetDied = maliceCount >= 1;
                const outcomeMsg = targetDied
                  ? `⚖️ [천사의 심판대] 악의(${maliceCount}장)를 가진 [${target.name}]님이 심판을 받아 사망했습니다.`
                  : `🕊️ [천사의 심판대] [${target.name}]님은 악의가 없어 무죄로 판명되었습니다.`;

                if (this.onBroadcastMessage) this.onBroadcastMessage(outcomeMsg);

                this.setupCardReveal(eventCard, target, outcomeMsg, () => {
                  if (targetDied) {
                    this.killPlayer(target.id, msg => this.onBroadcastMessage && this.onBroadcastMessage(msg));
                  }
                  this.returnToMainPhase();
                });
                return;
              } else if (eventCard.name === '악마의 고해소') {
                const maliceCount = this.getMaliceCardCount(target);
                const targetDied = maliceCount <= 1;
                const outcomeMsg = targetDied
                  ? `😈 [악마의 고해소] 선량한 [${target.name}]님(악의 ${maliceCount}장)이 악마에게 처형당했습니다.`
                  : `🩸 [악마의 고해소] [${target.name}]님은 충분한 악의(${maliceCount}장)를 증명하여 살아남았습니다.`;

                if (this.onBroadcastMessage) this.onBroadcastMessage(outcomeMsg);

                this.setupCardReveal(eventCard, target, outcomeMsg, () => {
                  if (targetDied) {
                    this.killPlayer(target.id, msg => this.onBroadcastMessage && this.onBroadcastMessage(msg));
                  }
                  this.returnToMainPhase();
                });
                return;
              } else if (eventCard.name === '미끼' || eventCard.name === '제물') {
                this.killPlayer(target.id);
                if (eventCard.name === '미끼' && this.onBroadcastMessage) {
                  this.onBroadcastMessage(
                    `🧟 아무도 괴물을 처치하지 않아, 생존자 회의 결과에 따라 [${target.name}]님이 괴물의 미끼가 되어 사망했습니다.`
                  );
                } else if (eventCard.name === '제물' && this.onBroadcastMessage) {
                  this.onBroadcastMessage(
                    `🔥 제물 목표치 달성에 실패하여, 생존자 회의 결과 [${target.name}]님이 제물로 바쳐져 사망했습니다.`
                  );
                }
              }
            }
          }

          this.returnToMainPhase();
        } finally {
          this.isResolvingAction = false;
        }
      },
      timer: null
    };
    action.timer = setTimeout(() => {
      if (this.pendingAction === action) action.resolve();
    }, this.eventTimeoutMs);
    this.pendingAction = action;
    if (this.onActionRequest) this.onActionRequest(action);
  }

  public setupGiftSelection(initiator: Player, eventCard: EventCard): void {
    this.phase = 'RESOLVING_EVENT';
    this.activeEvent = eventCard;
    const action: PendingAction = {
      type: 'TARGET_SELECTION',
      eventName: '선물',
      initiatorId: initiator.id,
      targetId: null,
      deadline: Date.now() + this.eventTimeoutMs,
      responses: {},
      resolve: () => {
        if (this.pendingAction?.timer) clearTimeout(this.pendingAction.timer);

        const response = this.pendingAction?.responses[initiator.id] as { cardId: string; targetId: string } | undefined;
        const aliveOthers = this.getAlivePlayers().filter(p => p.id !== initiator.id);
        const allInitiatorCards = [
          ...initiator.hand.weapons,
          ...initiator.hand.shields,
          ...initiator.hand.treasures,
          ...initiator.hand.items,
          ...initiator.hand.malices,
        ];

        if (allInitiatorCards.length === 0) {
          if (this.onBroadcastMessage) {
            this.onBroadcastMessage(`💨 ${initiator.name}님의 패가 비어있어 아무에게도 선물을 건네지 못했습니다.`);
          }
          this.returnToMainPhase();
          return;
        }

        if (aliveOthers.length === 0) {
          this.returnToMainPhase();
          return;
        }

        let target: Player | undefined;
        let giftedCard: Card | undefined;

        if (response && response.cardId && response.targetId) {
          target = this.getPlayerById(response.targetId);
          giftedCard = allInitiatorCards.find(c => c.id === response.cardId);
        }

        const isTimeout = !target || !target.isAlive || target.id === initiator.id || !giftedCard;

        if (isTimeout) {
          target = aliveOthers[Math.floor(Math.random() * aliveOthers.length)];
          giftedCard = allInitiatorCards[Math.floor(Math.random() * allInitiatorCards.length)];
        }

        if (!target || !giftedCard) {
          this.returnToMainPhase();
          return;
        }

        if (isTimeout) {
          if (this.onBroadcastMessage) {
            this.onBroadcastMessage(`⏱️ 시간 초과로 ${initiator.name}님이 ${target.name}님에게 카드 1장을 무작위로 선물했습니다.`);
          }
        } else {
          if (this.onBroadcastMessage) {
            this.onBroadcastMessage(`🎁 ${initiator.name}님이 ${target.name}님에게 카드 1장을 선물했습니다.`);
          }
        }

        // [요청 반영] 보낸 사람과 받은 사람에게만 어떤 카드가 누구에게 전달되었는지 안내
        if (this.onPrivateMessage) {
          this.onPrivateMessage(
            initiator.id,
            `📤 ${target.name}님에게 [${giftedCard.name}] 카드를 선물했습니다.`
          );
          this.onPrivateMessage(
            target.id,
            `📥 ${initiator.name}님으로부터 [${giftedCard.name}] 카드를 선물받았습니다!`
          );
        }

        this.removeCardFromHand(initiator, giftedCard.id);
        this.addCardToHand(target, giftedCard);
        this.recalculateMalice(initiator);
        this.recalculateMalice(target);

        this.returnToMainPhase();
      },
      timer: null
    };

    action.timer = setTimeout(() => {
      if (this.pendingAction === action) action.resolve();
    }, this.eventTimeoutMs);
    this.pendingAction = action;
    if (this.onActionRequest) this.onActionRequest(action);
  }
  
  private setupTargetSelection(initiator: Player, eventCard: EventCard): void {
    if (eventCard.name === '카르마' || eventCard.name === '폴터가이스트') {
      const deadPlayers = this.players.filter(p => !p.isAlive);
      if (deadPlayers.length === 0) {
        this.returnToMainPhase();
        return; // 망자가 없으면 즉시 이벤트 종료 (카르마는 버려짐)
      }
    }

    const action: PendingAction = {
      type: 'TARGET_SELECTION',
      eventName: eventCard.name,
      initiatorId: initiator.id,
      targetId: null,
      deadline: Date.now() + this.eventTimeoutMs,
      responses: {},
      resolve: () => {
        if (this.pendingAction?.timer) clearTimeout(this.pendingAction.timer);
        
        let targetId = '';
        if (eventCard.name === '카르마' || eventCard.name === '폴터가이스트') {
          // 망자들의 다수결(또는 대표) 응답 처리
          const counts: Record<string, number> = {};
          for (const v of Object.values(this.pendingAction!.responses)) {
            const t = v as string;
            counts[t] = (counts[t] || 0) + 1;
          }
          const sorted = Object.entries(counts).sort((a,b) => b[1] - a[1]);
          if (sorted.length > 0) {
            targetId = sorted[0][0];
          } else {
            const alive = this.getAlivePlayers();
            if (alive.length > 0) {
              targetId = alive[Math.floor(Math.random() * alive.length)].id;
            }
          }
        } else {
          targetId = this.pendingAction!.responses[initiator.id] as string;
          if (!targetId) {
            const otherAlive = this.getAlivePlayers().filter(p => p.id !== initiator.id);
            if (otherAlive.length > 0) {
              targetId = otherAlive[Math.floor(Math.random() * otherAlive.length)].id;
            }
          }
        }

        const target = this.getPlayerById(targetId);
        if (target) {
          if (eventCard.name === '선택 (善)') {
            const maliceCount = this.getMaliceCardCount(target);
            const initiatorDied = maliceCount >= 1;
            const outcomeMsg = initiatorDied
              ? `⚖️ [선택 (善)] ${target.name}님의 패를 공개한 결과 악의(${maliceCount}장)가 발견되어 ${initiator.name}님이 사망했습니다!`
              : `🕊️ [선택 (善)] ${target.name}님의 패를 공개한 결과 악의가 없어 ${initiator.name}님이 살아남았습니다!`;

            if (this.onBroadcastMessage) this.onBroadcastMessage(outcomeMsg);

            this.setupCardReveal(eventCard, target, outcomeMsg, () => {
              if (initiatorDied) {
                this.killPlayer(initiator.id, msg => this.onBroadcastMessage && this.onBroadcastMessage(msg));
              }
              this.returnToMainPhase();
            });
            return;
          } else if (eventCard.name === '선택 (惡)') {
            const maliceCount = this.getMaliceCardCount(target);
            const initiatorDied = maliceCount <= 1;
            const outcomeMsg = initiatorDied
              ? `😈 [선택 (惡)] ${target.name}님의 패를 공개한 결과 악의(${maliceCount}장)가 1장 이하로 부족하여 ${initiator.name}님이 사망했습니다!`
              : `🩸 [선택 (惡)] ${target.name}님의 패를 공개한 결과 악의(${maliceCount}장)가 충분하여 ${initiator.name}님이 살아남았습니다!`;

            if (this.onBroadcastMessage) this.onBroadcastMessage(outcomeMsg);

            this.setupCardReveal(eventCard, target, outcomeMsg, () => {
              if (initiatorDied) {
                this.killPlayer(initiator.id, msg => this.onBroadcastMessage && this.onBroadcastMessage(msg));
              }
              this.returnToMainPhase();
            });
            return;
          } else if (eventCard.name === '뒤바뀐 영혼') {
            const tempHand = initiator.hand;
            initiator.hand = target.hand;
            target.hand = tempHand;
            this.recalculateMalice(initiator);
            this.recalculateMalice(target);
            if (this.onBroadcastMessage) {
              this.onBroadcastMessage(`🔄 [뒤바뀐 영혼] ${initiator.name}님과 ${target.name}님의 모든 패가 뒤바뀌었습니다!`);
            }
          } else if (eventCard.name === '폴터가이스트' || eventCard.name === '피바라기') {
            // 방패로 방어할 수 있는 기회 부여
            this.setupDefenseAgainstTarget(
              eventCard.name === '피바라기' ? initiator : null,
              target,
              eventCard
            );
            return;
          } else if (eventCard.name === '카르마') {
            // 카르마는 타겟의 패에 악의 1장으로 들어감
            target.hand.malices.push({
              id: eventCard.id,
              cardId: 104,
              name: '카르마',
              description: '죽은 자들이 건넨 카르마입니다.',
              category: 'MALICE',
              maliceValue: MALICE_PER_CARD
            } as any);
            this.recalculateMalice(target);
            if (this.onBroadcastMessage) {
              this.onBroadcastMessage(`💀 [카르마] 죽은 자들의 원한이 담긴 카르마가 ${target.name}님의 패에 악의로 전달되었습니다.`);
            }
          }
        }

        this.returnToMainPhase();
      },
      timer: null
    };
    action.timer = setTimeout(() => {
      if (this.pendingAction === action) action.resolve();
    }, this.eventTimeoutMs);
    this.pendingAction = action;
    if (this.onActionRequest) this.onActionRequest(action);
  }

  private autoSubmitRandomCardsIfMissing(): void {
    if (!this.pendingAction || this.pendingAction.type !== 'CARD_SUBMISSION') return;
    // [요청 반영] 룰렛만 제한시간 후 미제출자 1장 자동 제출 (제물/인체 연성은 자동 제출 제외)
    if (this.pendingAction.eventName !== '룰렛') return;

    const alivePlayers = this.getAlivePlayers();
    for (const player of alivePlayers) {
      if (this.pendingAction.responses[player.id]) continue;

      const allCards = [
        ...player.hand.weapons,
        ...player.hand.shields,
        ...player.hand.treasures,
        ...player.hand.items,
        ...player.hand.malices
      ];

      if (allCards.length > 0) {
        const randomIndex = Math.floor(Math.random() * allCards.length);
        const selectedCard = allCards[randomIndex];
        const removed = this.removeCardFromHand(player, selectedCard.id);
        if (removed) {
          this.recalculateMalice(player);
          this.pendingAction.responses[player.id] = [removed];
        }
      }
    }
  }

  private setupCardSubmission(eventCard: EventCard): void {
    const action: PendingAction = {
      type: 'CARD_SUBMISSION',
      eventName: eventCard.name,
      initiatorId: null,
      targetId: null,
      deadline: Date.now() + this.eventTimeoutMs,
      responses: {}, // Card[]
      resolve: () => {
        if (this.pendingAction?.timer) clearTimeout(this.pendingAction.timer);
        
        // 제한시간 동안 카드를 내지 않은 사람이 있을 경우 랜덤으로 1장 자동 제출
        this.autoSubmitRandomCardsIfMissing();

        const alivePlayers = this.getAlivePlayers();
        const submittedCards = Object.values(this.pendingAction!.responses).flat() as Card[];
        
        if (eventCard.name === '제물') {
          if (submittedCards.length < alivePlayers.length) {
            // 실패: 낸 카드들 다시 돌려주기
            for (const [pId, cards] of Object.entries(this.pendingAction!.responses)) {
              const p = this.getPlayerById(pId);
              if (p) {
                (cards as Card[]).forEach(c => this.addCardToHand(p, c));
                this.recalculateMalice(p);
              }
            }
            this.setupVoting(this.players[0], eventCard); // 실패 시 투표
            return;
          } else {
            // 성공: 모인 카드 무덤으로
            this.graveyard.push(...submittedCards);
            if (this.onBroadcastMessage) {
              this.onBroadcastMessage(`🕊️ 모든 생존자가 제물을 바쳐 심판을 면했습니다.`);
            }
          }
        } else if (eventCard.name === '룰렛') {
          // 룰렛 처리: 제출된 카드들을 모아서 셔플 후 제출자들에게 1장씩 재분배
          const shuffled = this.shuffleArray(submittedCards);
          const submitterIds = Object.keys(this.pendingAction!.responses);
          const victims: Array<{ player: Player; weapon: ToolCard }> = [];
          let idx = 0;
          
          if (this.onBroadcastMessage) {
            this.onBroadcastMessage(`🎯 [룰렛] 룰렛 분배가 완료되었습니다.`);
          }

          for (const pId of submitterIds) {
            const p = this.getPlayerById(pId);
            if (p && idx < shuffled.length) {
              const c = shuffled[idx++];
              
              // [요청 반영] 무기를 뽑은 경우 패로 들어가지 않고 바로 공격 후 무덤으로 버려짐!
              const isWeapon = c.category === 'TOOL' && (c as ToolCard).toolType === 'WEAPON';
              if (isWeapon) {
                this.graveyard.push(c); // 무덤으로 버려짐
                victims.push({ player: p, weapon: c as ToolCard });
                if (this.onBroadcastMessage) {
                  this.onBroadcastMessage(`🎯 [룰렛] ${p.name}님이 칼 [${c.name}]을(를) 뽑았습니다! 칼이 패로 들어가지 않고 ${p.name}님을 공격합니다!`);
                }
              } else {
                this.addCardToHand(p, c);
                this.recalculateMalice(p);
                if (this.onPrivateMessage) {
                  this.onPrivateMessage(p.id, `🎯 [룰렛] 당신은 [${c.name}] 카드를 획득했습니다.`);
                }
              }
            }
          }

          if (victims.length > 0) {
            this.processRouletteVictims(victims, eventCard);
            return;
          }
        }

        this.returnToMainPhase();
      },
      timer: null
    };
    action.timer = setTimeout(() => {
      if (this.pendingAction === action) action.resolve();
    }, this.eventTimeoutMs);
    this.pendingAction = action;
    if (this.onActionRequest) this.onActionRequest(action);
  }

  private processRouletteVictims(victims: Array<{ player: Player; weapon: ToolCard }>, eventCard: EventCard): void {
    if (victims.length === 0) {
      this.returnToMainPhase();
      return;
    }

    const current = victims[0];
    const remainingVictims = victims.slice(1);

    this.setupDefenseAgainstTarget(null, current.player, eventCard);

    // 이전 액션 완료 후 남은 희생자가 있다면 연쇄 방어 페이즈 진행
    if (this.pendingAction) {
      this.pendingAction.weaponCard = current.weapon;
      const originalResolve = this.pendingAction.resolve;
      this.pendingAction.resolve = () => {
        originalResolve();
        if (remainingVictims.length > 0) {
          this.processRouletteVictims(remainingVictims, eventCard);
        }
      };
    }
  }
  
  private shuffleArray<T>(array: T[]): T[] {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // ── Card Sorting & Malice ───────────────────────────────────────

  public addCardToHand(player: Player, card: Card): void {
    if (card.category === 'MALICE') {
      player.hand.malices.push(card);
    } else if (card.category === 'TOOL') {
      switch (card.toolType) {
        case 'WEAPON':
          player.hand.weapons.push(card);
          break;
        case 'SHIELD':
          player.hand.shields.push(card);
          break;
        case 'TREASURE':
          player.hand.treasures.push(card);
          break;
        case 'ITEM':
          player.hand.items.push(card);
          break;
      }
    }
  }

  public removeCardFromHand(player: Player, cardId: string): Card | null {
    let card: Card | null = null;
    let idx = player.hand.malices.findIndex(c => c.id === cardId);
    if (idx !== -1) { card = player.hand.malices[idx]; player.hand.malices.splice(idx, 1); return card; }
    
    idx = player.hand.weapons.findIndex(c => c.id === cardId);
    if (idx !== -1) { card = player.hand.weapons[idx]; player.hand.weapons.splice(idx, 1); return card; }

    idx = player.hand.shields.findIndex(c => c.id === cardId);
    if (idx !== -1) { card = player.hand.shields[idx]; player.hand.shields.splice(idx, 1); return card; }

    idx = player.hand.treasures.findIndex(c => c.id === cardId);
    if (idx !== -1) { card = player.hand.treasures[idx]; player.hand.treasures.splice(idx, 1); return card; }

    idx = player.hand.items.findIndex(c => c.id === cardId);
    if (idx !== -1) { card = player.hand.items[idx]; player.hand.items.splice(idx, 1); return card; }

    return null;
  }

  public findCardInPlayerHand(player: Player, cardId: string): Card | null {
    const all = [
      ...player.hand.malices,
      ...player.hand.weapons,
      ...player.hand.shields,
      ...player.hand.treasures,
      ...player.hand.items,
    ];
    return all.find(c => c.id === cardId) || null;
  }

  public recalculateMalice(player: Player): void {
    const maliceFromCards = player.hand.malices.reduce(
      (sum, card) => sum + card.maliceValue, 0
    );

    const allToolCards = [
      ...player.hand.weapons,
      ...player.hand.shields,
      ...player.hand.treasures,
      ...player.hand.items,
    ];
    const maliceFromTools = allToolCards.reduce(
      (sum, card) => sum + card.maliceValue + (card.maliceModifier ?? 0), 0
    );

    player.currentMalice = Math.max(0, maliceFromCards + maliceFromTools);
    player.alignment = player.currentMalice >= EVIL_THRESHOLD ? 'EVIL' : 'GOOD';
  }

  private getMaliceCardCount(player: Player): number {
    let count = 0;
    // 1. 악의 카드 (일반 악의 1장, 짙은 악의 2장으로 산정)
    for (const m of player.hand.malices) {
      if (m.name === '짙은 악의' || m.maliceValue === 2) {
        count += 2;
      } else {
        count += (m.maliceValue || 1);
      }
    }

    // 2. 악의가 포함된 특수 도구 카드 (누군가의 뼈, 누군가의 방패, 누군가의 로켓 등)
    const allTools = [
      ...player.hand.weapons,
      ...player.hand.shields,
      ...player.hand.treasures,
      ...player.hand.items,
    ];
    for (const t of allTools) {
      if (t.maliceValue > 0) {
        count += t.maliceValue;
      }
    }

    return count;
  }

  // ── Turn Management ─────────────────────────────────────────────

  public nextTurn(): void {
    if (this.phase === 'ENDED') return;
    if (this.checkLastSurvivor()) {
      const scores = this.handleLastSurvivor();
      if (this.onGameOver) this.onGameOver(scores);
      return;
    }

    let loops = 0;
    do {
      this.currentTurnIndex = (this.currentTurnIndex + 1) % this.players.length;
      loops++;
      if (loops > this.players.length * 2) break;
    } while (!this.players[this.currentTurnIndex].isAlive);

    this.phase = 'MAIN';
    this.activeEvent = null;
    this.pendingAction = null;
    this.currentTurnPlayerId = this.players[this.currentTurnIndex].id;
    this.players[this.currentTurnIndex].hasDrawnThisTurn = false;
    this.players[this.currentTurnIndex].hasUsedWeaponThisTurn = false;
    
    if (this.silenceMode) {
      this.silenceTurnCount--;
      if (this.silenceTurnCount <= 0) {
        this.silenceMode = false;
      }
    }
    
    this.freeForAll = false; // 난투 해제
    
    this.updatePlayerTurns();
    this.startTurnTimer(this.turnDurationMs);
  }

  private updatePlayerTurns(): void {
    for (const p of this.players) {
      p.isMyTurn = p.id === this.currentTurnPlayerId;
      p.isSilenced = false; // 턴이 넘어갈 때 모든 침묵 해제
    }
  }

  // ── Win Conditions ──────────────────────────────────────────────

  public checkLastSurvivor(): boolean {
    return this.getAlivePlayers().length <= 1;
  }

  public handleLastSurvivor(): PlayerScore[] {
    this.phase = 'ENDED';
    this.currentTurnPlayerId = null;
    this.updatePlayerTurns();
    return this.calculateScores(true);
  }

  public endRound(): PlayerScore[] {
    this.phase = 'ENDED';
    this.currentTurnPlayerId = null;
    this.updatePlayerTurns();
    return this.calculateScores(false);
  }

  private calculateScores(isLastSurvivor: boolean): PlayerScore[] {
    const scores: PlayerScore[] = [];
    const alivePlayers = this.getAlivePlayers();
    
    for (const player of this.players) {
      let score = 0;
      let reason = '';
      
      // 생존자 점수 계산
      if (player.isAlive) {
        if (isLastSurvivor && player.alignment === 'EVIL') {
          // 악인 최후 1인: 참가 인원당 1점 (보물 혜택 없음)
          score = this.players.length;
          reason = '악인 최후의 1인 승리';
        } else if (player.alignment === 'GOOD') {
          // 선인 생존 탈출: 생존자 수당 1점
          score = alivePlayers.length;
          reason = isLastSurvivor ? '선인 최후 1인 생존 탈출' : '선인 동반 생존 탈출 성공';

          // [요청 반영] 보물 추가점수(복권/교환권)는 선인으로 생존 탈출에 성공했을 때만 지급!
          const lotteryCount = player.hand.treasures.filter(
            c => c.name === '복권' || c.name === '교환권'
          ).length;

          if (lotteryCount > 0) {
            score += lotteryCount;
            reason += ` + 보물(+${lotteryCount})`;
          }
        } else {
          // 악인이지만 최후 1인 달성 실패
          score = 0;
          reason = '악인 탈출 실패 (최후 1인 미달성)';
        }
      } else {
        // 사망자
        score = 0;
        reason = player.alignment === 'GOOD' ? '선인 사망' : '악인 사망';
      }
      
      scores.push({
        playerId: player.id,
        name: player.name,
        score,
        reason
      });
    }

    // 점수 내림차순 정렬 (동점 시 생존자 우선)
    scores.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const pA = this.getPlayerById(a.playerId);
      const pB = this.getPlayerById(b.playerId);
      if (pA?.isAlive && !pB?.isAlive) return -1;
      if (!pA?.isAlive && pB?.isAlive) return 1;
      return 0;
    });

    return scores;
  }

  // ── State Getters ───────────────────────────────────────────────

  public getSanitizedGameState(forPlayerId: string): SanitizedGameState {
    const me = this.getPlayerById(forPlayerId);

    const publicPlayers: PublicPlayerInfo[] = this.players.map(p => {
      const handCount = this.getHandCount(p);
      return {
        id: p.id,
        name: p.name,
        isAlive: p.isAlive,
        handCount,
        isMyTurn: p.isMyTurn,
        isSilenced: p.isSilenced
      };
    });

    const hasGuardianAngel = this.getAlivePlayers().some(
      p => p.id !== this.pendingAction?.initiatorId && p.hand.shields.some(s => s.name === '수호천사')
    );

    return {
      roomCode: this.roomCode,
      myInfo: {
        hand: me?.hand ?? { malices: [], weapons: [], shields: [], treasures: [], items: [] },
        currentMalice: me?.currentMalice ?? 0,
        alignment: me?.alignment ?? 'GOOD',
        hasDrawnThisTurn: me?.hasDrawnThisTurn ?? false,
        hasUsedWeaponThisTurn: me?.hasUsedWeaponThisTurn ?? false,
      },
      players: publicPlayers,
      currentTurnPlayerId: this.currentTurnPlayerId,
      phase: this.phase,
      deckRemaining: this.deck.length,
      activeEventName: this.activeEvent?.name ?? null,
      activeEventDescription: this.activeEvent?.description ?? null,
      activeEventDetailedRule: this.activeEvent?.detailedRule ?? null,
      defenseTargetId: this.pendingAction?.targetId ?? null,
      defenseInitiatorId: this.pendingAction?.initiatorId ?? null,
      defenseWeaponName: this.pendingAction?.weaponCard?.name ?? null,
      defenseSkippedPlayerIds: this.pendingAction?.skippedPlayerIds ?? [],
      defenseHasGuardianAngel: hasGuardianAngel,
      excaliburSkippedPlayerIds: this.pendingAction?.eventName === '엑스칼리버' ? (this.pendingAction.skippedPlayerIds ?? []) : [],
      mayukWinnerId: (this.pendingAction?.eventName === '마육검' && this.pendingAction?.type === 'TARGET_SELECTION') ? this.pendingAction.initiatorId : null,
      linkedPlayers: this.linkedPlayers,
      silenceMode: this.silenceMode,
      freeForAll: this.freeForAll,
      actionDeadline: this.pendingAction?.deadline ?? null,
      eventTimeoutSeconds: Math.round(this.eventTimeoutMs / 1000),
      submittedPlayerIds: this.pendingAction ? Object.keys(this.pendingAction.responses || {}) : [],
      revealedCardsInfo: (this.pendingAction as any)?.revealedCards ? {
        playerId: (this.pendingAction as any).revealedPlayerId,
        playerName: (this.pendingAction as any).revealedPlayerName,
        cards: (this.pendingAction as any).revealedCards,
        reason: (this.pendingAction as any).revealedReason,
        confirmedPlayerIds: Object.keys(this.pendingAction?.responses || {}),
      } : null,
      turnDeadline: this.turnDeadline,
      turnRemainingSeconds: Math.ceil(this.turnRemainingMs / 1000),
      isTurnTimerPaused: this.isTurnTimerPaused || this.phase !== 'MAIN',
    };
  }

  public getHandCount(player: Player): HandCount {
    return {
      malices: player.hand.malices.length,
      weapons: player.hand.weapons.length,
      shields: player.hand.shields.length,
      treasures: player.hand.treasures.length,
      items: player.hand.items.length,
    };
  }

  public getTotalHandCount(player: Player): number {
    return (
      player.hand.malices.length +
      player.hand.weapons.length +
      player.hand.shields.length +
      player.hand.treasures.length +
      player.hand.items.length
    );
  }
}
