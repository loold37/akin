import React, { useState, useEffect } from 'react';
import { useSocket } from '../context/SocketContext';
import type { Card, SanitizedGameState } from '../shared/types';
import { sortCardsByNumber, getCategoryKoreanName } from './EventActionBoard';
import './ActionModals.css';

interface ActionModalsProps {
  gameState: SanitizedGameState;
}

export const ActionModals: React.FC<ActionModalsProps> = ({ gameState }) => {
  const {
    actionRequest,
    submitVote,
    submitTarget,
    submitCards,
    playShield,
    interruptAction,
    socket,
  } = useSocket();

  const [selectedCardIds, setSelectedCardIds] = useState<string[]>([]);
  const [timeLeft, setTimeLeft] = useState<number>(30);

  const myId = socket?.id;
  const myHand = gameState.myInfo.hand;
  const myShields = sortCardsByNumber(myHand.shields);
  const myInterruptItems = sortCardsByNumber(
    myHand.items.filter(
      (i) => i.name === '인간 방패' || i.name === '침묵' || i.name === '긴급탈출키트'
    )
  );

  // All my cards as a flat list for card submission
  const allMyCards: Card[] = sortCardsByNumber([
    ...myHand.weapons,
    ...myHand.shields,
    ...myHand.items,
    ...myHand.treasures,
    ...myHand.malices,
  ]);

  // Timer countdown effect
  useEffect(() => {
    const computeTime = () => {
      if (gameState.actionDeadline) {
        return Math.max(0, Math.ceil((gameState.actionDeadline - Date.now()) / 1000));
      }
      return gameState.eventTimeoutSeconds ?? 30;
    };

    setTimeLeft(computeTime());

    const interval = setInterval(() => {
      setTimeLeft(computeTime());
    }, 250);

    return () => clearInterval(interval);
  }, [actionRequest, gameState.actionDeadline, gameState.eventTimeoutSeconds]);

  if (!actionRequest) return null;

  const getCandidateName = (id: string) => {
    const player = gameState.players.find((p) => p.id === id);
    return player ? `${player.name}${player.id === myId ? ' (나)' : ''}` : id;
  };

  const toggleCardSelect = (cardId: string) => {
    setSelectedCardIds((prev) =>
      prev.includes(cardId) ? prev.filter((id) => id !== cardId) : [...prev, cardId]
    );
  };

  const handleCardSubmit = () => {
    if (selectedCardIds.length === 0) return;
    submitCards(selectedCardIds);
    setSelectedCardIds([]);
  };

  return (
    <div className="action-modal-overlay">
      <div className="action-modal-container">
        {/* 1. DEFENSE REQUEST */}
        {actionRequest.type === 'DEFENSE' && (
          <div className="modal-content defense-alert">
            <div className="modal-header">
              <span className="modal-alert-icon">⚠️</span>
              <h3 className="modal-title">공격/위험 방어 페이즈!</h3>
              <div className="modal-timer-badge">{timeLeft}초 남음</div>
            </div>
            <p className="modal-desc">
              공격 또는 함정 이벤트가 발생했습니다! 보유한 방패 카드를 사용하여 위기를 모면하세요.
            </p>

            <div className="defense-options-area">
              <div className="defense-section-title">🛡️ 보유한 방패 ({myShields.length}장)</div>
              {myShields.length === 0 ? (
                <div className="no-items-warning">보유한 방패 카드가 없습니다! 피격 시 사망합니다.</div>
              ) : (
                <div className="modal-cards-grid">
                  {myShields.map((shield) => (
                    <button
                      key={shield.id}
                      className="modal-card-btn btn-shield"
                      onClick={() => playShield(shield.id)}
                    >
                      <span className="btn-card-name">{shield.name}</span>
                      <span className="btn-card-desc">{shield.description}</span>
                    </button>
                  ))}
                </div>
              )}

              {myInterruptItems.length > 0 && (
                <>
                  <div className="defense-section-title" style={{ marginTop: '12px' }}>
                    🧪 긴급 대응 아이템
                  </div>
                  <div className="modal-cards-grid">
                    {myInterruptItems.map((item) => (
                      <button
                        key={item.id}
                        className="modal-card-btn btn-interrupt"
                        onClick={() => interruptAction(item.id)}
                      >
                        <span className="btn-card-name">{item.name}</span>
                        <span className="btn-card-desc">{item.description}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* 2. VOTE REQUEST */}
        {actionRequest.type === 'VOTE' && (
          <div className="modal-content vote-alert">
            <div className="modal-header">
              <span className="modal-alert-icon">⚖️</span>
              <h3 className="modal-title">생존자 투표: [{actionRequest.eventName}]</h3>
              <div className="modal-timer-badge">{timeLeft}초 남음</div>
            </div>
            <p className="modal-desc">처형 또는 지목할 대상 플레이어를 신중하게 선택해 주세요.</p>

            <div className="candidates-list">
              {actionRequest.candidates?.map((candidateId) => (
                <button
                  key={candidateId}
                  className="candidate-vote-btn"
                  onClick={() => submitVote(candidateId)}
                >
                  <span className="candidate-icon">👤</span>
                  <span className="candidate-name">{getCandidateName(candidateId)}</span>
                  <span className="vote-action-label">투표 ➔</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 3. TARGET REQUEST */}
        {actionRequest.type === 'TARGET' && (
          <div className="modal-content target-alert">
            <div className="modal-header">
              <span className="modal-alert-icon">🎯</span>
              <h3 className="modal-title">대상 지정: [{actionRequest.eventName}]</h3>
              <div className="modal-timer-badge">{timeLeft}초 남음</div>
            </div>
            <p className="modal-desc">효과를 적용할 대상을 선택해 주세요.</p>

            <div className="candidates-list">
              {actionRequest.candidates?.map((targetId) => (
                <button
                  key={targetId}
                  className="candidate-vote-btn btn-danger"
                  onClick={() => submitTarget(targetId)}
                >
                  <span className="candidate-icon">🎯</span>
                  <span className="candidate-name">{getCandidateName(targetId)}</span>
                  <span className="vote-action-label">선택</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 4. CARD SUBMISSION REQUEST */}
        {actionRequest.type === 'CARDS' && (
          <div className="modal-content cards-alert">
            <div className="modal-header">
              <span className="modal-alert-icon">🎴</span>
              <h3 className="modal-title">카드 제출: [{actionRequest.eventName}]</h3>
              <div className="modal-timer-badge">{timeLeft}초 남음</div>
            </div>
            <p className="modal-desc">
              이벤트 요구조건을 달성하기 위해 제출할 카드를 선택하세요.
            </p>

            <div className="submission-cards-scroll">
              {allMyCards.length === 0 ? (
                <div className="no-items-warning">제출할 수 있는 카드가 없습니다.</div>
              ) : (
                <div className="submission-cards-grid">
                  {allMyCards.map((card) => {
                    const isSelected = selectedCardIds.includes(card.id);
                    return (
                      <div
                        key={card.id}
                        className={`submission-card-item ${isSelected ? 'selected' : ''}`}
                        onClick={() => toggleCardSelect(card.id)}
                      >
                        <div className="sub-card-name">{card.name}</div>
                        <div className="sub-card-cat">{getCategoryKoreanName(card)}</div>
                        {isSelected && <div className="sub-check-badge">✓</div>}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="modal-footer-actions">
              <button
                className="btn-gold submit-action-btn"
                disabled={selectedCardIds.length === 0}
                onClick={handleCardSubmit}
              >
                카드 {selectedCardIds.length}장 제출하기
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
