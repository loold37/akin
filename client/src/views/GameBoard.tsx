import React, { useState } from 'react';
import { useSocket } from '../context/SocketContext';
import type { ToolCard, SanitizedGameState } from '../shared/types';
import { PlayerRing } from '../components/PlayerRing';
import { CenterBoard } from '../components/CenterBoard';
import { ChatBoard, ChatInput } from '../components/ChatBoard';
import { MyHand } from '../components/MyHand';
import { CardInfoPanel } from '../components/CardInfoPanel';
import { GameOverModal } from '../components/GameOverModal';
import './GameBoard.css';

interface GameBoardProps {
  gameState: SanitizedGameState;
}

export const GameBoard: React.FC<GameBoardProps> = ({ gameState }) => {
  const {
    roomCode,
    socket,
    playTool,
    playShield,
    playItem,
    interruptAction,
    gameOverScores,
    hoveredCard,
    returnToLobby,
    leaveRoom,
  } = useSocket();

  const myId = socket?.id;
  const isMyTurn = gameState.currentTurnPlayerId === myId;
  const me = gameState.players.find((p) => p.id === myId);
  const isAlive = me?.isAlive ?? false;

  // ── Targeting mode state ──────────────────────────────────────────
  const [selectedWeapon, setSelectedWeapon] = useState<ToolCard | null>(null);
  const [selectedItem, setSelectedItem] = useState<ToolCard | null>(null);
  const [tiedPlayerTargets, setTiedPlayerTargets] = useState<string[]>([]);

  // ── Handlers for card clicks in MyHand ─────────────────────────────
  const handleSelectWeapon = (weapon: ToolCard) => {
    if (selectedWeapon?.id === weapon.id) {
      // 동일한 칼을 다시 누르면 공격 모드 취소
      setSelectedWeapon(null);
    } else {
      // 다른 칼을 누르면 해당 칼로 공격 모드 전환
      setSelectedWeapon(weapon);
      setSelectedItem(null);
    }
  };

  const handleSelectItem = (item: ToolCard) => {
    if (item.name === '인연의 끈') {
      if (selectedItem?.id === item.id) {
        setSelectedItem(null);
        setTiedPlayerTargets([]);
      } else {
        setSelectedItem(item);
        setSelectedWeapon(null);
        setTiedPlayerTargets([]);
      }
    } else if (item.name === '인간 방패') {
      if (gameState.phase === 'WAITING_FOR_DEFENSE') {
        if (selectedItem?.id === item.id) {
          setSelectedItem(null);
        } else {
          setSelectedItem(item);
          setSelectedWeapon(null);
          setTiedPlayerTargets([]);
        }
      }
    } else if (item.name === '긴급탈출키트') {
      interruptAction(item.id);
    } else if (item.name === '침묵') {
      playTool(item.id);
    }
  };

  const handleSelectShield = (shield: ToolCard) => {
    playShield(shield.id);
  };

  // Target selection handler when clicking on a player in PlayerRing
  const handleSelectTarget = (targetId: string) => {
    if (selectedWeapon) {
      playTool(selectedWeapon.id, targetId);
      setSelectedWeapon(null);
    } else if (selectedItem && selectedItem.name === '인간 방패') {
      interruptAction(selectedItem.id, targetId);
      setSelectedItem(null);
    } else if (selectedItem && selectedItem.name === '인연의 끈') {
      const newTargets = [...tiedPlayerTargets, targetId];
      setTiedPlayerTargets(newTargets);
      if (newTargets.length === 2) {
        playItem(selectedItem.id, newTargets);
        setSelectedItem(null);
        setTiedPlayerTargets([]);
      }
    }
  };

  const cancelTargeting = () => {
    setSelectedWeapon(null);
    setSelectedItem(null);
    setTiedPlayerTargets([]);
  };

  const canPlayWeapon =
    isAlive &&
    (gameState.freeForAll ||
      (isMyTurn && gameState.phase === 'MAIN' && !gameState.myInfo.hasUsedWeaponThisTurn));

  const isDefensePhase = gameState.phase === 'WAITING_FOR_DEFENSE';
  const isTargetingMode = selectedWeapon !== null || selectedItem !== null;

  return (
    <div className="game-board-layout">
      {/* ── TOP: Header & Other Players Ring ── */}
      <header className="game-top-bar">
        <div className="top-title-block">
          <span className="brand-logo">악인</span>
          <span className="room-badge">방 [{roomCode}]</span>
        </div>
        <div className="top-players-area">
          <PlayerRing
            players={gameState.players}
            currentTurnPlayerId={gameState.currentTurnPlayerId}
            targetSelectionMode={isTargetingMode}
            allowSelf={selectedItem?.name === '인연의 끈'}
            disabledTargetIds={
              selectedItem?.name === '인간 방패'
                ? gameState.defenseInitiatorId ? [gameState.defenseInitiatorId] : []
                : tiedPlayerTargets
            }
            onSelectTarget={handleSelectTarget}
          />
        </div>
        <div className="top-actions-area">
          <button
            type="button"
            className="btn-top-leave"
            onClick={() => {
              if (window.confirm('정말 게임에서 나가시겠습니까? (진행 중인 게임에서 탈락 처리됩니다)')) {
                leaveRoom();
              }
            }}
            title="게임 나가기"
          >
            나가기
          </button>
        </div>
      </header>

      {/* ── TARGETING PROMPT OVERLAY BAR ── */}
      {isTargetingMode && (
        <div className="targeting-banner">
          <span>
            🎯{' '}
            {selectedWeapon
              ? `[${selectedWeapon.name}] 공격 대상을 상단 생존자 중에서 클릭하세요!`
              : selectedItem?.name === '인간 방패'
              ? `[인간 방패] 대신 공격받을 생존자를 상단 생존자 중에서 클릭하세요!`
              : `[인연의 끈] 묶을 대상 2명을 순서대로 클릭하세요! (${tiedPlayerTargets.length}/2)`}
          </span>
          <button className="btn-cancel-target" onClick={cancelTargeting}>
            취소 ✕
          </button>
        </div>
      )}

      {/* ── MIDDLE: Center Board & Chat Log ── */}
      <main className="game-middle-section">
        <div className="middle-left-pane">
          <CenterBoard gameState={gameState} />
        </div>
        <div className="middle-right-pane desktop-only-chat">
          <ChatBoard silenceMode={gameState.silenceMode} />
        </div>
      </main>

      {/* ── BOTTOM: My Hand & Card Info Panel (God Field style) ── */}
      <footer className="game-bottom-bar">
        <MyHand
          hand={gameState.myInfo.hand}
          isMyTurn={isMyTurn}
          canPlayWeapon={canPlayWeapon}
          isDefensePhase={isDefensePhase}
          selectedCardId={selectedWeapon?.id || selectedItem?.id}
          onSelectWeapon={handleSelectWeapon}
          onSelectItem={handleSelectItem}
          onSelectShield={handleSelectShield}
        />
        <CardInfoPanel card={hoveredCard} />
      </footer>

      {/* ── MOBILE ONLY: 채팅 입력창 (카드들 밑 가장 아래) ── */}
      <div className="mobile-only-chat-input-bar">
        <ChatInput className="mobile-bottom-chat-input" placeholder="대화 입력 (Enter로 전송)" />
      </div>

      {/* ── GAME OVER MODAL ── */}
      {gameOverScores && (
        <GameOverModal
          scores={gameOverScores}
          onRestart={returnToLobby}
        />
      )}
    </div>
  );
};
