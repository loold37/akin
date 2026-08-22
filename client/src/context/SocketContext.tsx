import React, { createContext, useContext, useEffect, useState, useRef } from 'react';
import type { ReactNode } from 'react';
import { io, Socket } from 'socket.io-client';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  SanitizedGameState,
  PublicPlayerInfo,
  EventCard,
  PlayerScore,
  Card,
} from '../shared/types';

interface ActionRequest {
  type: 'VOTE' | 'TARGET' | 'CARDS' | 'DEFENSE' | 'EXCALIBUR' | 'MAYUK_CHOICE' | 'PROPHECY';
  eventName?: string;
  initiatorId?: string;
  candidates?: string[];
  count?: number;
  prophecyCards?: Card[];
}

interface ChatMessage {
  id: string;
  sender: string;
  text: string;
  isSystem?: boolean;
  timestamp: string;
}

interface SocketContextType {
  socket: Socket<ServerToClientEvents, ClientToServerEvents> | null;
  isConnected: boolean;
  roomCode: string | null;
  playerName: string | null;
  roomPlayers: PublicPlayerInfo[];
  gameState: SanitizedGameState | null;
  activeEvents: EventCard[];
  actionLogs: string[];
  chatMessages: ChatMessage[];
  actionRequest: ActionRequest | null;
  gameOverScores: PlayerScore[] | null;
  isReturnedToLobby: boolean;
  hoveredCard: Card | null;
  setHoveredCard: (card: Card | null) => void;
  // Socket actions
  joinRoom: (code: string, name: string) => void;
  startGame: () => void;
  drawCard: () => void;
  endTurn: () => void;
  playTool: (cardId: string, targetId?: string) => void;
  playShield: (cardId: string, targetId?: string) => void;
  skipDefense: () => void;
  confirmReveal: () => void;
  claimExcalibur: () => void;
  skipExcalibur: () => void;
  storeMayukSword: () => void;
  useMayukSwordNow: (targetId: string) => void;
  cutFateLink: (weaponCardId: string) => void;
  killBaitMonster: (weaponCardId: string) => void;
  submitVote: (targetId: string, useDictatorship?: boolean) => void;
  submitTarget: (targetId: string) => void;
  submitGift: (cardId: string, targetId: string) => void;
  submitTransmutation: (targetDeadPlayerId: string, cardIds: string[]) => void;
  submitCards: (cardIds: string[]) => void;
  submitProphecy: (cardIds: string[]) => void;
  interruptAction: (cardId: string, targetId?: string) => void;
  playItem: (cardId: string, targetIds?: string[]) => void;
  sendChat: (message: string) => void;
  leaveRoom: () => void;
  returnToLobby: () => void;
  clearActionRequest: () => void;
}

const SocketContext = createContext<SocketContextType | undefined>(undefined);

const SERVER_URL =
  import.meta.env.VITE_SERVER_URL ||
  (typeof window !== 'undefined'
    ? `${window.location.protocol}//${window.location.hostname}:4000`
    : 'http://localhost:4000');

