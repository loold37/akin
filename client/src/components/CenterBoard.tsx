import React, { useEffect, useRef, useState } from 'react';
import type { SanitizedGameState, Alignment } from '../shared/types';
import { useSocket } from '../context/SocketContext';
import { EventActionBoard } from './EventActionBoard';
import { ChatMessages } from './ChatBoard';
import './CenterBoard.css';

interface CenterBoardProps {
  gameState: SanitizedGameState;
}

export const CenterBoard: React.FC<CenterBoardProps> = ({ gameState }) => {
  const { drawCard, socket } = useSocket();
  const myId = socket?.id;
  const isMyTurn = gameState.currentTurnPlayerId === myId;
  const me = gameState.players.find((p) => p.id === myId);

  const [showFateOverlay, setShowFateOverlay] = useState<boolean>(false);

  const isLinked = !!(gameState.linkedPlayers && myId && gameState.linkedPlayers.includes(myId));
  const partnerId = isLinked ? gameState.linkedPlayers?.find((id) => id !== myId) : null;
  const partner = partnerId ? gameState.players.find((p) => p.id === partnerId) : null;

  // ── [요청 반영] 자동 드로우 메커니즘 ──────────────────────────────────
  const isDrawingRef = useRef<boolean>(false);

  useEffect(() => {
    // 내가 살아있고, 내 턴이며, MAIN 페이즈이고, 이번 턴에 아직 드로우를 완료하지 않았다면 0.4초 뒤 자동 드로우!
    if (
      isMyTurn &&
      gameState.phase === 'MAIN' &&
      !gameState.myInfo.hasDrawnThisTurn &&
      me?.isAlive &&
      !isDrawingRef.current
    ) {
      isDrawingRef.current = true;
      const timer = setTimeout(() => {
        drawCard();
        isDrawingRef.current = false;
      }, 400);
      return () => {
        clearTimeout(timer);
        isDrawingRef.current = false;
      };
    }
  }, [
    isMyTurn,
    gameState.phase,
    gameState.myInfo.hasDrawnThisTurn,
    gameState.currentTurnPlayerId,
    gameState.deckRemaining,
    gameState.activeEventName,
    me?.isAlive,
    drawCard,
  ]);

  const currentTurnPlayer = gameState.players.find(
    (p) => p.id === gameState.currentTurnPlayerId
  );

  const getPhaseName = () => {
    switch (gameState.phase) {
      case 'INITIAL_DRAW': return '시작 카드 배분 중';
      case 'MAIN': return '턴 진행 중';
      case 'RESOLVING_EVENT': return `이벤트 진행 중: [${gameState.activeEventName || '이벤트'}]`;
      case 'WAITING_FOR_DEFENSE': return '방어 대기 중';
      case 'DEAD_INTERACTION': return '사망자 상호작용 중';
      case 'ENDED': return '게임 종료';
      default: return gameState.phase;
    }
  };

  const myAlignment: Alignment = gameState.myInfo.alignment;
  const myMalice: number = gameState.myInfo.currentMalice;

  // ── [요청 반영] 실시간 타이머 계산 (60초 턴 타이머 & 이벤트 프리즈/전환) ──
  const [now, setNow] = useState<number>(Date.now());

  useEffect(() => {
    const interval = setInterval(() => {
      setNow(Date.now());
    }, 250);
    return () => clearInterval(interval);
  }, []);

  const isEventActive =
    gameState.phase !== 'MAIN' &&
    gameState.phase !== 'INITIAL_DRAW' &&
    gameState.phase !== 'ENDED' &&
    gameState.phase !== 'WAITING';

  // 이벤트 제한시간 (actionDeadline 기준)
  const eventTimeLeft = gameState.actionDeadline
    ? Math.max(0, Math.ceil((gameState.actionDeadline - now) / 1000))
    : 0;

  // 턴 제한시간 (MAIN 페이즈 시 turnDeadline 기준 카운트다운, 이벤트 중에는 프리즈된 turnRemainingSeconds 유지)
  const turnTimeLeft = gameState.isTurnTimerPaused
    ? (gameState.turnRemainingSeconds ?? 60)
    : gameState.turnDeadline
    ? Math.max(0, Math.ceil((gameState.turnDeadline - now) / 1000))
    : (gameState.turnRemainingSeconds ?? 60);

  return (
    <div className="center-board-wrapper">
      {/* ── TOP: Deck, Turn Status & My Identity ── */}
      <div className="center-top-row">
        {/* 1. 남은 카드(덱) */}
        <div className="center-deck-section">
          <div className="deck-visual-stack">
            <div className="deck-card-back">
              <span className="deck-symbol">🎴</span>
              <span className="deck-count-badge">{gameState.deckRemaining}</span>
            </div>
          </div>
          <div className="deck-info-label">남은 카드: <strong>{gameState.deckRemaining}장</strong></div>
        </div>

        {/* 2. 중앙 진행 페이즈 및 턴 알림 (가운데 완전 정렬) */}
        <div className="center-status-section">
          <div className="phase-pill">{getPhaseName()}</div>
          
          <div className="turn-announcement">
            {isMyTurn ? (
              <span className="my-turn-highlight">✨ 당신의 턴입니다!</span>
            ) : currentTurnPlayer ? (
              <span>👑 <strong>{currentTurnPlayer.name}</strong>님의 턴 진행 중...</span>
            ) : (
              <span>대기 중...</span>
            )}
          </div>

          {gameState.freeForAll && (
            <div className="free-for-all-banner">⚔️ 난투 모드 활성화! (누구나 무제한 공격 가능)</div>
          )}
        </div>

        {/* 3. 내 정보 (나의 상태) */}
        <div className="center-my-identity-section">
          <div className="identity-card">
            <div className="identity-header">나의 상태</div>
            <div className="identity-alignment-row">
              {me && !me.isAlive ? (
                <span className="alignment-tag dead">사망</span>
              ) : (
                <span className={`alignment-tag ${myAlignment.toLowerCase()}`}>
                  {myAlignment === 'GOOD' ? '선인' : '악인'}
                </span>
              )}
            </div>
            <div className="identity-malice-row">
              악의 수치: <strong className="malice-score">{myMalice}</strong>
            </div>
            {isLinked && partner && (
              <div className="identity-link-row">
                <button
                  className="btn-fate-link-badge"
                  onClick={() => setShowFateOverlay((prev) => !prev)}
                  title="인연의 끈 해제 팝업 열기"
                >
                  🔗 인연의 끈: {partner.name} (끊기)
                </button>
              </div>
            )}
          </div>
        </div>

        {/* 4. [요청 반영] 내 정보 오른쪽 타이머 전용 공간 (숫자만 깔끔하게 표시) */}
        <div 
          className={`center-timer-section ${isEventActive ? 'mode-event' : 'mode-turn'}`}
          title={isEventActive ? `이벤트 타이머: ${eventTimeLeft}초 (턴 타이머 정지)` : `턴 제한시간: ${turnTimeLeft}초`}
        >
          <span className={`timer-number ${(isEventActive ? eventTimeLeft : turnTimeLeft) <= 10 ? 'warning' : ''}`}>
            {isEventActive ? eventTimeLeft : turnTimeLeft}
          </span>
        </div>
      </div>

      {/* ── MOBILE ONLY: 게임 로그 및 대화 창 (3~4줄 높이) ── */}
      <div className="center-mobile-chat-log">
        <ChatMessages showHeader={false} className="mobile-chat-stream" />
      </div>

      {/* ── BOTTOM: [요청 반영] 팝업 대신 인라인으로 배치된 이벤트 및 투표/상호작용 패널 ── */}
      <div className="center-bottom-row">
        <EventActionBoard
          gameState={gameState}
          showFateOverlay={showFateOverlay}
          setShowFateOverlay={setShowFateOverlay}
        />
      </div>
    </div>
  );
};
