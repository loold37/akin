import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { ClientToServerEvents, ServerToClientEvents, PublicPlayerInfo, Card } from '../../shared/types';
import { GameRoom } from './GameRoom';

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server<ClientToServerEvents, ServerToClientEvents>(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

const rooms: Map<string, GameRoom> = new Map();

function emitGameStateToAll(roomCode: string, room: GameRoom): void {
  for (const player of room.players) {
    const sanitized = room.getSanitizedGameState(player.id);
    io.to(player.id).emit('game_state_update', sanitized);
  }
}

function emitRoomState(roomCode: string, room: GameRoom): void {
  const publicPlayers: PublicPlayerInfo[] = room.players.map(p => ({
    id: p.id,
    name: p.name,
    isAlive: p.isAlive,
    handCount: {
      malices: p.hand.malices.length,
      weapons: p.hand.weapons.length,
      shields: p.hand.shields.length,
      treasures: p.hand.treasures.length,
      items: p.hand.items.length,
    },
    isMyTurn: p.isMyTurn,
    isSilenced: p.isSilenced,
  }));
  io.to(roomCode).emit('room_state_update', publicPlayers);
}

io.on('connection', (socket) => {
  console.log(`[Connect] ${socket.id}`);

  socket.on('join_room', (roomCode, playerName) => {
    let room = rooms.get(roomCode);
    if (!room) {
      room = new GameRoom(roomCode);
      room.onGameOver = (scores) => {
        io.to(roomCode).emit('action_result', '⚔️ 최후의 1인이 결정되었습니다!');
        io.to(roomCode).emit('game_over', scores);
        emitGameStateToAll(roomCode, room!);
        emitRoomState(roomCode, room!);
      };
      room.onActionRequest = (action) => {
        emitGameStateToAll(roomCode, room!);
        if (action.type === 'VOTE') {
          const candidates = action.eventName === '구덩이'
            ? ['SAVE', 'DROP']
            : action.eventName === '인체 연성'
            ? room!.players.filter(p => !p.isAlive).map(p => p.id)
            : room!.getAlivePlayers().map(p => p.id);
          io.to(roomCode).emit('request_vote', action.eventName || '', candidates, action.initiatorId || undefined);
        } else if (action.type === 'TARGET_SELECTION') {
          let candidates = room!.getAlivePlayers().map(p => p.id);
          if (action.eventName === '마육검') {
            candidates = candidates.filter(id => id !== action.initiatorId);
            io.to(action.initiatorId || '').emit('request_mayuk_choice', '마육검', candidates);
          } else if (action.eventName === '뒤바뀐 영혼' || action.eventName === '선물' || action.eventName === '피바라기') {
            candidates = candidates.filter(id => id !== action.initiatorId);
            io.to(action.initiatorId || '').emit('request_target', action.eventName || '', candidates);
          } else if (action.eventName === '카르마' || action.eventName === '폴터가이스트') {
            const deadPlayers = room!.players.filter(p => !p.isAlive);
            for (const dp of deadPlayers) {
              io.to(dp.id).emit('request_target', action.eventName || '', candidates);
            }
          } else {
            io.to(action.initiatorId || '').emit('request_target', action.eventName || '', candidates);
          }
        } else if (action.type === 'CARD_SUBMISSION') {
          if (action.eventName === '예언') {
            io.to(action.initiatorId || '').emit(
              'request_prophecy',
              '예언',
              (action as any).prophecyCards || [],
              action.initiatorId || ''
            );
          } else if (action.eventName === '무장해제' || action.eventName === '면죄부') {
            io.to(roomCode).emit('request_cards', action.eventName, 2);
          } else if (action.eventName === '인체 연성') {
            io.to(roomCode).emit('request_cards', '인체 연성', 0);
          } else if (action.eventName === '엑스칼리버') {
            io.to(roomCode).emit('request_excalibur', action.eventName);
          } else if (action.eventName === '마육검') {
            io.to(roomCode).emit('request_cards', action.eventName, 0);
          } else if (action.eventName === '무소유' || (action as any).revealedCards) {
            // 무소유 및 패 공개 이벤트는 제출 UI를 띄우지 않음
          } else {
            io.to(roomCode).emit('request_cards', action.eventName || '', 1);
          }
        }
      };
      room.onStateChange = () => {
        emitGameStateToAll(roomCode, room!);
      };
      room.onBroadcastMessage = (msg) => {
        io.to(roomCode).emit('action_result', msg);
      };
      room.onPrivateMessage = (playerId, msg) => {
        io.to(playerId).emit('action_result', msg);
      };
      rooms.set(roomCode, room);
    }

    let finalName = playerName;
    let suffix = 1;
    while (room.players.some(p => p.name === finalName)) {
      finalName = `${playerName}_${suffix++}`;
    }

    room.addPlayer(socket.id, finalName);
    socket.join(roomCode);
    console.log(`[Join] ${socket.id} joined ${roomCode} as ${finalName}`);

    emitRoomState(roomCode, room);
  });

  socket.on('start_game', (roomCode) => {
    const room = rooms.get(roomCode);
    if (!room || (room.phase !== 'WAITING' && room.phase !== 'ENDED')) return;

    const started = room.startGame();
    if (started) {
      io.to(roomCode).emit('game_started');
      io.to(roomCode).emit('action_result', '🎲 게임이 시작되었습니다! 각자 패를 확인하세요.');
      emitGameStateToAll(roomCode, room);
    }
  });

const getCategoryKoreanName = (card: any): string => {
  if (!card) return '도구';
  if (card.category === 'MALICE') return '악의';
  if (card.category === 'EVENT') return '이벤트';
  if (card.category === 'TOOL' || card.toolType) {
    const toolType = card.toolType;
    if (toolType === 'WEAPON') return '무기';
    if (toolType === 'SHIELD') return '방패';
    if (toolType === 'ITEM') return '아이템';
    if (toolType === 'TREASURE') return '보물';
    return '도구';
  }
  if (card.category === 'WEAPON') return '무기';
  if (card.category === 'SHIELD') return '방패';
  if (card.category === 'ITEM') return '아이템';
  if (card.category === 'TREASURE') return '보물';
  return '도구';
};

  const handleDrawCard = (roomCode: string, socketId: string) => {
    const room = rooms.get(roomCode);
    if (!room) return;

    const player = room.getPlayerById(socketId);
    const name = player?.name ?? socketId;

    const result = room.drawCardWithEvents(socketId);
    if (!result) return;

    if (result.triggeredEvents.length > 0) {
      io.to(roomCode).emit('events_triggered', result.triggeredEvents);

      const eventNames = result.triggeredEvents.map(e => e.name).join(', ');
      io.to(roomCode).emit(
        'action_result',
        `🃏 ${name}님이 이벤트를 뽑았습니다: ${eventNames}`
      );
    } else if (result.finalCard) {
      // 전체 알림: 누구누구가 카드를 뽑음
      io.to(roomCode).emit('action_result', `🎴 ${name}님이 카드를 1장 뽑았습니다.`);
      // 당사자 알림: 뽑은 카드의 이름과 상세 정보 (한글 카테고리)
      io.to(socketId).emit(
        'action_result',
        `📥 [${result.finalCard.name}] (${getCategoryKoreanName(result.finalCard)}) 카드를 획득했습니다!`
      );
    }

    if (result.deckEmpty && !result.finalCard) {
      io.to(roomCode).emit('action_result', '🏰 던전의 끝에 도달했습니다! 탈출 성공!');
      
      if (room.phase === 'ENDED') {
         const scores = room.endRound();
         io.to(roomCode).emit('game_over', scores);
      }
    }

    emitGameStateToAll(roomCode, room);
  };

  socket.on('draw_card', (roomCode) => {
    handleDrawCard(roomCode, socket.id);
  });

  socket.on('resume_draw', (roomCode) => {
    handleDrawCard(roomCode, socket.id);
  });

  socket.on('end_turn', (roomCode) => {
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'MAIN') return;
    if (room.currentTurnPlayerId !== socket.id) return;

    room.nextTurn();
    emitGameStateToAll(roomCode, room);
  });

  socket.on('send_chat', (roomCode, message) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    
    const player = room.getPlayerById(socket.id);
    if (!player) return;
    
    // 게임 종료 상태 또는 대기실에서는 모든 플레이어가 정상 채팅 (사망/유령 해제)
    if (room.phase === 'WAITING' || room.phase === 'ENDED') {
      io.to(roomCode).emit('chat_message', player.name, message);
      return;
    }

    if (!player.isAlive) {
      // [게임 진행 중] 사망자도 자유롭게 채팅 가능 (유령 뱃지)
      io.to(roomCode).emit('chat_message', `👻 ${player.name}`, message);
      return;
    }

    if (room.silenceMode) {
      io.to(roomCode).emit('action_result', `🗣️ ${player.name}님이 소리를 냈습니다...! 👁️ 눈 없는 괴물이 즉시 덮칩니다!`);
      room.killPlayer(socket.id, msg => io.to(roomCode).emit('action_result', msg));
      if (room.phase === 'MAIN' && room.currentTurnPlayerId === socket.id) {
        room.nextTurn();
      }
      emitGameStateToAll(roomCode, room);
    } else {
      io.to(roomCode).emit('chat_message', player.name, message);
    }
  });

  socket.on('submit_vote', (roomCode, targetId, useDictatorship) => {
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'RESOLVING_EVENT' || !room.pendingAction) return;
    if (room.pendingAction.type !== 'VOTE') return;

    room.pendingAction.responses[socket.id] = {
      targetId,
      useDictatorship: !!useDictatorship,
    };
    const voter = room.getPlayerById(socket.id);
    if (room.pendingAction.eventName === '구덩이') {
      const voteText = targetId === 'DROP' ? '🖤 살리지 않는다' : '💚 살린다';
      io.to(roomCode).emit('action_result', `🗳️ ${voter ? voter.name : '누군가'}님이 [${voteText}]에 투표했습니다.`);
    } else {
      io.to(roomCode).emit('action_result', '🗳️ 누군가 투표를 완료했습니다.');
    }
    
    const aliveCount = room.getAlivePlayers().length;
    if (Object.keys(room.pendingAction.responses).length >= aliveCount) {
      room.pendingAction.resolve();
      emitGameStateToAll(roomCode, room);
    }
  });

  socket.on('confirm_reveal', (roomCode) => {
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'RESOLVING_EVENT' || !room.pendingAction) return;
    if (!(room.pendingAction as any).revealedCards) return;

    room.pendingAction.responses[socket.id] = true;
    const player = room.getPlayerById(socket.id);
    if (player) {
      io.to(roomCode).emit('action_result', `👁️ [${player.name}] 님이 패 공개를 확인했습니다.`);
    }

    emitGameStateToAll(roomCode, room);

    const aliveCount = room.getAlivePlayers().length;
    const confirmedCount = Object.keys(room.pendingAction.responses).length;
    if (confirmedCount >= aliveCount) {
      room.pendingAction.resolve();
      emitGameStateToAll(roomCode, room);
    }
  });

  socket.on('kill_bait_monster', (roomCode, cardId) => {
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'RESOLVING_EVENT' || !room.pendingAction) return;
    if (room.pendingAction.eventName !== '미끼') return;

    const player = room.getPlayerById(socket.id);
    if (!player || !player.isAlive) return;

    const weaponCard = room.findCardInPlayerHand(player, cardId);
    if (!weaponCard) return;
    const isWeapon = weaponCard.category === 'TOOL' && (weaponCard as any).toolType === 'WEAPON';
    if (!isWeapon) return;

    const removed = room.removeCardFromHand(player, cardId);
    if (removed) {
      room.graveyard.push(removed);
      room.recalculateMalice(player);

      if (room.pendingAction.timer) {
        clearTimeout(room.pendingAction.timer);
      }
      room.pendingAction = null;

      io.to(roomCode).emit(
        'action_result',
        `⚔️ [미끼] ${player.name}님이 칼 [${removed.name}]을(를) 사용하여 괴물을 처치했습니다! 투표가 즉시 종료되고 모두가 생존했습니다!`
      );

      room.returnToMainPhase();
      emitGameStateToAll(roomCode, room);
    }
  });

  socket.on('submit_prophecy', (roomCode: string, cardIds: string[]) => {
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'RESOLVING_EVENT' || !room.pendingAction) return;
    if (room.pendingAction.eventName !== '예언') return;
    if (room.pendingAction.initiatorId !== socket.id) return;

    const player = room.getPlayerById(socket.id);
    if (!player || !player.isAlive) return;

    const prophecyCards: Card[] = (room.pendingAction as any).prophecyCards || [];
    if (prophecyCards.length === 0) return;

    // cardIds 순서대로 Card 객체 매핑
    const reordered: Card[] = [];
    for (const cid of cardIds) {
      const found = prophecyCards.find((c) => c.id === cid);
      if (found) reordered.push(found);
    }

    // 누락된 카드가 있다면 원래 순서대로 뒤에 추가
    for (const c of prophecyCards) {
      if (!reordered.some((rc) => rc.id === c.id)) {
        reordered.push(c);
      }
    }

    // 덱의 맨 위에 재배치 (reordered[0]이 다음 drawCard 때 pop 되도록 slice().reverse()로 반영)
    const peekCount = prophecyCards.length;
    room.deck.splice(-peekCount, peekCount, ...reordered.slice().reverse());

    if (room.onBroadcastMessage) {
      room.onBroadcastMessage(`🔮 [예언] ${player.name}님이 덱의 맨 위 ${peekCount}장의 카드 순서를 확인하고 재배치했습니다.`);
    }

    room.pendingAction.resolve();
    emitGameStateToAll(roomCode, room);
  });

  socket.on('submit_gift', (roomCode, cardId, targetId) => {
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'RESOLVING_EVENT' || !room.pendingAction) return;
    if (room.pendingAction.eventName !== '선물') return;
    if (room.pendingAction.initiatorId !== socket.id) return;

    const initiator = room.getPlayerById(socket.id);
    const target = room.getPlayerById(targetId);
    if (!initiator || !initiator.isAlive || !target || !target.isAlive || target.id === initiator.id) return;

    const allCards = [
      ...initiator.hand.weapons,
      ...initiator.hand.shields,
      ...initiator.hand.treasures,
      ...initiator.hand.items,
      ...initiator.hand.malices,
    ];
    const hasCard = allCards.some(c => c.id === cardId);
    if (!hasCard) return;

    room.pendingAction.responses[socket.id] = { cardId, targetId };
    room.pendingAction.resolve();
    emitGameStateToAll(roomCode, room);
  });

  socket.on('submit_target', (roomCode, targetId) => {
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'RESOLVING_EVENT' || !room.pendingAction) return;
    if (room.pendingAction.type !== 'TARGET_SELECTION') return;

    const player = room.getPlayerById(socket.id);
    if (!player) return;

    if (room.pendingAction.eventName === '뒤바뀐 영혼' && targetId === socket.id) {
      socket.emit('action_result', '⚠️ 뒤바뀐 영혼은 자기 자신을 대상으로 선택할 수 없습니다.');
      return;
    }

    const isGhostEvent = room.pendingAction.eventName === '카르마' || room.pendingAction.eventName === '폴터가이스트';

    if (isGhostEvent) {
      if (player.isAlive) return;
      room.pendingAction.responses[socket.id] = targetId;
      const deadCount = room.players.filter(p => !p.isAlive).length;
      if (Object.keys(room.pendingAction.responses).length >= deadCount) {
        room.pendingAction.resolve();
        emitGameStateToAll(roomCode, room);
      }
    } else {
      if (room.pendingAction.initiatorId && socket.id !== room.pendingAction.initiatorId) return;
      room.pendingAction.responses[socket.id] = targetId;
      room.pendingAction.resolve();
      emitGameStateToAll(roomCode, room);
    }
  });

  socket.on('submit_transmutation', (roomCode, targetDeadPlayerId, cardIds) => {
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'RESOLVING_EVENT' || !room.pendingAction) return;
    if (room.pendingAction.eventName !== '인체 연성') return;
    if (socket.id !== room.pendingAction.initiatorId) return;

    const player = room.getPlayerById(socket.id);
    if (!player || !player.isAlive) return;

    // 스킵하기 (targetDeadPlayerId가 비었거나 cardIds가 0장인 경우)
    if (!targetDeadPlayerId || !cardIds || cardIds.length === 0) {
      room.pendingAction.responses[socket.id] = [];
      io.to(roomCode).emit('action_result', `⏩ ${player.name}님이 [인체 연성]을 진행하지 않고 스킵했습니다.`);
      room.pendingAction.resolve();
      emitGameStateToAll(roomCode, room);
      return;
    }

    // 부활 대상자 확인
    const deadTarget = room.players.find(p => p.id === targetDeadPlayerId && !p.isAlive);
    if (!deadTarget) return;

    // 제출된 도구 카드 2장 검증 (악의 카드가 아니어야 함)
    if (cardIds.length === 2) {
      const tool1 = room.findCardInPlayerHand(player, cardIds[0]);
      const tool2 = room.findCardInPlayerHand(player, cardIds[1]);

      if (tool1 && tool2 && tool1.category === 'TOOL' && tool2.category === 'TOOL') {
        const removed1 = room.removeCardFromHand(player, tool1.id);
        const removed2 = room.removeCardFromHand(player, tool2.id);
        if (removed1 && removed2) {
          room.graveyard.push(removed1, removed2);
          room.recalculateMalice(player);

          // 대상자 부활
          deadTarget.isAlive = true;
          deadTarget.hand = { malices: [], weapons: [], shields: [], treasures: [], items: [] };
          room.recalculateMalice(deadTarget);

          io.to(roomCode).emit(
            'action_result',
            `✨ ${player.name}님이 도구 카드 2장([${removed1.name}], [${removed2.name}])을 제물로 바쳐 [${deadTarget.name}]님을 부활시켰습니다!`
          );

          room.pendingAction.responses[socket.id] = [removed1.id, removed2.id];
          room.pendingAction.resolve();
          emitGameStateToAll(roomCode, room);
          return;
        }
      }
    }
  });

  socket.on('submit_cards', (roomCode, cardIds) => {
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'RESOLVING_EVENT' || !room.pendingAction) return;
    if (room.pendingAction.type !== 'CARD_SUBMISSION') return;
    
    const player = room.getPlayerById(socket.id);
    if (!player || !player.isAlive) return;

    // 룰렛은 1장만 제출 가능
    let actualCardIds = cardIds;
    if (room.pendingAction.eventName === '룰렛' && actualCardIds.length > 1) {
      actualCardIds = [actualCardIds[0]];
    }

    // 무장해제 처리 (모든 생존자가 각자 무기 1장 + 악의 1장 제출 또는 스킵 가능)
    if (room.pendingAction.eventName === '무장해제') {
      if (room.pendingAction.responses[socket.id]) return;

      if (actualCardIds && actualCardIds.length === 2 && actualCardIds[0] !== actualCardIds[1]) {
        const c1 = room.findCardInPlayerHand(player, actualCardIds[0]);
        const c2 = room.findCardInPlayerHand(player, actualCardIds[1]);

        const isWeapon = (c: any) => c && (c.category === 'WEAPON' || (c.category === 'TOOL' && c.toolType === 'WEAPON'));
        const isMalice = (c: any) => c && (c.category === 'MALICE' || ('maliceValue' in c && (c as any).maliceValue > 0) || ('evilScore' in c && (c as any).evilScore > 0));

        let weaponCard = null;
        let maliceCard = null;

        if (isWeapon(c1) && isMalice(c2)) {
          weaponCard = c1;
          maliceCard = c2;
        } else if (isWeapon(c2) && isMalice(c1)) {
          weaponCard = c2;
          maliceCard = c1;
        }

        if (weaponCard && maliceCard && weaponCard.id !== maliceCard.id) {
          room.removeCardFromHand(player, weaponCard.id);
          room.removeCardFromHand(player, maliceCard.id);
          room.graveyard.push(weaponCard, maliceCard);
          room.recalculateMalice(player);
          io.to(roomCode).emit('action_result', `⚔️ ${player.name}님이 [무장해제]로 [${weaponCard.name}]과 [${maliceCard.name}] 카드를 버렸습니다.`);
          room.pendingAction.responses[socket.id] = [weaponCard.id, maliceCard.id];
        } else {
          room.pendingAction.responses[socket.id] = [];
          io.to(roomCode).emit('action_result', `⏩ ${player.name}님이 [무장해제]를 스킵했습니다.`);
        }
      } else {
        room.pendingAction.responses[socket.id] = [];
        io.to(roomCode).emit('action_result', `⏩ ${player.name}님이 [무장해제]를 스킵했습니다.`);
      }

      const aliveCount = room.getAlivePlayers().length;
      if (Object.keys(room.pendingAction.responses).length >= aliveCount) {
        room.pendingAction.resolve();
      }
      emitGameStateToAll(roomCode, room);
      return;
    }

    // 면죄부 처리 (모든 생존자가 각자 보물 1장 + 악의 1장 제출 또는 스킵 가능)
    if (room.pendingAction.eventName === '면죄부') {
      if (room.pendingAction.responses[socket.id]) return;

      if (actualCardIds && actualCardIds.length === 2 && actualCardIds[0] !== actualCardIds[1]) {
        const c1 = room.findCardInPlayerHand(player, actualCardIds[0]);
        const c2 = room.findCardInPlayerHand(player, actualCardIds[1]);

        const isTreasure = (c: any) => c && (c.category === 'TREASURE' || (c.category === 'TOOL' && c.toolType === 'TREASURE'));
        const isMalice = (c: any) => c && (c.category === 'MALICE' || ('maliceValue' in c && (c as any).maliceValue > 0) || ('evilScore' in c && (c as any).evilScore > 0));

        let treasureCard = null;
        let maliceCard = null;

        if (isTreasure(c1) && isMalice(c2)) {
          treasureCard = c1;
          maliceCard = c2;
        } else if (isTreasure(c2) && isMalice(c1)) {
          treasureCard = c2;
          maliceCard = c1;
        }

        if (treasureCard && maliceCard && treasureCard.id !== maliceCard.id) {
          room.removeCardFromHand(player, treasureCard.id);
          room.removeCardFromHand(player, maliceCard.id);
          room.graveyard.push(treasureCard, maliceCard);
          room.recalculateMalice(player);
          io.to(roomCode).emit('action_result', `👑 ${player.name}님이 [면죄부]로 [${treasureCard.name}]과 [${maliceCard.name}] 카드를 버렸습니다.`);
          room.pendingAction.responses[socket.id] = [treasureCard.id, maliceCard.id];
        } else {
          room.pendingAction.responses[socket.id] = [];
          io.to(roomCode).emit('action_result', `⏩ ${player.name}님이 [면죄부]를 스킵했습니다.`);
        }
      } else {
        room.pendingAction.responses[socket.id] = [];
        io.to(roomCode).emit('action_result', `⏩ ${player.name}님이 [면죄부]를 스킵했습니다.`);
      }

      const aliveCount = room.getAlivePlayers().length;
      if (Object.keys(room.pendingAction.responses).length >= aliveCount) {
        room.pendingAction.resolve();
      }
      emitGameStateToAll(roomCode, room);
      return;
    }

    // 인체 연성 제물 제출 처리 (모든 생존자 0장 ~ 도구 카드 전체 제출 가능)
    if (room.pendingAction.eventName === '인체 연성') {
      if (room.pendingAction.responses[socket.id]) return;

      const removedCards = [];
      for (const cardId of actualCardIds) {
        const tool = room.findCardInPlayerHand(player, cardId);
        if (tool && tool.category === 'TOOL') {
          const removed = room.removeCardFromHand(player, cardId);
          if (removed) removedCards.push(removed);
        }
      }

      room.recalculateMalice(player);
      room.pendingAction.responses[socket.id] = removedCards;

      if (removedCards.length > 0) {
        io.to(roomCode).emit('action_result', `⚗️ ${player.name}님이 [인체 연성] 제물로 도구 카드 ${removedCards.length}장을 바쳤습니다.`);
      } else {
        io.to(roomCode).emit('action_result', `⏩ ${player.name}님이 [인체 연성]에 제물을 바치지 않았습니다.`);
      }

      const aliveCount = room.getAlivePlayers().length;
      if (Object.keys(room.pendingAction.responses).length >= aliveCount) {
        room.pendingAction.resolve();
      }
      emitGameStateToAll(roomCode, room);
      return;
    }

    // 마육검 경매에서 0장 입찰(포기) 처리
    if (actualCardIds.length === 0 && room.pendingAction.eventName === '마육검') {
      const resp: any = [];
      resp.submittedAt = Date.now();
      room.pendingAction.responses[socket.id] = resp;
      io.to(roomCode).emit('action_result', `${player.name}님이 [마육검] 입찰을 마쳤습니다.`);
      if (Object.keys(room.pendingAction.responses).length >= room.getAlivePlayers().length) {
        room.pendingAction.resolve();
      }
      emitGameStateToAll(roomCode, room);
      return;
    }

    // 제물 이벤트에서 0장 제출 (제물 바치지 않기) 처리
    if (actualCardIds.length === 0 && room.pendingAction.eventName === '제물') {
      const resp: any = [];
      resp.submittedAt = Date.now();
      room.pendingAction.responses[socket.id] = resp;
      io.to(roomCode).emit('action_result', `⏩ ${player.name}님이 [제물]을 바치지 않았습니다. (0장)`);

      const aliveCount = room.getAlivePlayers().length;
      const totalSubmitted = (Object.values(room.pendingAction.responses).flat() as any[]).length;
      const submittedPlayerCount = Object.keys(room.pendingAction.responses).length;

      if (totalSubmitted >= aliveCount || submittedPlayerCount >= aliveCount) {
        room.pendingAction.resolve();
      }
      emitGameStateToAll(roomCode, room);
      return;
    }

    // Remove cards from player's hand immediately
    const removedCards = [];
    for (const cardId of actualCardIds) {
      const card = room.removeCardFromHand(player, cardId);
      if (card) removedCards.push(card);
    }

    if (room.pendingAction.eventName === '제물') {
      room.recalculateMalice(player);
      (removedCards as any).submittedAt = Date.now();
      room.pendingAction.responses[socket.id] = removedCards;
      io.to(roomCode).emit('action_result', `⚗️ ${player.name}님이 [제물]로 도구 카드 ${removedCards.length}장을 바쳤습니다.`);

      const aliveCount = room.getAlivePlayers().length;
      const totalSubmitted = (Object.values(room.pendingAction.responses).flat() as any[]).length;
      const submittedPlayerCount = Object.keys(room.pendingAction.responses).length;

      if (totalSubmitted >= aliveCount || submittedPlayerCount >= aliveCount) {
        room.pendingAction.resolve();
      }
      emitGameStateToAll(roomCode, room);
      return;
    }
    
    if (removedCards.length > 0 || room.pendingAction.eventName === '마육검') {
      room.recalculateMalice(player);
      (removedCards as any).submittedAt = Date.now();
      room.pendingAction.responses[socket.id] = removedCards;
      
      if (room.pendingAction.eventName === '마육검') {
        io.to(roomCode).emit('action_result', `${player.name}님이 [마육검] 입찰을 마쳤습니다.`);
      }
      
      // 엑스칼리버 레이스 성공 판정: 남은 패가 0장이고, 제출한 카드 중에 악의가 없어야 함
      if (room.pendingAction.eventName === '엑스칼리버') {
        const handEmpty = player.hand.malices.length === 0 && player.hand.weapons.length === 0 && 
                          player.hand.shields.length === 0 && player.hand.treasures.length === 0 && 
                          player.hand.items.length === 0;
        if (handEmpty) {
          const hasMalice = removedCards.some(c => c.category === 'MALICE' || ('maliceValue' in c && (c as any).maliceValue > 0));
          if (!hasMalice) {
            const excaliburCard = {
              id: 'excalibur_' + Date.now(),
              category: 'TOOL',
              toolType: 'WEAPON',
              name: '엑스칼리버',
              description: '모든 방패를 뚫는 절대 무기.',
              isSpecial: true,
              maliceValue: 0
            };
            player.hand.weapons.push(excaliburCard as any);
            io.to(roomCode).emit('action_result', `🗡️ ${player.name}님이 가장 빨리 모든 패를 공개하여 결백을 증명하고 엑스칼리버를 획득했습니다! 이제 모든 방패를 뚫습니다.`);
            room.pendingAction.resolve(); // 제출된 카드들을 다시 모두에게 돌려줌
            emitGameStateToAll(roomCode, room);
            return;
          }
        }
      }

      // 룰렛/마육검 등 인원수 기준
      let targetSubmissionCount = room.getAlivePlayers().length;
      if (room.pendingAction.eventName === '룰렛') {
        const submitterIds = Object.keys(room.pendingAction.responses);
        const alivePlayersWithCards = room.getAlivePlayers().filter(
          p => submitterIds.includes(p.id) || room.getTotalHandCount(p) > 0
        );
        targetSubmissionCount = alivePlayersWithCards.length;
      }

      if (Object.keys(room.pendingAction.responses).length >= targetSubmissionCount) {
        room.pendingAction.resolve();
      }
      emitGameStateToAll(roomCode, room);
    }
  });

  socket.on('store_mayuk_sword', (roomCode) => {
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'RESOLVING_EVENT' || !room.pendingAction) return;
    if (room.pendingAction.eventName !== '마육검' || room.pendingAction.type !== 'TARGET_SELECTION') return;
    if (room.pendingAction.initiatorId !== socket.id) return;

    const winner = room.getPlayerById(socket.id);
    if (!winner || !winner.isAlive) return;

    const mayukCard = {
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

    room.addCardToHand(winner, mayukCard as any);
    room.recalculateMalice(winner);

    io.to(roomCode).emit('action_result', `📥 ${winner.name}님이 [마육검]을 패에 일반 무기로 보관했습니다.`);
    if (room.pendingAction.timer) clearTimeout(room.pendingAction.timer);
    room.pendingAction = null;
    room.returnToMainPhase();
    emitGameStateToAll(roomCode, room);
  });

  socket.on('use_mayuk_sword_now', (roomCode, targetId) => {
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'RESOLVING_EVENT' || !room.pendingAction) return;
    if (room.pendingAction.eventName !== '마육검' || room.pendingAction.type !== 'TARGET_SELECTION') return;
    if (room.pendingAction.initiatorId !== socket.id) return;

    const winner = room.getPlayerById(socket.id);
    const target = room.getPlayerById(targetId);
    if (!winner || !winner.isAlive || !target || !target.isAlive || target.id === winner.id) return;

    if (room.pendingAction.timer) clearTimeout(room.pendingAction.timer);
    room.pendingAction = null;

    const mayukCard = {
      id: 'mayuk_' + Date.now(),
      cardId: 113,
      category: 'EVENT',
      toolType: 'WEAPON',
      name: '마육검',
      description: '악의 경매로 즉시 발동된 마육검입니다.',
      detailedRule: '획득하여 즉시 사용할 때만 무기 공격 횟수를 소모하지 않으며, 피바라기와 마찬가지로 침묵으로 막을 수 없습니다.',
      isSpecial: true,
      maliceValue: 0,
      isImmediate: true
    };

    io.to(roomCode).emit(
      'action_result',
      `🩸 ${winner.name}님이 마육검을 즉시 휘둘러 ${target.name}님을 공격했습니다! (턴 무기 사용 제한 미소모)`
    );

    // 피격자 방어 단계 진행 (15초, 방패/포기)
    room.setupDefenseAgainstTarget(winner, target, mayukCard as any);
    emitGameStateToAll(roomCode, room);
  });

  socket.on('claim_excalibur', (roomCode) => {
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'RESOLVING_EVENT' || !room.pendingAction) return;
    if (room.pendingAction.eventName !== '엑스칼리버') return;

    const player = room.getPlayerById(socket.id);
    if (!player || !player.isAlive) return;

    // 엑스칼리버 획득 조건: 악의가 0장인 채로 가장 빠르게 패 공개
    const hasMaliceCards = player.hand.malices.length > 0;
    const hasMaliceScore = player.currentMalice > 0;

    if (hasMaliceCards || hasMaliceScore) {
      socket.emit('action_result', '⚠️ 악의를 보유한 상태에서는 엑스칼리버를 획득할 수 없습니다!');
      return;
    }

    const excaliburCard = {
      id: 'excalibur_' + Date.now(),
      cardId: 111,
      category: 'TOOL',
      toolType: 'WEAPON',
      name: '엑스칼리버',
      description: '모든 방패를 뚫는 절대 무기.',
      detailedRule: '패에 성공적으로 추가하면 일반 도구 카드인 특수 무기로 취급됩니다.',
      isSpecial: true,
      maliceValue: 0
    };

    player.hand.weapons.push(excaliburCard as any);
    room.recalculateMalice(player);

    io.to(roomCode).emit(
      'action_result',
      `🗡️ ${player.name}님이 가장 빠르게 모든 패를 공개하여 엑스칼리버를 획득했습니다! (모든 방패를 뚫습니다)`
    );

    room.pendingAction.resolve();
    emitGameStateToAll(roomCode, room);
  });

  socket.on('skip_excalibur', (roomCode) => {
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'RESOLVING_EVENT' || !room.pendingAction) return;
    if (room.pendingAction.eventName !== '엑스칼리버') return;

    const player = room.getPlayerById(socket.id);
    if (!player || !player.isAlive) return;

    if (!room.pendingAction.skippedPlayerIds) {
      room.pendingAction.skippedPlayerIds = [];
    }

    if (!room.pendingAction.skippedPlayerIds.includes(player.id)) {
      room.pendingAction.skippedPlayerIds.push(player.id);
    }

    const aliveCount = room.getAlivePlayers().length;
    if (room.pendingAction.skippedPlayerIds.length >= aliveCount) {
      io.to(roomCode).emit('action_result', '💨 모든 생존자가 포기하여 엑스칼리버가 사라졌습니다.');
      room.pendingAction.resolve();
      emitGameStateToAll(roomCode, room);
    } else {
      emitGameStateToAll(roomCode, room);
    }
  });

  socket.on('return_to_lobby', (roomCode) => {
    const room = rooms.get(roomCode);
    if (!room) return;

    room.resetToLobby();
    emitGameStateToAll(roomCode, room);
    emitRoomState(roomCode, room);
    io.to(roomCode).emit('action_result', `🔄 게임이 종료되고 모든 플레이어가 대기실로 복귀했습니다.`);
  });

  socket.on('interrupt_action', (roomCode, cardId, targetId) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    const player = room.getPlayerById(socket.id);
    if (!player || !player.isAlive || player.isSilenced) return;
    
    const itemIdx = player.hand.items.findIndex(c => c.id === cardId);
    if (itemIdx === -1) return;
    const item = player.hand.items[itemIdx];
    
    if (item.name === '긴급탈출키트') {
      const isDirectWeaponAttack = room.phase === 'WAITING_FOR_DEFENSE' && (room.pendingAction?.weaponCard || !room.activeEvent);
      if (isDirectWeaponAttack) {
        socket.emit('action_result', '⚠️ 칼(무기) 공격은 긴급탈출키트로 무효화할 수 없습니다! 방패를 사용하세요.');
        return;
      }

      if (room.phase !== 'RESOLVING_EVENT' && !room.activeEvent) {
        socket.emit('action_result', '⚠️ 긴급탈출키트는 진행 중인 이벤트를 취소할 때만 사용할 수 있습니다.');
        return;
      }

      if (room.pendingAction?.timer) clearTimeout(room.pendingAction.timer);

      // 이벤트 취소 시, 이미 제출된 카드가 있다면 주인에게 돌려줌
      if (room.pendingAction?.type === 'CARD_SUBMISSION') {
        for (const [pId, cards] of Object.entries(room.pendingAction.responses)) {
          const p = room.getPlayerById(pId);
          if (p) {
            (cards as any[]).forEach(c => room.addCardToHand(p, c));
            room.recalculateMalice(p);
          }
        }
      }

      room.returnToMainPhase();
      
      player.hand.items.splice(itemIdx, 1);
      room.graveyard.push(item);
      room.recalculateMalice(player);
      
      io.to(roomCode).emit('action_result', `🚀 ${player.name}님이 긴급탈출키트를 사용하여 진행 중인 이벤트를 무효화하고 취소했습니다!`);
      emitGameStateToAll(roomCode, room);
    } else if (item.name === '인간 방패') {
      // WAITING_FOR_DEFENSE 상태에서 내가 공격 타겟일 때만 사용 가능
      const currentTargetId = room.pendingAction?.targetId || (room.pendingAction?.eventName === '화살 함정' ? room.pendingAction?.initiatorId : null);
      if (room.phase === 'WAITING_FOR_DEFENSE' && currentTargetId === player.id && room.pendingAction) {
        const pending = room.pendingAction;
        const target = targetId ? room.getPlayerById(targetId) : null;
        // 자신 또는 (무기 공격인 경우) 최초 공격자 본인을 인간 방패로 지정할 수 없음
        const isOriginalAttacker = pending.initiatorId === target?.id && pending.eventName !== '화살 함정';
        if (target && target.isAlive && target.id !== player.id && !isOriginalAttacker) {
          player.hand.items.splice(itemIdx, 1);
          room.graveyard.push(item);
          room.recalculateMalice(player);
          
          pending.targetId = target.id;
          pending.responses = {}; // 기존 방어 리셋
          pending.skippedPlayerIds = []; // 기존 스킵 리셋
          if (pending.timer) clearTimeout(pending.timer);
          pending.deadline = Date.now() + room.eventTimeoutMs;
          pending.timer = setTimeout(() => {
            if (room.pendingAction) room.pendingAction.resolve();
          }, room.eventTimeoutMs);
          
          io.to(roomCode).emit('action_result', `👤 ${player.name}님이 ${target.name}님을 인간 방패로 내세웠습니다! ${target.name}님, 방어하세요! (${Math.round(room.eventTimeoutMs / 1000)}초)`);
          emitGameStateToAll(roomCode, room);
        } else {
          socket.emit('action_result', '⚠️ 인간 방패로 지정할 수 없는 대상입니다.');
        }
      } else {
        socket.emit('action_result', '⚠️ 현재 피격 대상자만 인간 방패를 사용할 수 있습니다.');
      }
    } else if (item.name === '침묵') {
      // 진행 중인 도구 공격(무기) 취소
      if (room.pendingAction && room.pendingAction.initiatorId) {
        // [중요] 피바라기 및 마육검(즉시 공격), 화살 함정 등 이벤트 카드로 인한 공격은 침묵으로 막을 수 없습니다!
        const isEventAttack =
          room.pendingAction.eventName === '피바라기' ||
          room.pendingAction.eventName === '화살 함정' ||
          room.pendingAction.eventName === '폴터가이스트' ||
          room.pendingAction.eventName === '마육검' ||
          room.activeEvent?.name === '마육검' ||
          (room.pendingAction.weaponCard as any)?.isImmediate ||
          (room.pendingAction.weaponCard as any)?.category === 'EVENT' ||
          !room.pendingAction.weaponCard;

        if (isEventAttack) {
          socket.emit('action_result', '⚠️ 피바라기, 마육검(즉시 공격) 등 이벤트 카드로 인한 공격은 침묵으로 막을 수 없습니다!');
          return;
        }

        const initiator = room.getPlayerById(room.pendingAction.initiatorId);
        if (initiator && initiator.id !== player.id) {
          // 타이머 정지 및 상태 초기화
          if (room.pendingAction.timer) clearTimeout(room.pendingAction.timer);
          
          // 침묵 아이템 소모
          player.hand.items.splice(itemIdx, 1);
          room.graveyard.push(item);
          room.recalculateMalice(player);
          
          initiator.isSilenced = true; // 침묵 상태 부여
          
          io.to(roomCode).emit('action_result', `🤫 ${player.name}님이 침묵을 발동하여 ${initiator.name}님의 도구 공격을 무효화했습니다!`);
          
          room.returnToMainPhase();
          
          emitGameStateToAll(roomCode, room);
        }
      }
    }
  });
  
  socket.on('play_item', (roomCode, cardId, targetIds) => {
    const room = rooms.get(roomCode);
    if (!room) return;

    const player = room.getPlayerById(socket.id);
    if (!player || !player.isAlive || player.isSilenced) return;

    if (room.phase !== 'MAIN' || room.currentTurnPlayerId !== socket.id) return;

    const itemIdx = player.hand.items.findIndex(c => c.id === cardId);
    if (itemIdx === -1) return;
    const item = player.hand.items[itemIdx];

    if (item.name === '인연의 끈') {
      if (!targetIds || targetIds.length !== 2) return;
      const t1 = room.getPlayerById(targetIds[0]);
      const t2 = room.getPlayerById(targetIds[1]);
      if (!t1 || !t2 || !t1.isAlive || !t2.isAlive || t1.id === t2.id) return;

      player.hand.items.splice(itemIdx, 1);
      room.graveyard.push(item);
      room.recalculateMalice(player);

      room.linkedPlayers = [t1.id, t2.id];
      io.to(roomCode).emit('action_result', `🔗 ${player.name}님이 인연의 끈을 사용하여 ${t1.name}님과 ${t2.name}님의 운명을 하나로 묶었습니다!`);
      emitGameStateToAll(roomCode, room);
    }
  });

  socket.on('cut_fate_link', (roomCode, weaponCardId) => {
    const room = rooms.get(roomCode);
    if (!room) return;

    const player = room.getPlayerById(socket.id);
    if (!player || !player.isAlive || player.isSilenced) return;

    if (!room.linkedPlayers || !room.linkedPlayers.includes(socket.id)) {
      socket.emit('action_result', '⚠️ 현재 인연의 끈으로 연결되어 있지 않습니다.');
      return;
    }

    const weaponIdx = player.hand.weapons.findIndex(w => w.id === weaponCardId);
    if (weaponIdx === -1) {
      socket.emit('action_result', '⚠️ 인연의 끈을 끊을 칼(무기)이 패에 없습니다.');
      return;
    }

    const weapon = player.hand.weapons.splice(weaponIdx, 1)[0];
    room.graveyard.push(weapon);
    room.recalculateMalice(player);

    const partnerId = room.linkedPlayers.find(id => id !== socket.id);
    const partner = partnerId ? room.getPlayerById(partnerId) : null;
    room.linkedPlayers = null;

    io.to(roomCode).emit(
      'action_result',
      `✂️ ${player.name}님이 [${weapon.name}]을(를) 소모하여 ${partner ? partner.name + '님과의 ' : ''}인연의 끈을 끊었습니다!`
    );

    emitGameStateToAll(roomCode, room);
  });
  socket.on('play_tool', (roomCode, cardId, targetId) => {
    const room = rooms.get(roomCode);
    if (!room) return;

    const player = room.getPlayerById(socket.id);
    const target = targetId ? room.getPlayerById(targetId) : undefined;
    if (!player || !player.isAlive || player.isSilenced) return;
    if (room.pendingAction) return; // 난투 등에서 동시 다발 공격 시 덮어쓰기 방지

    let weapon: any = null;
    let weaponIdx = player.hand.weapons.findIndex(c => c.id === cardId);
    
    if (weaponIdx !== -1) {
      weapon = player.hand.weapons[weaponIdx];
    }
    
    if (weapon) {
      if (!room.freeForAll) {
        if (room.phase !== 'MAIN') return;
        if (room.currentTurnPlayerId !== socket.id) return;
        if (player.hasUsedWeaponThisTurn) return;
      }
      
      if (!target || !target.isAlive || target.id === socket.id) return;

      // 모든 무기 카드는 사용 후 버립니다.
      if (weaponIdx !== -1) {
        player.hand.weapons.splice(weaponIdx, 1);
        room.graveyard.push(weapon);
        room.recalculateMalice(player);
      }
      
      if (!room.freeForAll) {
        player.hasUsedWeaponThisTurn = true;
      }

      room.phase = 'WAITING_FOR_DEFENSE';
      const action = {
        type: 'DEFENSE' as const,
        eventName: null,
        initiatorId: player.id,
        targetId: target.id,
        weaponCard: weapon,
        deadline: Date.now() + room.eventTimeoutMs,
        responses: {},
        resolve: () => {
          if (room.pendingAction?.timer) clearTimeout(room.pendingAction.timer);
          
          const responseValues = Object.values(room.pendingAction!.responses);
          const defended = responseValues.length > 0;
          const usedShield = defended ? responseValues[0] : null;
          
          const currentTargetId = room.pendingAction!.targetId!;
          const currentTarget = room.getPlayerById(currentTargetId);
          const attacker = room.getPlayerById(room.pendingAction!.initiatorId || '');
          
          if (!defended) {
            if (currentTarget && currentTarget.isAlive) {
              room.killPlayer(currentTarget.id, msg => io.to(roomCode).emit('action_result', msg));
              io.to(roomCode).emit('action_result', `🗡️ ${attacker?.name ?? '공격자'}님의 공격으로 ${currentTarget.name}님이 사망했습니다!`);
              
              if (weapon.name === '교화의 창' && attacker && attacker.isAlive) {
                attacker.hand.malices = [];
                room.recalculateMalice(attacker);
                io.to(roomCode).emit('action_result', `✨ 교화의 창 효과로 ${attacker.name}님의 모든 악의가 정화되었습니다!`);
              }
            }
            room.returnToMainPhase();
            emitGameStateToAll(roomCode, room);
          } else {
            if (usedShield === '거울 방패') {
              room.returnToMainPhase();
              emitGameStateToAll(roomCode, room);
            } else if (weapon.name === '필멸의 창') {
              const alivePlayers = room.getAlivePlayers();
              const targetIdx = alivePlayers.findIndex(p => p.id === currentTargetId);
              if (targetIdx !== -1 && alivePlayers.length > 1) {
                const nextTarget = alivePlayers[(targetIdx + 1) % alivePlayers.length];
                
                // 필멸의 창 튕기기: 타겟을 다음 사람으로, initiator를 방금 막아낸 사람으로 변경
                room.pendingAction!.initiatorId = currentTargetId;
                room.pendingAction!.targetId = nextTarget.id;
                room.pendingAction!.deadline = Date.now() + room.eventTimeoutMs;
                room.pendingAction!.responses = {}; 
                
                room.pendingAction!.timer = setTimeout(() => {
                  if (room.pendingAction) room.pendingAction.resolve();
                }, room.eventTimeoutMs);
                
                io.to(roomCode).emit('action_result', `🔄 필멸의 창이 방패에 튕겨 ${nextTarget.name}님에게 향합니다! 방패로 방어하세요! (${Math.round(room.eventTimeoutMs / 1000)}초)`);
                emitGameStateToAll(roomCode, room);
                return; // 상태 유지
              }
            } else {
              room.returnToMainPhase();
              emitGameStateToAll(roomCode, room);
            }
          }
        },
        timer: null as NodeJS.Timeout | null
      };
      
      action.timer = setTimeout(() => {
        if (room.pendingAction === action) action.resolve();
      }, room.eventTimeoutMs);
      
      room.pendingAction = action;
      io.to(roomCode).emit('action_result', `⚔️ ${player.name}님이 ${target.name}님을 공격했습니다! 방패로 방어하세요! (${Math.round(room.eventTimeoutMs / 1000)}초)`);
      emitGameStateToAll(roomCode, room);
    }
  });

  socket.on('skip_defense', (roomCode) => {
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'WAITING_FOR_DEFENSE' || !room.pendingAction) return;

    const player = room.getPlayerById(socket.id);
    if (!player || !player.isAlive) return;

    const isArrowTrap = room.pendingAction.eventName === '화살 함정';
    const targetId = room.pendingAction.targetId || (isArrowTrap ? room.pendingAction.initiatorId : null);
    const initiatorId = room.pendingAction.initiatorId;

    // 수호천사(또는 화살함정 시 일반 방패)를 가진 생존자 목록 (공격자/함정발동자 본인 제외)
    const interveningPlayers = isArrowTrap
      ? room.getAlivePlayers().filter(p => p.id !== targetId && p.hand.shields.length > 0)
      : room.getAlivePlayers().filter(p => p.id !== initiatorId && p.hand.shields.some(s => s.name === '수호천사'));

    const isTarget = targetId === socket.id;
    const canIntervene = interveningPlayers.some(p => p.id === socket.id);

    // 피격자이거나 방패(수호천사)를 가진 사람만 스킵 투표 가능
    if (!isTarget && !canIntervene) return;

    if (!room.pendingAction.skippedPlayerIds) {
      room.pendingAction.skippedPlayerIds = [];
    }

    if (!room.pendingAction.skippedPlayerIds.includes(socket.id)) {
      room.pendingAction.skippedPlayerIds.push(socket.id);
    }

    // 필수 스킵자 목록: 피격자 + 모든 개입 가능자
    const requiredSkippers = new Set<string>();
    if (targetId) requiredSkippers.add(targetId);
    for (const p of interveningPlayers) {
      requiredSkippers.add(p.id);
    }

    const allSkipped = Array.from(requiredSkippers).every(id =>
      room.pendingAction!.skippedPlayerIds!.includes(id)
    );

    const target = targetId ? room.getPlayerById(targetId) : null;

    if (allSkipped) {
      if (room.pendingAction?.timer) clearTimeout(room.pendingAction.timer);
      if (isArrowTrap) {
        io.to(roomCode).emit('action_result', `🏹 💥 ${target?.name ?? '생존자'}님과 다른 생존자들이 모두 방어를 포기하여 화살 함정에 맞아 사망했습니다!`);
      } else if (interveningPlayers.length > 0) {
        io.to(roomCode).emit('action_result', `💥 ${target?.name ?? '피격자'}님과 수호천사 보유자가 모두 방어를 포기하여 즉시 피격되었습니다!`);
      } else {
        io.to(roomCode).emit('action_result', `💥 ${player.name}님이 방어를 포기하고 공격을 그대로 받았습니다!`);
      }
      room.pendingAction?.resolve();
    } else {
      io.to(roomCode).emit('action_result', `🛡️ ${player.name}님이 방어/개입을 포기했습니다. (다른 생존자들의 결정을 대기 중...)`);
      emitGameStateToAll(roomCode, room);
    }
  });

  socket.on('play_shield', (roomCode, cardId, targetId) => {
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'WAITING_FOR_DEFENSE' || !room.pendingAction) return;
    
    const player = room.getPlayerById(socket.id);
    if (!player || !player.isAlive || player.isSilenced) return;
    
    const shieldIdx = player.hand.shields.findIndex(c => c.id === cardId);
    if (shieldIdx === -1) return;
    const shield = player.hand.shields[shieldIdx];
    
    if (room.pendingAction.weaponCard?.name === '엑스칼리버') {
      socket.emit('action_result', '⚠️ 엑스칼리버는 어떤 방패로도 막을 수 없습니다!');
      return; // 엑스칼리버 무기는 방어 불가
    }
    
    const isArrowTrap = room.pendingAction.eventName === '화살 함정';
    const attackTargetId = room.pendingAction.targetId || (isArrowTrap ? room.pendingAction.initiatorId : null);
    const isAttacker = room.pendingAction.initiatorId === socket.id;

    // 공격자 본인은 자신이 시도한 공격(피바라기 등)을 수호천사로 대신 막아줄 수 없습니다.
    if (shield.name === '수호천사' && isAttacker && attackTargetId !== socket.id) {
      socket.emit('action_result', '⚠️ 자신이 시도한 공격은 본인의 수호천사로 막아줄 수 없습니다!');
      return;
    }

    if (!isArrowTrap && shield.name !== '수호천사' && attackTargetId !== socket.id) {
      if (room.pendingAction.eventName !== '미끼') {
        return;
      }
    }
    
    player.hand.shields.splice(shieldIdx, 1);
    room.graveyard.push(shield);
    room.recalculateMalice(player);

    const pending = room.pendingAction;
    pending.responses[socket.id] = shield.name;
    if (pending.timer) clearTimeout(pending.timer);
    
    if (isArrowTrap) {
      const victim = attackTargetId ? room.getPlayerById(attackTargetId) : null;
      if (victim && victim.id !== player.id) {
        io.to(roomCode).emit('action_result', `🛡️ [화살 함정] ${player.name}님이 방패 [${shield.name}]을(를) 사용하여 ${victim.name}님을 화살 함정으로부터 지켜냈습니다!`);
      } else {
        io.to(roomCode).emit('action_result', `🛡️ [화살 함정] ${player.name}님이 방패 [${shield.name}]을(를) 사용하여 날아오는 화살을 막아냈습니다!`);
      }
    } else if (shield.name === '거울 방패' && pending.initiatorId) {
      const initiator = room.getPlayerById(pending.initiatorId);
      if (initiator && initiator.isAlive) {
        // [반사 처리] 거울 방패로 공격을 반사하면 원래 공격자가 새로운 피격 대상(target)이 되어 방어 기회를 가집니다!
        const defender = player;
        const newTarget = initiator;

        pending.initiatorId = defender.id;
        pending.targetId = newTarget.id;
        pending.deadline = Date.now() + room.eventTimeoutMs;
        pending.responses = {}; // 새로운 방어를 위해 응답 초기화
        delete (pending as any).skippedPlayerIds;

        pending.timer = setTimeout(() => {
          if (room.pendingAction === pending) pending.resolve();
        }, room.eventTimeoutMs);

        io.to(roomCode).emit(
          'action_result',
          `🪞 💥 ${defender.name}님이 [거울 방패]로 공격을 반사했습니다! 공격이 [${newTarget.name}]님에게 되돌아갑니다! 방패로 방어하세요! (${Math.round(room.eventTimeoutMs / 1000)}초)`
        );
        emitGameStateToAll(roomCode, room);
        return; // resolve()를 호출하지 않고 반사된 공격의 방어를 대기!
      } else {
        io.to(roomCode).emit('action_result', `🛡️ ${player.name}님이 [거울 방패]로 공격을 완벽히 튕겨냈습니다!`);
      }
    } else {
      io.to(roomCode).emit('action_result', `🛡️ ${player.name}님이 방패 [${shield.name}]으로 공격을 막아냈습니다!`);
    }

    if (room.pendingAction) {
      pending.resolve();
    }
    emitGameStateToAll(roomCode, room);
  });

  // ──────────────────────────────────────────────────────────────
  const handlePlayerLeave = (roomCode: string, socketId: string) => {
    const room = rooms.get(roomCode);
    if (!room) return;

    const player = room.getPlayerById(socketId);
    if (!player) return;

    console.log(`[Leave] Player ${player.name} (${socketId}) leaving room ${roomCode}`);

    if (room.phase === 'WAITING' || room.phase === 'ENDED') {
      room.removePlayer(socketId);
      if (room.players.length === 0) {
        rooms.delete(roomCode);
        console.log(`[Room Deleted] ${roomCode}`);
      } else {
        emitRoomState(roomCode, room);
        io.to(roomCode).emit('action_result', `🚪 ${player.name}님이 방을 나갔습니다.`);
      }
    } else {
      // 진행 중인 게임에서 이탈 처리
      if (room.pendingAction) {
        if (room.pendingAction.initiatorId === socketId || room.pendingAction.targetId === socketId) {
          if (room.pendingAction.timer) clearTimeout(room.pendingAction.timer);
          room.returnToMainPhase();
        }
      }

      if (player.isAlive) {
        room.killPlayer(player.id, (msg) => io.to(roomCode).emit('action_result', msg));
        io.to(roomCode).emit('action_result', `🚪 ${player.name}님이 방을 나가 탈락 처리되었습니다.`);
        io.to(roomCode).emit('player_died', player.id, player.name, player.hand);
      }

      room.removePlayer(socketId);

      if (room.players.length === 0) {
        rooms.delete(roomCode);
        console.log(`[Room Deleted] ${roomCode}`);
        return;
      }

      if (room.phase === 'MAIN' && room.currentTurnPlayerId === socketId) {
        room.nextTurn();
      }

      room.checkLastSurvivor();
      emitGameStateToAll(roomCode, room);
    }
  };

  socket.on('leave_room', (roomCode) => {
    handlePlayerLeave(roomCode, socket.id);
    socket.leave(roomCode);
  });

  socket.on('disconnect', () => {
    console.log(`[Disconnect] ${socket.id}`);

    for (const [roomCode, room] of rooms.entries()) {
      if (room.getPlayerById(socket.id)) {
        handlePlayerLeave(roomCode, socket.id);
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`🚀 악인 온라인 서버 running on port ${PORT}`);
});