export const SocketProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [socket, setSocket] = useState<Socket<ServerToClientEvents, ClientToServerEvents> | null>(null);
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [roomCode, setRoomCode] = useState<string | null>(null);
  const [playerName, setPlayerName] = useState<string | null>(null);
  const [roomPlayers, setRoomPlayers] = useState<PublicPlayerInfo[]>([]);
  const [gameState, setGameState] = useState<SanitizedGameState | null>(null);
  const [activeEvents, setActiveEvents] = useState<EventCard[]>([]);
  const [actionLogs, setActionLogs] = useState<string[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [actionRequest, setActionRequest] = useState<ActionRequest | null>(null);
  const [gameOverScores, setGameOverScores] = useState<PlayerScore[] | null>(null);
  const [isReturnedToLobby, setIsReturnedToLobby] = useState<boolean>(false);
  const [hoveredCard, setHoveredCard] = useState<Card | null>(null);
  const prevHandCardsRef = useRef<Card[]>([]);

  useEffect(() => {
    const s: Socket<ServerToClientEvents, ClientToServerEvents> = io(SERVER_URL, {
      transports: ['websocket', 'polling'],
    });

    s.on('connect', () => {
      console.log('Connected to server with socket ID:', s.id);
      setIsConnected(true);
    });

    s.on('disconnect', () => {
      console.log('Disconnected from server');
      setIsConnected(false);
    });

    s.on('room_state_update', (players) => {
      setRoomPlayers(players);
    });

    s.on('game_state_update', (newGameState) => {
      setGameState(newGameState);
      if (newGameState.players) {
        setRoomPlayers(newGameState.players);
      }

      // [요청 반영] 카드를 새로 획득했을 때 데스크톱(PC) 환경에서만 카드 정보 창(hoveredCard)에 자동 표시
      if (newGameState.myInfo && newGameState.myInfo.hand) {
        const currentCards: Card[] = [
          ...newGameState.myInfo.hand.weapons,
          ...newGameState.myInfo.hand.shields,
          ...newGameState.myInfo.hand.items,
          ...newGameState.myInfo.hand.treasures,
          ...newGameState.myInfo.hand.malices,
        ];
        const prevIds = new Set(prevHandCardsRef.current.map((c) => c.id));
        const newlyAddedCards = currentCards.filter((c) => !prevIds.has(c.id));

        const isDesktop = typeof window !== 'undefined' && window.innerWidth > 900;

        if (isDesktop) {
          if (newlyAddedCards.length > 0 && prevHandCardsRef.current.length > 0) {
            const latestCard = newlyAddedCards[newlyAddedCards.length - 1];
            setHoveredCard(latestCard);
          } else if (prevHandCardsRef.current.length === 0 && currentCards.length > 0) {
            setHoveredCard(currentCards[0]);
          }
        }
        prevHandCardsRef.current = currentCards;
      }

      if (newGameState.phase === 'WAITING' || newGameState.phase === 'INITIAL_DRAW' || newGameState.phase === 'MAIN') {
        setGameOverScores(null);
        setIsReturnedToLobby(false);
        setActionRequest(null);
      } else if (newGameState.phase === 'WAITING_FOR_DEFENSE') {
        setActionRequest({
          type: 'DEFENSE',
          eventName: newGameState.defenseWeaponName
            ? `${newGameState.defenseWeaponName} 공격`
            : (newGameState.activeEventName || '공격 방어'),
        });
      } else if (newGameState.phase === 'RESOLVING_EVENT' && newGameState.activeEventName === '엑스칼리버') {
        setActionRequest({
          type: 'EXCALIBUR',
          eventName: '엑스칼리버',
        });
      } else if (newGameState.phase === 'RESOLVING_EVENT' && newGameState.mayukWinnerId) {
        if (newGameState.mayukWinnerId === s.id) {
          setActionRequest({
            type: 'MAYUK_CHOICE',
            eventName: '마육검',
            candidates: newGameState.players.filter((p) => p.isAlive && p.id !== s.id).map((p) => p.id),
          });
        } else {
          setActionRequest(null);
        }
      } else if (!newGameState.activeEventName) {
        setActionRequest(null);
      }
    });

    s.on('events_triggered', (events) => {
      setActiveEvents(events);
    });

    s.on('action_result', (message) => {
      setActionLogs((prev) => [...prev, message]);
      setChatMessages((prev) => [
        ...prev,
        {
          id: Math.random().toString(),
          sender: 'SYSTEM',
          text: message,
          isSystem: true,
          timestamp: new Date().toLocaleTimeString(),
        },
      ]);
    });

    s.on('chat_message', (senderName, msg) => {
      setChatMessages((prev) => [
        ...prev,
        {
          id: Math.random().toString(),
          sender: senderName,
          text: msg,
          isSystem: false,
          timestamp: new Date().toLocaleTimeString(),
        },
      ]);
    });

    s.on('player_died', (_id, name, _revealedHand) => {
      const deathMsg = `💀 ${name}님이 사망했습니다!`;
      setActionLogs((prev) => [...prev, deathMsg]);
    });

    s.on('game_over', (scores) => {
      setGameOverScores(scores);
      setIsReturnedToLobby(false);
    });

    s.on('game_started', () => {
      setGameOverScores(null);
      setIsReturnedToLobby(false);
      setActionRequest(null);
    });

    s.on('request_vote', (eventName, candidates, initiatorId) => {
      setActionRequest({
        type: 'VOTE',
        eventName,
        candidates,
        initiatorId,
      });
    });

    s.on('request_target', (eventName, validTargets) => {
      setActionRequest({
        type: 'TARGET',
        eventName,
        candidates: validTargets,
      });
    });

    s.on('request_mayuk_choice', (eventName, validTargets) => {
      setActionRequest({
        type: 'MAYUK_CHOICE',
        eventName,
        candidates: validTargets,
      });
    });

    s.on('request_cards', (eventName, count) => {
      if (eventName === '엑스칼리버') {
        setActionRequest({
          type: 'EXCALIBUR',
          eventName,
        });
      } else {
        setActionRequest({
          type: 'CARDS',
          eventName,
          count,
        });
      }
    });

    s.on('request_excalibur', (eventName) => {
      setActionRequest({
        type: 'EXCALIBUR',
        eventName,
      });
    });

    s.on('request_prophecy', (eventName, cards, initiatorId) => {
      setActionRequest({
        type: 'PROPHECY',
        eventName,
        prophecyCards: cards,
        initiatorId,
      });
    });

    setSocket(s);

    return () => {
      s.disconnect();
    };
  }, []);

  useEffect(() => {
    const handleBeforeUnload = () => {
      if (socket && roomCode) {
        socket.emit('leave_room', roomCode);
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [socket, roomCode]);

  // ── Action wrappers ───────────────────────────────────────────────
  const joinRoom = (code: string, name: string) => {
    if (!socket || !code.trim() || !name.trim()) return;
    setRoomCode(code.trim().toUpperCase());
    setPlayerName(name.trim());
    socket.emit('join_room', code.trim().toUpperCase(), name.trim());
  };

  const leaveRoom = () => {
    if (socket && roomCode) {
      socket.emit('leave_room', roomCode);
    }
    setRoomCode(null);
    setPlayerName(null);
    setGameState(null);
    setRoomPlayers([]);
    setActiveEvents([]);
    setActionLogs([]);
    setChatMessages([]);
    setActionRequest(null);
    setGameOverScores(null);
    setIsReturnedToLobby(false);
    setHoveredCard(null);
  };

  const startGame = () => {
    if (!socket || !roomCode) return;
    socket.emit('start_game', roomCode);
  };

  const drawCard = () => {
    if (!socket || !roomCode) return;
    socket.emit('draw_card', roomCode);
  };

  const endTurn = () => {
    if (!socket || !roomCode) return;
    socket.emit('end_turn', roomCode);
  };

  const playTool = (cardId: string, targetId?: string) => {
    if (!socket || !roomCode) return;
    socket.emit('play_tool', roomCode, cardId, targetId);
  };

  const playShield = (cardId: string, targetId?: string) => {
    if (!socket || !roomCode) return;
    socket.emit('play_shield', roomCode, cardId, targetId);
  };

  const skipDefense = () => {
    if (!socket || !roomCode) return;
    socket.emit('skip_defense', roomCode);
    setActionRequest(null);
  };

  const confirmReveal = () => {
    if (!socket || !roomCode) return;
    socket.emit('confirm_reveal', roomCode);
  };

  const claimExcalibur = () => {
    if (!socket || !roomCode) return;
    socket.emit('claim_excalibur', roomCode);
  };

  const skipExcalibur = () => {
    if (!socket || !roomCode) return;
    socket.emit('skip_excalibur', roomCode);
  };

  const storeMayukSword = () => {
    if (!socket || !roomCode) return;
    socket.emit('store_mayuk_sword', roomCode);
    setActionRequest(null);
  };

  const useMayukSwordNow = (targetId: string) => {
    if (!socket || !roomCode) return;
    socket.emit('use_mayuk_sword_now', roomCode, targetId);
    setActionRequest(null);
  };

  const cutFateLink = (weaponCardId: string) => {
    if (!socket || !roomCode) return;
    socket.emit('cut_fate_link', roomCode, weaponCardId);
  };

  const killBaitMonster = (weaponCardId: string) => {
    if (!socket || !roomCode) return;
    socket.emit('kill_bait_monster', roomCode, weaponCardId);
    setActionRequest(null);
  };

  const submitVote = (targetId: string, useDictatorship?: boolean) => {
    if (!socket || !roomCode) return;
    socket.emit('submit_vote', roomCode, targetId, useDictatorship);
    setActionRequest(null);
  };

  const submitTarget = (targetId: string) => {
    if (!socket || !roomCode) return;
    socket.emit('submit_target', roomCode, targetId);
    setActionRequest(null);
  };

  const submitGift = (cardId: string, targetId: string) => {
    if (!socket || !roomCode) return;
    socket.emit('submit_gift', roomCode, cardId, targetId);
    setActionRequest(null);
  };

  const submitTransmutation = (targetDeadPlayerId: string, cardIds: string[]) => {
    if (!socket || !roomCode) return;
    socket.emit('submit_transmutation', roomCode, targetDeadPlayerId, cardIds);
    setActionRequest(null);
  };

  const submitCards = (cardIds: string[]) => {
    if (!socket || !roomCode) return;
    socket.emit('submit_cards', roomCode, cardIds);
    setActionRequest(null);
  };

  const submitProphecy = (cardIds: string[]) => {
    if (!socket || !roomCode) return;
    socket.emit('submit_prophecy', roomCode, cardIds);
    setActionRequest(null);
  };

  const interruptAction = (cardId: string, targetId?: string) => {
    if (!socket || !roomCode) return;
    socket.emit('interrupt_action', roomCode, cardId, targetId);
  };

  const playItem = (cardId: string, targetIds?: string[]) => {
    if (!socket || !roomCode) return;
    socket.emit('play_item', roomCode, cardId, targetIds);
  };

  const sendChat = (message: string) => {
    if (!socket || !roomCode || !message.trim()) return;
    socket.emit('send_chat', roomCode, message.trim());
  };

  const returnToLobby = () => {
    if (socket && roomCode) {
      socket.emit('return_to_lobby', roomCode);
    }
    setGameOverScores(null);
    setIsReturnedToLobby(true);
    setActionRequest(null);
    setHoveredCard(null);
    prevHandCardsRef.current = [];
  };

  const clearActionRequest = () => {
    setActionRequest(null);
  };

  return (
    <SocketContext.Provider
      value={{
        socket,
        isConnected,
        roomCode,
        playerName,
        roomPlayers,
        gameState,
        activeEvents,
        actionLogs,
        chatMessages,
        actionRequest,
        gameOverScores,
        isReturnedToLobby,
        hoveredCard,
        setHoveredCard,
        joinRoom,
        startGame,
        drawCard,
        endTurn,
        playTool,
        playShield,
        skipDefense,
        confirmReveal,
        claimExcalibur,
        skipExcalibur,
        storeMayukSword,
        useMayukSwordNow,
        cutFateLink,
        killBaitMonster,
        submitVote,
        submitTarget,
        submitGift,
        submitTransmutation,
        submitCards,
        submitProphecy,
        interruptAction,
        playItem,
        sendChat,
        leaveRoom,
        returnToLobby,
        clearActionRequest,
      }}
    >
      {children}
    </SocketContext.Provider>
  );
};

export const useSocket = () => {
  const context = useContext(SocketContext);
  if (!context) {
    throw new Error('useSocket must be used within a SocketProvider');
  }
  return context;
};
