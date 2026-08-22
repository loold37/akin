import React, { useState } from 'react';
import { useSocket } from '../context/SocketContext';
import type { ToolCard, SanitizedGameState } from '../shared/types';
import { PlayerRing } from '../components/PlayerRing';
import { CenterBoard } from '../components/CenterBoard';
import { ChatBoard, ChatInput } from '../components/ChatBoard';
import { MyHand } from '../components/MyHand';
import { CardInfoPanel } from '../components/CardInfoPanel';
import { GameOverModal } from '../components/GameOverModal';
import {
  getCategoryBadgeClass,
  getCategoryKoreanName,
  getSafeMaliceValue,
  getSafeMaliceModifier,
} from '../utils/cardUtils';
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
    setHoveredCard,
    returnToLobby,
    leaveRoom,
  } = useSocket();

  const myId = socket?.id;
  const isMyTurn = gameState.currentTurnPlayerId === myId;
  const me = gameState.players.find((p) => p.id === myId);
  const isAlive = me?.isAlive ?? false;

  const [selectedWeapon, setSelectedWeapon] = useState<ToolCard | null>(null);
  const [selectedItem, setSelectedItem] = useState<ToolCard | null>(null);
  const [tiedPlayerTargets, setTiedPlayerTargets] = useState<string[]>([]);
  const [isChatFocused, setIsChatFocused] = useState<boolean>(false);
  const mobileDrawerRef = React.useRef<HTMLDivElement>(null);

  // ── [요청 반영] 모바일(안드로이드/iOS) 가상 키보드 뷰포트 높이 실시간 추적 ──
  React.useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const updateViewportHeight = () => {
      document.documentElement.style.setProperty('--visual-viewport-height', `${vv.height}px`);
      // iOS Safari에서 키보드가 올라올 때 브라우저 전체 윈도우가 위로 밀리는 현상 방지
      if (window.scrollY !== 0) {
        window.scrollTo(0, 0);
      }
    };

    vv.addEventListener('resize', updateViewportHeight);
    vv.addEventListener('scroll', updateViewportHeight);
    updateViewportHeight();

    return () => {
      vv.removeEventListener('resize', updateViewportHeight);
      vv.removeEventListener('scroll', updateViewportHeight);
    };
  }, []);

  // ── [요청 반영] 모바일에서 카드 설명창 외 다른 화면 부분을 누르면 설명창 닫기 ──
  React.useEffect(() => {
    if (!hoveredCard) return;

    const handlePointerDown = (e: MouseEvent | TouchEvent | PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;

      // 카드 설명창 내부를 터치/클릭한 경우 닫지 않음
      if (mobileDrawerRef.current && mobileDrawerRef.current.contains(target)) {
        return;
      }

      // 핸드 내 다른 카드 슬롯이나 채팅의 카드 링크를 누른 경우 해당 이벤트가 처리하도록 둠
      if (target.closest('.card-slot') || target.closest('.chat-card-link')) {
        return;
      }

      // 모바일 환경(<= 900px)에서 외부 클릭 시 설명창 닫기
      if (typeof window !== 'undefined' && window.innerWidth <= 900) {
        setHoveredCard(null);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [hoveredCard, setHoveredCard]);


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
    <div className={`game-board-layout ${isChatFocused ? 'keyboard-active' : ''}`}>
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

      {/* ── MOBILE ONLY: Floating Card Info Drawer (카드를 터치했을 때 위쪽에 부드럽게 뜨는 카드 상세 정보) ── */}
      {hoveredCard && (
        <div ref={mobileDrawerRef} className="mobile-card-floating-drawer">
          <div className="mobile-card-floating-header">
            <div className="mobile-card-title-group">
              <span className={`card-badge ${getCategoryBadgeClass(hoveredCard)}`}>
                {getCategoryKoreanName(hoveredCard)}
              </span>
              <span className="mobile-card-title-text">{hoveredCard.name}</span>
              {getSafeMaliceValue(hoveredCard) > 0 && (
                <span className="card-malice-val">악의 +{getSafeMaliceValue(hoveredCard)}</span>
              )}
              {getSafeMaliceModifier(hoveredCard) !== 0 && (
                <span className={`card-malice-mod ${getSafeMaliceModifier(hoveredCard) < 0 ? 'negative' : 'positive'}`}>
                  악의 {getSafeMaliceModifier(hoveredCard) > 0 ? `+${getSafeMaliceModifier(hoveredCard)}` : getSafeMaliceModifier(hoveredCard)}
                </span>
              )}
            </div>
            <button
              type="button"
              className="btn-close-mobile-card"
              onClick={() => setHoveredCard(null)}
              title="카드 정보 닫기"
            >
              ✕
            </button>
          </div>
          <div className="mobile-card-floating-body">
            <p className="mobile-card-desc-text">{hoveredCard.description}</p>
            {hoveredCard.detailedRule && (
              <div className="mobile-card-rule-box">
                <span className="mobile-card-rule-label">💡 세부 룰:</span>
                <span className="mobile-card-rule-text">{hoveredCard.detailedRule}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── MOBILE ONLY: 채팅 입력창 (카드들 밑 가장 아래) ── */}
      <div className="mobile-only-chat-input-bar">
        <ChatInput
          className="mobile-bottom-chat-input"
          placeholder="대화 입력 (Enter로 전송)"
          onFocusChange={setIsChatFocused}
        />
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
