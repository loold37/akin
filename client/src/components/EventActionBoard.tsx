import React, { useState, useEffect } from 'react';
import { useSocket } from '../context/SocketContext';
import type { Card, ToolCard, SanitizedGameState } from '../shared/types';
import {
  getCardIcon,
  getCategoryKoreanName,
  getSafeMaliceValue,
  sortCardsByNumber,
} from '../utils/cardUtils';
import './EventActionBoard.css';

export { sortCardsByNumber, getCategoryKoreanName } from '../utils/cardUtils';

export const isDeadOnlyEvent = (eventName?: string | null): boolean => {
  return eventName === '카르마' || eventName === '폴터가이스트';
};

interface EventActionBoardProps {
  gameState: SanitizedGameState;
  showFateOverlay?: boolean;
  setShowFateOverlay?: React.Dispatch<React.SetStateAction<boolean>>;
}

export const EventActionBoard: React.FC<EventActionBoardProps> = ({ 
  gameState,
  showFateOverlay,
  setShowFateOverlay,
}) => {
  const {
    actionRequest,
    submitVote,
    submitTarget,
    submitCards,
    claimExcalibur,
    skipExcalibur,
    storeMayukSword,
    useMayukSwordNow,
    cutFateLink,
    killBaitMonster,
    submitProphecy,
    playShield,
    skipDefense,
    confirmReveal,
    interruptAction,
    submitGift,
    endTurn,
    setHoveredCard: setHoveredCardRaw,
    socket,
  } = useSocket();

  const setHoveredCard = (card: Card | null) => {
    if (typeof window !== 'undefined' && window.innerWidth > 900) {
      setHoveredCardRaw(card);
    }
  };

  const [selectedCardIds, setSelectedCardIds] = useState<string[]>([]);
  const [useDictatorship, setUseDictatorship] = useState<boolean>(false);
  const [selectedGiftCardId, setSelectedGiftCardId] = useState<string | null>(null);
  const [selectedGiftTargetId, setSelectedGiftTargetId] = useState<string | null>(null);
  const [selectedDisarmWeaponId, setSelectedDisarmWeaponId] = useState<string | null>(null);
  const [selectedDisarmMaliceId, setSelectedDisarmMaliceId] = useState<string | null>(null);
  const [selectedIndulgenceTreasureId, setSelectedIndulgenceTreasureId] = useState<string | null>(null);
  const [selectedIndulgenceMaliceId, setSelectedIndulgenceMaliceId] = useState<string | null>(null);
  const [selectedTransmuteCardIds, setSelectedTransmuteCardIds] = useState<string[]>([]);
  const [selectedBaitWeaponId, setSelectedBaitWeaponId] = useState<string | null>(null);
  const [selectingHumanShield, setSelectingHumanShield] = useState<ToolCard | null>(null);
  const [prophecyCards, setProphecyCards] = useState<Card[]>([]);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [timeLeft, setTimeLeft] = useState<number>(30);

  const myId = socket?.id;
  const me = gameState.players.find((p) => p.id === myId);
  const isAlive = me?.isAlive ?? false;
  const isDead = !isAlive;
  const myHand = gameState.myInfo.hand;
  const myShields = sortCardsByNumber(myHand.shields);
  const isWeaponAttack = !!gameState.defenseWeaponName;
  const isEventAttack =
    !isWeaponAttack ||
    (gameState.activeEventName as string) === '피바라기' ||
    (gameState.activeEventName as string) === '마육검' ||
    (gameState.activeEventName as string) === '화살 함정' ||
    (gameState.activeEventName as string) === '폴터가이스트' ||
    gameState.defenseWeaponName === '피바라기' ||
    (gameState.defenseWeaponName === '마육검' && (gameState.activeEventName as string) === '마육검');

  const myInterruptItems = sortCardsByNumber(myHand.items.filter((i) => {
    if (i.name === '긴급탈출키트') return !isWeaponAttack; // 칼(무기) 공격에는 긴급탈출키트 사용 불가!
    if (i.name === '인간 방패') return true;
    if (i.name === '침묵') return isWeaponAttack && !isEventAttack; // 피바라기, 마육검(즉시 공격) 등 이벤트 공격에는 침묵 사용 불가!
    return false;
  }));

  const hasEscapeKit = myHand.items.some((i) => i.name === '긴급탈출키트');
  const hasDictatorCard = myHand.items.some((i) => i.name === '독재');

  const allMyCards: Card[] = sortCardsByNumber([
    ...myHand.weapons,
    ...myHand.shields,
    ...myHand.items,
    ...myHand.treasures,
    ...myHand.malices,
  ]);

  const isLinked = !!(gameState.linkedPlayers && myId && gameState.linkedPlayers.includes(myId));
  const partnerId = isLinked ? gameState.linkedPlayers?.find((id) => id !== myId) : null;
  const partner = partnerId ? gameState.players.find((p) => p.id === partnerId) : null;

  useEffect(() => {
    setUseDictatorship(false);
    setSelectedGiftCardId(null);
    setSelectedGiftTargetId(null);
    setSelectedDisarmWeaponId(null);
    setSelectedDisarmMaliceId(null);
    setSelectedIndulgenceTreasureId(null);
    setSelectedIndulgenceMaliceId(null);
    setSelectedTransmuteCardIds([]);
    setSelectedBaitWeaponId(null);
    setSelectingHumanShield(null);
    if (actionRequest?.type === 'PROPHECY' && actionRequest.prophecyCards) {
      setProphecyCards(actionRequest.prophecyCards);
    } else {
      setProphecyCards([]);
    }

    const computeTime = () => {
      if (gameState.actionDeadline) {
        return Math.max(0, Math.ceil((gameState.actionDeadline - Date.now()) / 1000));
      }
      return gameState.eventTimeoutSeconds ?? 30;
    };

    setTimeLeft(computeTime());

    const interval = setInterval(() => {
      setTimeLeft(computeTime());
    }, 1000);

    return () => clearInterval(interval);
  }, [actionRequest, gameState.actionDeadline, gameState.eventTimeoutSeconds]);

  const moveProphecyCard = (fromIdx: number, toIdx: number) => {
    if (toIdx < 0 || toIdx >= prophecyCards.length || fromIdx === toIdx) return;
    setProphecyCards((prev) => {
      const updated = [...prev];
      const [moved] = updated.splice(fromIdx, 1);
      updated.splice(toIdx, 0, moved);
      return updated;
    });
  };

  const handleDragStart = (idx: number) => {
    setDraggedIndex(idx);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = (targetIdx: number) => {
    if (draggedIndex === null || draggedIndex === targetIdx) return;
    moveProphecyCard(draggedIndex, targetIdx);
    setDraggedIndex(null);
  };

  const getCandidateName = (id: string) => {
    if (id === 'SAVE') return '💚 살린다 (구출)';
    if (id === 'DROP') return '🖤 살리지 않는다 (방치)';
    const player = gameState.players.find((p) => p.id === id);
    return player ? `${player.name}${player.id === myId ? ' (나)' : ''}` : id;
  };

  const toggleCardSelect = (cardId: string) => {
    if (actionRequest?.eventName === '룰렛') {
      setSelectedCardIds((prev) => (prev.includes(cardId) ? [] : [cardId]));
      return;
    }
    setSelectedCardIds((prev) =>
      prev.includes(cardId) ? prev.filter((id) => id !== cardId) : [...prev, cardId]
    );
  };

  const handleCardSubmit = () => {
    submitCards(selectedCardIds);
    setSelectedCardIds([]);
  };

  const activeEventAsCard: Card | null = gameState.activeEventName
    ? ({
        id: 'event_' + gameState.activeEventName,
        name: gameState.activeEventName,
        category: 'EVENT',
        description: gameState.activeEventDescription || '',
        detailedRule: gameState.activeEventDetailedRule || undefined,
      } as any)
    : null;

  const renderEventCardInfo = (
    gameState.activeEventDescription ? (
      <div
        className="embedded-event-card-desc"
        style={{ cursor: 'pointer' }}
        onMouseEnter={() => activeEventAsCard && setHoveredCard(activeEventAsCard)}
        onClick={() => activeEventAsCard && setHoveredCard(activeEventAsCard)}
      >
        <div className="event-desc-text">📜 "{gameState.activeEventDescription}"</div>
        {gameState.activeEventDetailedRule && (
          <div className="event-rule-text">💡 {gameState.activeEventDetailedRule}</div>
        )}
      </div>
    ) : null
  );

  // ── 0. FATE LINK (인연의 끈) OVERLAY ──────────────────────────────────
  if (showFateOverlay && isLinked && partner) {
    return (
      <div className="event-action-board fate-link-overlay">
        <div className="embedded-action-header">
          <span className="action-tag tag-danger">🔗 인연의 끈</span>
          <h4 className="embedded-action-title">[{partner.name}] 님과 운명이 연결됨</h4>
          <button
            className="btn-close-fate"
            onClick={() => setShowFateOverlay?.(false)}
            title="닫기"
          >
            ✕ 닫기
          </button>
        </div>
        <p className="embedded-action-desc">
          현재 [{partner.name}] 님과 운명이 연결되어 있어, 한쪽이 사망하면 다른 한쪽도 즉시 사망합니다!
          언제든 자신의 칼(무기) 카드를 1장 소모하여 이 인연을 끊을 수 있습니다.
        </p>

        <div className="fate-weapons-section">
          {myHand.weapons.length === 0 ? (
            <div className="empty-defense-warning" style={{ margin: '10px 0' }}>
              패에 칼(무기) 카드가 없어 인연의 끈을 끊을 수 없습니다.
            </div>
          ) : (
            <div style={{ margin: '10px 0' }}>
              <div style={{ fontSize: '0.85rem', color: '#ffb74d', marginBottom: '8px', fontWeight: 'bold' }}>
                소모할 칼(무기)을 선택하세요:
              </div>
              <div className="embedded-options-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '8px' }}>
                {sortCardsByNumber(myHand.weapons).map((weapon) => (
                  <button
                    key={weapon.id}
                    className="btn-embedded-target btn-danger"
                    onMouseEnter={() => setHoveredCard(weapon)}
                    onClick={() => {
                      setHoveredCard(weapon);
                      cutFateLink(weapon.id);
                      setShowFateOverlay?.(false);
                    }}
                  >
                    <span className="opt-avatar">🗡️</span>
                    <span className="opt-name">{weapon.name}</span>
                    <span className="opt-action-label">소모 & 끊기</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div style={{ marginTop: '10px', display: 'flex', justifyContent: 'flex-end' }}>
          <button
            className="btn-skip-defense"
            style={{ minHeight: '34px', padding: '0 14px' }}
            onClick={() => setShowFateOverlay?.(false)}
          >
            닫기 (진행 중인 화면으로 복귀)
          </button>
        </div>
      </div>
    );
  }

  // ── 0.1. REVEALED CARDS VIEW (패 전체 공개 이벤트) ──────────────────────────
  if (gameState.revealedCardsInfo) {
    const revealed = gameState.revealedCardsInfo;
    const isConfirmedByMe = myId ? (revealed.confirmedPlayerIds || []).includes(myId) : false;
    const alivePlayers = gameState.players.filter((p) => p.isAlive);
    const confirmedCount = (revealed.confirmedPlayerIds || []).length;
    const totalAlive = alivePlayers.length;

    return (
      <div className="event-action-board event-active revealed-cards-board">
        <div className="embedded-action-header">
          <span className="action-tag tag-gold">📜 패 전체 공개</span>
          <h4 className="embedded-action-title">
            [{gameState.activeEventName || '패 공개'}] - [{revealed.playerName}] 님의 모든 패
          </h4>
          {timeLeft > 0 && <span className="embedded-timer-badge">{timeLeft}초</span>}
        </div>

        {renderEventCardInfo}

        <div className="reveal-result-banner">
          <div className="reveal-reason-text">{revealed.reason}</div>
        </div>

        <div className="revealed-cards-container">
          <div className="revealed-cards-title">
            🎴 [{revealed.playerName}] 님이 보유한 모든 카드 ({revealed.cards.length}장):
          </div>

          {revealed.cards.length === 0 ? (
            <div className="empty-reveal-hand">보유 중인 카드가 0장입니다.</div>
          ) : (
            <div className="revealed-cards-grid">
              {sortCardsByNumber(revealed.cards).map((card, idx) => {
                const type =
                  card.category === 'TOOL' ? (card as ToolCard).toolType : card.category;
                const maliceVal = getSafeMaliceValue(card);
                return (
                  <div
                    key={`${card.id}-${idx}`}
                    className={`card-slot type-${type.toLowerCase()}`}
                    onMouseEnter={() => setHoveredCard(card)}
                    onClick={() => setHoveredCard(card)}
                  >
                    <div className="card-inner-box">
                      <div className="card-top-icon">{getCardIcon(type, card.name)}</div>
                      <div className="card-slot-name">{card.name}</div>
                      {type === 'MALICE' && (
                        <div className="card-sub-info">
                          {maliceVal === 2 || card.name === '짙은 악의' ? '악의x2' : '악의'}
                        </div>
                      )}
                      {type === 'WEAPON' && <div className="card-sub-info">무기</div>}
                      {type === 'SHIELD' && <div className="card-sub-info">방어</div>}
                      {type === 'ITEM' && <div className="card-sub-info">아이템</div>}
                      {type === 'TREASURE' && <div className="card-sub-info">보물</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="reveal-confirm-section">
          <div className="reveal-confirm-status">
            <span className="confirm-status-text">
              👥 확인 현황: <strong>{confirmedCount}</strong> / {totalAlive}명 확인 완료
            </span>
            <div className="bidding-status-chips">
              {alivePlayers.map((p) => {
                const hasConfirmed = (revealed.confirmedPlayerIds || []).includes(p.id);
                return (
                  <span
                    key={p.id}
                    className={`bidding-chip ${hasConfirmed ? 'done' : 'waiting'}`}
                  >
                    {hasConfirmed ? `✓ ${p.name}` : `⏳ ${p.name}`}
                  </span>
                );
              })}
            </div>
          </div>

          {isConfirmedByMe ? (
            <div className="reveal-confirmed-badge">
              <span>✅ 확인 완료! 다른 플레이어의 확인을 기다리는 중입니다...</span>
            </div>
          ) : (
            <button
              type="button"
              className="btn-confirm-reveal"
              onClick={() => confirmReveal()}
            >
              <span>확인 (다음 진행 ➔)</span>
            </button>
          )}
        </div>
      </div>
    );
  }

  // ── 0.5. DEAD SPECTATOR DURING LIVING EVENTS ──────────────────────────
  const currentEventName =
    actionRequest?.eventName ||
    gameState.activeEventName ||
    (gameState.phase === 'WAITING_FOR_DEFENSE'
      ? (gameState.defenseWeaponName ? `${gameState.defenseWeaponName} 공격` : '공격 방어')
      : null);

  if (
    isDead &&
    !isDeadOnlyEvent(currentEventName) &&
    (gameState.phase === 'RESOLVING_EVENT' ||
      gameState.phase === 'WAITING_FOR_DEFENSE' ||
      actionRequest)
  ) {
    const isDefensePhase =
      gameState.phase === 'WAITING_FOR_DEFENSE' || actionRequest?.type === 'DEFENSE';
    const isArrowTrap = currentEventName === '화살 함정';
    const targetPlayer = gameState.players.find((p) => p.id === gameState.defenseTargetId);
    const attackerPlayer = gameState.players.find((p) => p.id === gameState.defenseInitiatorId);

    return (
      <div className="event-action-board event-active dead-spectator-board">
        <div className="embedded-action-header">
          <span className="action-tag tag-gold">
            {isDefensePhase ? '⚔️ 공격/방어 진행 중' : '📜 이벤트 진행 중'}
          </span>
          <h4 className="embedded-action-title">
            [{currentEventName || '이벤트'}]
          </h4>
          {timeLeft > 0 && <span className="embedded-timer-badge">{timeLeft}초</span>}
        </div>

        {renderEventCardInfo}

        {isDefensePhase && (
          <p className="embedded-action-desc" style={{ marginTop: '6px' }}>
            {isArrowTrap
              ? `[${targetPlayer?.name || '생존자'}]님이 화살 함정을 밟았습니다. 방어 결과를 대기 중입니다.`
              : `${attackerPlayer ? `[${attackerPlayer.name}] 님의 공격이 ` : ''}${
                  targetPlayer ? `[${targetPlayer.name}] 님을 향하고 있습니다.` : '공격이 진행 중입니다.'
                }`}
          </p>
        )}

        <div className="dead-spectator-notice-box">
          <span className="dead-notice-icon">👻</span>
          <div className="dead-notice-content">
            <div className="dead-notice-title">사망자 안내</div>
            <div className="dead-notice-desc">
              사망한 플레이어는 수행할 수 없는 이벤트입니다.
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── 1. ACTIVE ACTION REQUEST (Defense / Vote / Target / Cards) ───────
  if (actionRequest) {
    const selectableCandidates =
      actionRequest.eventName === '구덩이'
        ? ['SAVE', 'DROP']
        : actionRequest.candidates && actionRequest.candidates.length > 0
        ? actionRequest.candidates
        : gameState.players.filter((p) => p.isAlive).map((p) => p.id);

    const selectableTargets =
      actionRequest.candidates && actionRequest.candidates.length > 0
        ? actionRequest.candidates
        : actionRequest.eventName === '뒤바뀐 영혼' || actionRequest.eventName === '선물' || actionRequest.eventName === '피바라기'
        ? gameState.players.filter((p) => p.isAlive && p.id !== myId).map((p) => p.id)
        : gameState.players.filter((p) => p.isAlive).map((p) => p.id);

    return (
      <div className={`event-action-board active-action type-${actionRequest.type.toLowerCase()}`}>
        <div className="event-action-scroll-area">
          {/* DEFENSE */}
          {actionRequest.type === 'DEFENSE' && (() => {
          const isArrowTrap = actionRequest.eventName === '화살 함정' || gameState.activeEventName === '화살 함정';
          const targetPlayer = gameState.players.find((p) => p.id === gameState.defenseTargetId);
          const attackerPlayer = gameState.players.find((p) => p.id === gameState.defenseInitiatorId);
          const isAttacker = gameState.defenseInitiatorId === myId;
          const isDirectTarget = !gameState.defenseTargetId || gameState.defenseTargetId === myId;
          const hasGuardianAngelInHand = !isAttacker && myShields.some((s) => s.name === '수호천사');
          const usableShields = isDirectTarget || isArrowTrap
            ? myShields
            : isAttacker
            ? []
            : myShields.filter((s) => s.name === '수호천사');

          const hasAlreadySkipped = (gameState.defenseSkippedPlayerIds || []).includes(myId || '');
          const hasGuardianAngelInGame = gameState.defenseHasGuardianAngel;

          return (
            <div className="embedded-action-box">
              <div className="embedded-action-header">
                <span className="action-tag tag-danger">
                  {isArrowTrap ? '🏹 화살 함정 발동' : isDirectTarget ? '🚨 피격 위기' : '⚔️ 공격 발생'}
                </span>
                <h4 className="embedded-action-title">
                  {isArrowTrap
                    ? `[화살 함정] 날아오는 화살 방어${targetPlayer ? ` ➔ ${isDirectTarget ? '나(본인)' : targetPlayer.name}` : ''}`
                    : `${attackerPlayer ? `${attackerPlayer.name}님의 ` : ''}${
                        gameState.defenseWeaponName ? `[${gameState.defenseWeaponName}] 공격` : (actionRequest.eventName || '위험 방어')
                      }${targetPlayer ? ` ➔ ${isDirectTarget ? '나(본인)' : targetPlayer.name}` : ''}`}
                </h4>
                <span className="embedded-timer-badge">{timeLeft}초</span>
              </div>
              
              <p className="embedded-action-desc">
                {isArrowTrap
                  ? isDirectTarget
                    ? '당신은 함정의 작동 장치를 밟았습니다! 날아오는 화살들을 생존자 중 한 명이 방패로 막지 않는다면 이 카드를 뽑은 자는 죽게 됩니다.'
                    : `[${targetPlayer?.name || '동료'}]님이 화살 함정을 밟았습니다! 생존자 중 한 명이 방패로 막아주지 않는다면 사망하게 됩니다.`
                  : isDirectTarget
                  ? hasGuardianAngelInGame
                    ? '공격이 나를 향하고 있습니다! (다른 생존자가 수호천사를 보유 중입니다. 피격자와 수호천사 보유자 모두가 포기해야 즉시 처리됩니다)'
                    : '공격이 나를 향하고 있습니다! 보유한 방패를 사용하거나, 방어가 불가능하면 아래 [방어 포기]를 눌러 즉시 맞으세요.'
                  : isAttacker
                  ? `${targetPlayer?.name || '동료'}님을 향한 나의 공격이 진행 중입니다. 방어 결과를 대기 중입니다.`
                  : hasGuardianAngelInHand
                  ? `${targetPlayer?.name || '동료'}님이 공격받고 있습니다. [수호천사]로 대신 막아주거나 [개입 포기]를 누르세요.`
                  : `${targetPlayer?.name || '동료'}님이 공격받고 있습니다. 방어 결과를 대기 중입니다.`}
              </p>

              <div className="embedded-action-content">
                {usableShields.length === 0 && (!isDirectTarget || myInterruptItems.length === 0) ? (
                  <div className="empty-defense-warning">
                    {isDirectTarget
                      ? '⚠️ 사용할 수 있는 방패나 대응 아이템이 없습니다!'
                      : isArrowTrap
                      ? 'ℹ️ 대신 막아줄 수 있는 방패 카드가 없습니다.'
                      : 'ℹ️ 대신 방어할 수 있는 수호천사 카드가 없습니다.'}
                  </div>
                ) : (
                  <div className="embedded-options-grid">
                    {sortCardsByNumber(usableShields).map((shield) => (
                      <button
                        key={shield.id}
                        className="btn-embedded-shield"
                        onMouseEnter={() => setHoveredCard(shield)}
                        onClick={() => {
                          setHoveredCard(shield);
                          playShield(shield.id);
                        }}
                      >
                        <span className="opt-name">🛡️ {shield.name}</span>
                        <span className="opt-action-label">{isDirectTarget ? '사용' : '구호'}</span>
                      </button>
                    ))}
                    {isDirectTarget &&
                      sortCardsByNumber(myInterruptItems).map((item) => (
                        <button
                          key={item.id}
                          className="btn-embedded-interrupt"
                          onMouseEnter={() => setHoveredCard(item)}
                          onClick={() => {
                            setHoveredCard(item);
                            if (item.name === '인간 방패') {
                              setSelectingHumanShield(item);
                            } else {
                              interruptAction(item.id);
                            }
                          }}
                        >
                          <span className="opt-name">🧪 {item.name}</span>
                          <span className="opt-action-label">{item.name === '인간 방패' ? '지정' : '발동'}</span>
                        </button>
                      ))}
                  </div>
                )}

                {/* 인간 방패 대상 지목 서브 패널 */}
                {selectingHumanShield && (
                  <div className="human-shield-picker-box">
                    <div className="human-shield-picker-title">
                      👤 <strong>[인간 방패]</strong> 대신 피격될 생존자를 선택하세요:
                    </div>
                    <div className="human-shield-candidates-grid">
                      {gameState.players
                        .filter(
                          (p) =>
                            p.isAlive &&
                            p.id !== myId &&
                            (isArrowTrap || p.id !== gameState.defenseInitiatorId)
                        )
                        .map((candidate) => (
                          <button
                            key={candidate.id}
                            type="button"
                            className="btn-candidate-human-shield"
                            onClick={() => {
                              interruptAction(selectingHumanShield.id, candidate.id);
                              setSelectingHumanShield(null);
                            }}
                          >
                            🎯 {candidate.name}
                          </button>
                        ))}
                      <button
                        type="button"
                        className="btn-cancel-human-shield"
                        onClick={() => setSelectingHumanShield(null)}
                      >
                        취소 ✕
                      </button>
                    </div>
                  </div>
                )}

                {/* 피격자 또는 방패 보유자 전용 방어/개입 포기(스킵) 버튼 */}
                {(isDirectTarget || (isArrowTrap ? myShields.length > 0 : hasGuardianAngelInHand)) && (
                  <div className="defense-skip-bar">
                    <button
                      className={`btn-skip-defense ${hasAlreadySkipped ? 'disabled-skipped' : ''}`}
                      disabled={hasAlreadySkipped}
                      onClick={skipDefense}
                    >
                      {hasAlreadySkipped
                        ? '✓ 방어/개입 포기 완료 (상대방 결정 대기 중...)'
                        : isDirectTarget
                        ? '☠️ 방어 포기 (즉시 피격 / 스킵)'
                        : '🚫 개입 포기 (스킵)'}
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })()}

        {/* VOTE */}
        {actionRequest.type === 'VOTE' && (() => {
          const isPitEvent = actionRequest.eventName === '구덩이';
          const isTransmuteVote = actionRequest.eventName === '인체 연성';
          const isBaitEvent = actionRequest.eventName === '미끼';
          const canUseDictator = !isPitEvent;
          const pitVictim = isPitEvent
            ? gameState.players.find((p) => p.id === actionRequest.initiatorId)
            : null;

          return (
            <div className="embedded-action-box">
              <div className="embedded-action-header">
                <span className={`action-tag ${isPitEvent || isBaitEvent ? 'tag-danger' : isTransmuteVote ? 'tag-blue' : 'tag-gold'}`}>
                  {isPitEvent ? '🕳️ 구덩이 발생' : isTransmuteVote ? '⚗️ 부활 투표' : isBaitEvent ? '👹 괴물 출현' : '⚖️ 투표 진행 중'}
                </span>
                <h4 className="embedded-action-title">
                  {isPitEvent
                    ? `[구덩이] ${pitVictim ? `${pitVictim.name}${pitVictim.id === myId ? ' (나)' : ''}` : '생존자'}님이 구덩이에 빠졌습니다!`
                    : isTransmuteVote
                    ? `[인체 연성] 부활시킬 사망자 투표`
                    : isBaitEvent
                    ? `[미끼] 괴물이 나타났습니다!`
                    : `[${actionRequest.eventName}] 생존자 투표`}
                </h4>
                <span className="embedded-timer-badge">{timeLeft}초</span>
              </div>
              {renderEventCardInfo}
              <p className="embedded-action-desc">
                {isPitEvent
                  ? `구덩이에 빠진 [${pitVictim ? pitVictim.name : '생존자'}]님을 살릴지 투표해 주세요. (단 한 명이라도 '살리지 않는다'를 선택하면 사망합니다. 시간 내 미투표 시 자동으로 '살린다'로 투표됩니다)`
                  : isTransmuteVote
                  ? '제물이 모여 인체 연성 의식이 시작되었습니다! 부활시킬 사망자 1명에게 투표해 주세요. (가장 많은 표를 받은 사망자가 부활하며, 동률 시 무작위 선정)'
                  : isBaitEvent
                  ? '괴물이 나타났습니다! 생존자 중 누구나 패에 있는 칼(무기) 카드를 클릭하여 괴물을 죽일 수 있습니다. (괴물 처치 시 즉시 투표가 취소되고 모두 생존합니다. 아무도 처치하지 못하면 투표 결과에 따라 미끼가 된 자가 사망합니다)'
                  : '생존자 회의에 따라 대상 플레이어에게 투표해 주세요. (다수결 또는 독재자 선택)'}
              </p>

              {/* [요청 반영] 미끼 이벤트 전용 괴물 표적 & 칼 카드 선택/처치 섹션 */}
              {isBaitEvent && (
                <div className="bait-monster-target-box">
                  <div className="monster-target-header">
                    <span className="monster-icon">👹</span>
                    <div className="monster-info">
                      <div className="monster-name">괴물 표적 (칼 1장으로 처치 시 즉시 전원 생존)</div>
                      <div className="monster-desc">
                        패에서 사용할 칼 카드를 선택한 후 [괴물 처치하기] 버튼을 누르세요.
                      </div>
                    </div>
                  </div>

                  {myHand.weapons.length === 0 ? (
                    <div className="empty-weapon-hint">
                      🗡️ 패에 사용할 수 있는 칼(무기) 카드가 없습니다. (다른 생존자가 처치하기를 기다리거나 미끼 투표를 진행하세요)
                    </div>
                  ) : (
                    <div className="bait-weapon-selection-container">
                      <div className="embedded-submission-cards-row">
                        {sortCardsByNumber(myHand.weapons).map((w) => {
                          const isSelected = selectedBaitWeaponId === w.id;
                          return (
                            <div
                              key={w.id}
                              className={`embedded-sub-card ${isSelected ? 'selected' : ''}`}
                              onMouseEnter={() => setHoveredCard(w)}
                              onClick={() => {
                                setHoveredCard(w);
                                setSelectedBaitWeaponId((prev) => (prev === w.id ? null : w.id));
                              }}
                            >
                              <span className="sub-c-name">{w.name}</span>
                              <span className="sub-c-cat">{getCategoryKoreanName(w)}</span>
                              {isSelected && <span className="sub-c-check">✓</span>}
                            </div>
                          );
                        })}
                      </div>

                      <button
                        type="button"
                        className="btn-kill-monster"
                        disabled={!selectedBaitWeaponId}
                        onClick={() => {
                          if (selectedBaitWeaponId) killBaitMonster(selectedBaitWeaponId);
                        }}
                      >
                        ⚔️ {selectedBaitWeaponId ? `선택한 [${myHand.weapons.find(w => w.id === selectedBaitWeaponId)?.name}] 카드로 괴물 처치하기` : '칼 카드를 선택해 주세요'}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {isBaitEvent && (
                <div className="bait-vote-section-title">
                  👥 괴물에게 던질 미끼 희생자 투표 (생존자 회의)
                </div>
              )}

              <div className="embedded-options-grid vote-grid">
                {selectableCandidates.map((candidateId) => (
                  <button
                    key={candidateId}
                    type="button"
                    className={`btn-embedded-vote ${candidateId === 'DROP' ? 'btn-danger' : ''}`}
                    style={
                      isPitEvent
                        ? {
                            borderColor: candidateId === 'SAVE' ? '#4caf50' : '#f44336',
                            backgroundColor:
                              candidateId === 'SAVE'
                                ? 'rgba(76, 175, 80, 0.15)'
                                : 'rgba(244, 67, 54, 0.15)',
                          }
                        : isTransmuteVote
                        ? {
                            borderColor: '#81d4fa',
                            backgroundColor: 'rgba(129, 212, 250, 0.12)',
                          }
                        : isBaitEvent
                        ? {
                            borderColor: '#ef5350',
                            backgroundColor: 'rgba(239, 83, 80, 0.08)',
                          }
                        : undefined
                    }
                    onClick={(e) => {
                      e.stopPropagation();
                      submitVote(candidateId, canUseDictator ? useDictatorship : false);
                    }}
                  >
                    <span className="opt-avatar">
                      {candidateId === 'SAVE' ? '💚' : candidateId === 'DROP' ? '🖤' : isTransmuteVote ? '💀' : isBaitEvent ? '🥩' : '👤'}
                    </span>
                    <span className="opt-name">{getCandidateName(candidateId)}</span>
                    <span className="opt-action-label">
                      {canUseDictator && useDictatorship ? '독재 선택' : isPitEvent ? '투표' : isTransmuteVote ? '부활 투표' : isBaitEvent ? '미끼 투표' : '선택'}
                    </span>
                  </button>
                ))}
              </div>

            {/* [요청 반영] 독재 카드 소지자 전용 토글 버튼 (구덩이를 제외한 투표 이벤트에서 표시) */}
            {hasDictatorCard && canUseDictator && (
              <div
                className="dictator-toggle-container"
                style={{
                  marginTop: '10px',
                  padding: '8px 12px',
                  background: useDictatorship ? 'rgba(255, 215, 0, 0.15)' : 'rgba(255, 255, 255, 0.04)',
                  border: `1px solid ${useDictatorship ? '#ffd54f' : '#455a64'}`,
                  borderRadius: '6px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  setUseDictatorship((prev) => !prev);
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: '18px' }}>👑</span>
                  <div>
                    <div style={{ fontSize: '11px', fontWeight: 'bold', color: useDictatorship ? '#ffd54f' : '#cfd8dc' }}>
                      [독재] 카드 발동 {useDictatorship ? '🟢 [ON / 발동]' : '⚪ [OFF / 미발동]'}
                    </div>
                    <div style={{ fontSize: '9px', color: useDictatorship ? '#ffe082' : '#90a4ae' }}>
                      {useDictatorship
                        ? '내가 투표한 대상이 다수결을 무시하고 강제로 확정됩니다! (투표 완료 시 독재 카드 소모)'
                        : '독재 카드를 아끼고 일반 다수결 투표로 참여합니다.'}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  className="btn-gold"
                  style={{
                    fontSize: '10px',
                    padding: '4px 10px',
                    height: '26px',
                    backgroundColor: useDictatorship ? '#ffb300' : '#37474f',
                    color: useDictatorship ? '#000000' : '#eceff1',
                    fontWeight: 800,
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setUseDictatorship((prev) => !prev);
                  }}
                >
                  {useDictatorship ? 'ON' : 'OFF'}
                </button>
              </div>
            )}

            {hasEscapeKit && (
              <div className="escape-kit-bar" style={{ marginTop: '12px' }}>
                <button
                  type="button"
                  className="btn-embedded-interrupt"
                  style={{ width: '100%', justifyContent: 'center' }}
                  onClick={(e) => {
                    e.stopPropagation();
                    const kit = myHand.items.find((i) => i.name === '긴급탈출키트');
                    if (kit) interruptAction(kit.id);
                  }}
                >
                  <span>🚀 [긴급탈출키트] 사용하여 이 이벤트 즉시 취소하기</span>
                </button>
              </div>
            )}
          </div>
        );
      })()}

        {/* TARGET (선물 전용 2단계 선택 UI) */}
        {actionRequest.type === 'TARGET' && actionRequest.eventName === '선물' && (
          <div className="embedded-action-box">
            <div className="embedded-action-header">
              <span className="action-tag tag-gold">🎁 선물 증정</span>
              <h4 className="embedded-action-title">[선물] 카드 및 선물 대상 선택</h4>
              <span className="embedded-timer-badge">{timeLeft}초</span>
            </div>
            {renderEventCardInfo}
            <p className="embedded-action-desc">
              패에서 선물할 카드 1장과 선물을 받을 다른 생존자 1명을 선택하세요. (제한시간 내 미선택 시 무작위 패/생존자에게 선물)
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '6px' }}>
              {/* 1. 선물할 카드 선택 */}
              <div>
                <div style={{ fontSize: '0.85rem', color: '#ffb74d', fontWeight: 'bold', marginBottom: '6px' }}>
                  1️⃣ 선물할 내 카드 1장 선택:
                </div>
                {allMyCards.length === 0 ? (
                  <div className="empty-defense-warning">선물할 수 있는 카드가 없습니다.</div>
                ) : (
                  <div className="embedded-submission-cards-row">
                    {allMyCards.map((card) => {
                      const isSelected = selectedGiftCardId === card.id;
                      return (
                        <div
                          key={card.id}
                          className={`embedded-sub-card ${isSelected ? 'selected' : ''}`}
                          onMouseEnter={() => setHoveredCard(card)}
                          onClick={() => {
                            setHoveredCard(card);
                            setSelectedGiftCardId(card.id);
                          }}
                        >
                          <span className="sub-c-name">{card.name}</span>
                          <span className="sub-c-cat">{getCategoryKoreanName(card)}</span>
                          {isSelected && <span className="sub-c-check">✓</span>}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* 2. 선물을 받을 생존자 선택 */}
              <div>
                <div style={{ fontSize: '0.85rem', color: '#81c784', fontWeight: 'bold', marginBottom: '6px' }}>
                  2️⃣ 선물을 받을 다른 생존자 1명 선택:
                </div>
                <div className="embedded-options-grid target-grid">
                  {selectableTargets.map((targetId) => {
                    const isSelected = selectedGiftTargetId === targetId;
                    return (
                      <button
                        key={targetId}
                        className={`btn-embedded-target ${isSelected ? 'selected' : ''}`}
                        style={{
                          backgroundColor: isSelected ? '#1b5e20' : '#1e293b',
                          borderColor: isSelected ? '#4caf50' : '#334155',
                        }}
                        onClick={() => setSelectedGiftTargetId(targetId)}
                      >
                        <span className="opt-avatar">👤</span>
                        <span className="opt-name">{getCandidateName(targetId)}</span>
                        <span className="opt-action-label">{isSelected ? '선택됨' : '선택'}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 3. 최종 선물 전송 버튼 */}
              <div style={{ marginTop: '4px' }}>
                <button
                  className="btn-gold embedded-submit-btn"
                  style={{ width: '100%' }}
                  disabled={!selectedGiftCardId || !selectedGiftTargetId}
                  onClick={() => {
                    if (selectedGiftCardId && selectedGiftTargetId) {
                      submitGift(selectedGiftCardId, selectedGiftTargetId);
                    }
                  }}
                >
                  🎁 선택한 카드를 생존자에게 선물하기
                </button>
              </div>
            </div>

            {hasEscapeKit && (
              <div className="escape-kit-bar">
                <button
                  className="btn-embedded-interrupt"
                  style={{ width: '100%', justifyContent: 'center' }}
                  onClick={() => {
                    const kit = myHand.items.find((i) => i.name === '긴급탈출키트');
                    if (kit) interruptAction(kit.id);
                  }}
                >
                  <span>🚀 [긴급탈출키트] 사용하여 이 이벤트 즉시 취소하기</span>
                </button>
              </div>
            )}
          </div>
        )}

        {/* TARGET (일반 대상 지정 이벤트) */}
        {actionRequest.type === 'TARGET' && actionRequest.eventName !== '선물' && (
          <div className="embedded-action-box">
            <div className="embedded-action-header">
              <span className="action-tag tag-danger">🎯 대상 선택</span>
              <h4 className="embedded-action-title">[{actionRequest.eventName}] 대상 지정</h4>
              <span className="embedded-timer-badge">{timeLeft}초</span>
            </div>
            {renderEventCardInfo}
            <p className="embedded-action-desc">효과를 적용할 생존자 1명을 지정하세요.</p>

            <div className="embedded-options-grid target-grid">
              {selectableTargets.map((targetId) => (
                <button
                  key={targetId}
                  className="btn-embedded-target btn-danger"
                  onClick={() => submitTarget(targetId)}
                >
                  <span className="opt-avatar">🎯</span>
                  <span className="opt-name">{getCandidateName(targetId)}</span>
                  <span className="opt-action-label">지목</span>
                </button>
              ))}
            </div>

            {hasEscapeKit && (
              <div className="escape-kit-bar">
                <button
                  className="btn-embedded-interrupt"
                  style={{ width: '100%', justifyContent: 'center' }}
                  onClick={() => {
                    const kit = myHand.items.find((i) => i.name === '긴급탈출키트');
                    if (kit) interruptAction(kit.id);
                  }}
                >
                  <span>🚀 [긴급탈출키트] 사용하여 이 이벤트 즉시 취소하기</span>
                </button>
              </div>
            )}
          </div>
        )}

        {/* EXCALIBUR RACE */}
        {(actionRequest.type === 'EXCALIBUR' || actionRequest.eventName === '엑스칼리버') && (() => {
          const hasMalice = gameState.myInfo.hand.malices.length > 0 || gameState.myInfo.currentMalice > 0;
          const hasSkipped = (gameState.excaliburSkippedPlayerIds || []).includes(myId || '');
          const totalSkipped = (gameState.excaliburSkippedPlayerIds || []).length;
          const totalAlive = gameState.players.filter((p) => p.isAlive).length;

          return (
            <div className="embedded-action-box">
              <div className="embedded-action-header">
                <span className="action-tag tag-gold">⚔️ 선착순 레이스</span>
                <h4 className="embedded-action-title">[엑스칼리버] 전 패 공개 & 획득 도전</h4>
                <span className="embedded-timer-badge">{timeLeft}초</span>
              </div>
              {renderEventCardInfo}
              <p className="embedded-action-desc">
                악의가 0장인 상태에서 가장 먼저 [제출]을 누르면 모든 방패를 뚫는 특수 무기 [엑스칼리버]를 획득합니다!
                모든 생존자가 포기하면 이벤트가 종료됩니다. (포기 현황: {totalSkipped} / {totalAlive}명)
              </p>

              {hasMalice && (
                <div className="empty-defense-warning" style={{ marginBottom: '8px' }}>
                  ⚠️ 현재 악의를 보유 중이므로 엑스칼리버를 획득할 수 없습니다. (포기 가능)
                </div>
              )}

              <div className="embedded-options-grid" style={{ gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <button
                  className="btn-embedded-vote"
                  style={{
                    backgroundColor: hasMalice ? '#2d3343' : '#3e2723',
                    borderColor: hasMalice ? '#4b5563' : '#ffb300',
                    cursor: hasMalice || hasSkipped ? 'not-allowed' : 'pointer',
                  }}
                  disabled={hasMalice || hasSkipped}
                  onClick={claimExcalibur}
                >
                  <span className="opt-avatar">🗡️</span>
                  <span className="opt-name">패 공개 및 엑스칼리버 획득 (제출)</span>
                  <span className="opt-action-label">{hasMalice ? '불가' : '도전'}</span>
                </button>

                <button
                  className={`btn-skip-defense ${hasSkipped ? 'disabled-skipped' : ''}`}
                  style={{ minHeight: '44px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  disabled={hasSkipped}
                  onClick={skipExcalibur}
                >
                  {hasSkipped ? '✓ 포기 완료 (대기 중...)' : '🚫 포기 (스킵)'}
                </button>
              </div>

              {hasEscapeKit && (
                <div className="escape-kit-bar">
                  <button
                    className="btn-embedded-interrupt"
                    style={{ width: '100%', justifyContent: 'center' }}
                    onClick={() => {
                      const kit = myHand.items.find((i) => i.name === '긴급탈출키트');
                      if (kit) interruptAction(kit.id);
                    }}
                  >
                    <span>🚀 [긴급탈출키트] 사용하여 이 이벤트 즉시 취소하기</span>
                  </button>
                </div>
              )}
            </div>
          );
        })()}

        {/* MAYUK SWORD CHOICE (Winner decides to attack immediately or store in hand) */}
        {(actionRequest.type === 'MAYUK_CHOICE' || actionRequest.eventName === '마육검_선택') && (
          <div className="embedded-action-box">
            <div className="embedded-action-header">
              <span className="action-tag tag-gold">👑 마육검 낙찰 완료</span>
              <h4 className="embedded-action-title">[마육검] 즉시 공격 vs 패에 보관</h4>
              <span className="embedded-timer-badge">{timeLeft}초</span>
            </div>
            {renderEventCardInfo}
            <p className="embedded-action-desc">
              마육검의 주인이 되었습니다! <strong>[즉시 공격]</strong>을 선택하면 이번 턴 무기 1회 사용 제한에 걸리지 않고 즉시 공격을 감행합니다. <strong>[패에 보관]</strong>하면 일반 무기(1턴 1회 제한)로 패에 저장됩니다.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '10px' }}>
              <div>
                <div style={{ fontSize: '0.85rem', color: '#ff8a80', fontWeight: 'bold', marginBottom: '6px' }}>
                  🗡️ 즉시 공격할 대상 생존자 선택 (턴 무기 제한 미소모):
                </div>
                <div className="embedded-options-grid target-grid">
                  {selectableTargets.map((targetId) => (
                    <button
                      key={targetId}
                      className="btn-embedded-target btn-danger"
                      onClick={() => useMayukSwordNow(targetId)}
                    >
                      <span className="opt-avatar">🎯</span>
                      <span className="opt-name">{getCandidateName(targetId)}</span>
                      <span className="opt-action-label">즉시 공격</span>
                    </button>
                  ))}
                </div>
              </div>

              <div style={{ borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '10px' }}>
                <button
                  className="btn-embedded-vote"
                  style={{ width: '100%', justifyContent: 'center', backgroundColor: '#1e293b' }}
                  onClick={storeMayukSword}
                >
                  <span className="opt-avatar">📥</span>
                  <span className="opt-name">패에 보관하기 (일반 무기화)</span>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* CARDS (무장해제 전용 UI) */}
        {actionRequest.type === 'CARDS' && actionRequest.eventName === '무장해제' && (() => {
          const availableDisarmWeapons = sortCardsByNumber(myHand.weapons);
          const availableDisarmMalices = sortCardsByNumber([
            ...myHand.malices,
            ...allMyCards.filter(
              (c) =>
                c.category !== 'MALICE' &&
                (('maliceValue' in c && (c as any).maliceValue > 0) || ('evilScore' in c && (c as any).evilScore > 0))
            ),
          ]);
          const isSameDisarmCardSelected = Boolean(
            selectedDisarmWeaponId &&
            selectedDisarmMaliceId &&
            selectedDisarmWeaponId === selectedDisarmMaliceId
          );

          return (
            <div className="embedded-action-box">
              <div className="embedded-action-header">
                <span className="action-tag tag-danger">⚔️ 무장해제</span>
                <h4 className="embedded-action-title">[무장해제] 무기 & 악의 카드 버리기</h4>
                <span className="embedded-timer-badge">{timeLeft}초</span>
              </div>
              {renderEventCardInfo}
              <p className="embedded-action-desc">
                패에서 버릴 무기 카드 1장과 악의 카드 1장을 각각 선택하고 [확인]을 누르세요. 버리기를 원치 않으면 [스킵]할 수 있습니다.
              </p>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '6px' }}>
                {/* 1. 버릴 무기 선택 */}
                <div>
                  <div style={{ fontSize: '0.85rem', color: '#ff8a80', fontWeight: 'bold', marginBottom: '6px' }}>
                    1️⃣ 버릴 무기 카드 1장 선택:
                  </div>
                  {availableDisarmWeapons.length === 0 ? (
                    <div className="empty-defense-warning">버릴 수 있는 무기 카드가 없습니다.</div>
                  ) : (
                    <div className="embedded-submission-cards-row">
                      {availableDisarmWeapons.map((card) => {
                        const isSelected = selectedDisarmWeaponId === card.id;
                        return (
                          <div
                            key={card.id}
                            className={`embedded-sub-card ${isSelected ? 'selected' : ''}`}
                            onMouseEnter={() => setHoveredCard(card)}
                            onClick={() => {
                              setHoveredCard(card);
                              setSelectedDisarmWeaponId((prev) => (prev === card.id ? null : card.id));
                            }}
                          >
                            <span className="sub-c-name">{card.name}</span>
                            <span className="sub-c-cat">{getCategoryKoreanName(card)}</span>
                            {isSelected && <span className="sub-c-check">✓</span>}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* 2. 버릴 악의 선택 */}
                <div>
                  <div style={{ fontSize: '0.85rem', color: '#ce93d8', fontWeight: 'bold', marginBottom: '6px' }}>
                    2️⃣ 버릴 악의 카드 1장 선택:
                  </div>
                  {availableDisarmMalices.length === 0 ? (
                    <div className="empty-defense-warning">버릴 수 있는 악의 카드가 없습니다.</div>
                  ) : (
                    <div className="embedded-submission-cards-row">
                      {availableDisarmMalices.map((card) => {
                        const isSelected = selectedDisarmMaliceId === card.id;
                        return (
                          <div
                            key={card.id}
                            className={`embedded-sub-card ${isSelected ? 'selected' : ''}`}
                            onMouseEnter={() => setHoveredCard(card)}
                            onClick={() => {
                              setHoveredCard(card);
                              setSelectedDisarmMaliceId((prev) => (prev === card.id ? null : card.id));
                            }}
                          >
                            <span className="sub-c-name">{card.name}</span>
                            <span className="sub-c-cat">{getCategoryKoreanName(card)}</span>
                            {isSelected && <span className="sub-c-check">✓</span>}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* 동일 아이템 선택 시 경고 */}
                {isSameDisarmCardSelected && (
                  <div className="empty-defense-warning" style={{ color: '#ff5252' }}>
                    ⚠️ [누군가의 ~] 카드는 단독으로(무기와 악의 동시 1장 취급으로) 버릴 수 없으며, 서로 다른 카드 2장을 선택해야 합니다.
                  </div>
                )}

                {/* 3. 확인 / 스킵 버튼 */}
                <div style={{ display: 'flex', gap: '8px', marginTop: '6px' }}>
                  <button
                    className="btn-gold embedded-submit-btn"
                    style={{ flex: 1 }}
                    disabled={!selectedDisarmWeaponId || !selectedDisarmMaliceId || isSameDisarmCardSelected}
                    onClick={() => {
                      if (selectedDisarmWeaponId && selectedDisarmMaliceId && !isSameDisarmCardSelected) {
                        submitCards([selectedDisarmWeaponId, selectedDisarmMaliceId]);
                      }
                    }}
                  >
                    🗑️ 선택한 무기와 악의 버리기 (확인)
                  </button>
                  <button
                    className="btn-skip-defense"
                    style={{ minHeight: '44px', padding: '0 16px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                    onClick={() => submitCards([])}
                  >
                    ⏩ 스킵하기
                  </button>
                </div>
              </div>

              {hasEscapeKit && (
                <div className="escape-kit-bar" style={{ marginTop: '12px' }}>
                  <button
                    type="button"
                    className="btn-embedded-interrupt"
                    style={{ width: '100%', justifyContent: 'center' }}
                    onClick={(e) => {
                      e.stopPropagation();
                      const kit = myHand.items.find((i) => i.name === '긴급탈출키트');
                      if (kit) interruptAction(kit.id);
                    }}
                  >
                    <span>🚀 [긴급탈출키트] 사용하여 이 이벤트 즉시 취소하기</span>
                  </button>
                </div>
              )}
            </div>
          );
        })()}

        {/* CARDS (면죄부 전용 UI) */}
        {actionRequest.type === 'CARDS' && actionRequest.eventName === '면죄부' && (() => {
          const availableIndulgenceTreasures = sortCardsByNumber(myHand.treasures);
          const availableIndulgenceMalices = sortCardsByNumber([
            ...myHand.malices,
            ...allMyCards.filter(
              (c) =>
                c.category !== 'MALICE' &&
                (('maliceValue' in c && (c as any).maliceValue > 0) || ('evilScore' in c && (c as any).evilScore > 0))
            ),
          ]);
          const isSameIndulgenceCardSelected = Boolean(
            selectedIndulgenceTreasureId &&
            selectedIndulgenceMaliceId &&
            selectedIndulgenceTreasureId === selectedIndulgenceMaliceId
          );

          return (
            <div className="embedded-action-box">
              <div className="embedded-action-header">
                <span className="action-tag tag-gold">📜 면죄부</span>
                <h4 className="embedded-action-title">[면죄부] 보물 & 악의 카드 버리기</h4>
                <span className="embedded-timer-badge">{timeLeft}초</span>
              </div>
              {renderEventCardInfo}
              <p className="embedded-action-desc">
                패에서 버릴 보물 카드 1장과 악의 카드 1장을 각각 선택하고 [확인]을 누르세요. 버리기를 원치 않으면 [스킵]할 수 있습니다.
              </p>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '6px' }}>
                {/* 1. 버릴 보물 선택 */}
                <div>
                  <div style={{ fontSize: '0.85rem', color: '#ffb74d', fontWeight: 'bold', marginBottom: '6px' }}>
                    1️⃣ 버릴 보물 카드 1장 선택:
                  </div>
                  {availableIndulgenceTreasures.length === 0 ? (
                    <div className="empty-defense-warning">버릴 수 있는 보물 카드가 없습니다.</div>
                  ) : (
                    <div className="embedded-submission-cards-row">
                      {availableIndulgenceTreasures.map((card) => {
                        const isSelected = selectedIndulgenceTreasureId === card.id;
                        return (
                          <div
                            key={card.id}
                            className={`embedded-sub-card ${isSelected ? 'selected' : ''}`}
                            onMouseEnter={() => setHoveredCard(card)}
                            onClick={() => {
                              setHoveredCard(card);
                              setSelectedIndulgenceTreasureId((prev) => (prev === card.id ? null : card.id));
                            }}
                          >
                            <span className="sub-c-name">{card.name}</span>
                            <span className="sub-c-cat">{getCategoryKoreanName(card)}</span>
                            {isSelected && <span className="sub-c-check">✓</span>}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* 2. 버릴 악의 선택 */}
                <div>
                  <div style={{ fontSize: '0.85rem', color: '#ce93d8', fontWeight: 'bold', marginBottom: '6px' }}>
                    2️⃣ 버릴 악의 카드 1장 선택:
                  </div>
                  {availableIndulgenceMalices.length === 0 ? (
                    <div className="empty-defense-warning">버릴 수 있는 악의 카드가 없습니다.</div>
                  ) : (
                    <div className="embedded-submission-cards-row">
                      {availableIndulgenceMalices.map((card) => {
                        const isSelected = selectedIndulgenceMaliceId === card.id;
                        return (
                          <div
                            key={card.id}
                            className={`embedded-sub-card ${isSelected ? 'selected' : ''}`}
                            onMouseEnter={() => setHoveredCard(card)}
                            onClick={() => {
                              setHoveredCard(card);
                              setSelectedIndulgenceMaliceId((prev) => (prev === card.id ? null : card.id));
                            }}
                          >
                            <span className="sub-c-name">{card.name}</span>
                            <span className="sub-c-cat">{getCategoryKoreanName(card)}</span>
                            {isSelected && <span className="sub-c-check">✓</span>}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* 동일 아이템 선택 시 경고 */}
                {isSameIndulgenceCardSelected && (
                  <div className="empty-defense-warning" style={{ color: '#ff5252' }}>
                    ⚠️ [누군가의 ~] 카드는 단독으로(보물과 악의 동시 1장 취급으로) 버릴 수 없으며, 서로 다른 카드 2장을 선택해야 합니다.
                  </div>
                )}

                {/* 3. 확인 / 스킵 버튼 */}
                <div style={{ display: 'flex', gap: '8px', marginTop: '6px' }}>
                  <button
                    type="button"
                    className="btn-gold embedded-submit-btn"
                    style={{ flex: 1 }}
                    disabled={!selectedIndulgenceTreasureId || !selectedIndulgenceMaliceId || isSameIndulgenceCardSelected}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (selectedIndulgenceTreasureId && selectedIndulgenceMaliceId && !isSameIndulgenceCardSelected) {
                        submitCards([selectedIndulgenceTreasureId, selectedIndulgenceMaliceId]);
                      }
                    }}
                  >
                    👑 선택한 보물과 악의 버리기 (확인)
                  </button>
                  <button
                    type="button"
                    className="btn-skip-defense"
                    style={{ minHeight: '44px', padding: '0 16px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                    onClick={(e) => {
                      e.stopPropagation();
                      submitCards([]);
                    }}
                  >
                    ⏩ 스킵하기
                  </button>
                </div>
              </div>

              {hasEscapeKit && (
                <div className="escape-kit-bar" style={{ marginTop: '12px' }}>
                  <button
                    type="button"
                    className="btn-embedded-interrupt"
                    style={{ width: '100%', justifyContent: 'center' }}
                    onClick={(e) => {
                      e.stopPropagation();
                      const kit = myHand.items.find((i) => i.name === '긴급탈출키트');
                      if (kit) interruptAction(kit.id);
                    }}
                  >
                    <span>🚀 [긴급탈출키트] 사용하여 이 이벤트 즉시 취소하기</span>
                  </button>
                </div>
              )}
            </div>
          );
        })()}

        {/* CARDS (인체 연성 전용 제물 카드 제출 UI) */}
        {actionRequest.type === 'CARDS' && actionRequest.eventName === '인체 연성' && (() => {
          const alivePlayersCount = gameState.players.filter((p) => p.isAlive).length;
          const myToolCards: ToolCard[] = sortCardsByNumber([
            ...myHand.weapons,
            ...myHand.shields,
            ...myHand.treasures,
            ...myHand.items,
          ]);

          const toggleTransmuteCard = (cardId: string) => {
            setSelectedTransmuteCardIds((prev) =>
              prev.includes(cardId) ? prev.filter((id) => id !== cardId) : [...prev, cardId]
            );
          };

          return (
            <div className="embedded-action-box">
              <div className="embedded-action-header">
                <span className="action-tag tag-gold">⚗️ 인체 연성</span>
                <h4 className="embedded-action-title">[인체 연성] 제물 도구 카드 제출</h4>
                <span className="embedded-timer-badge">{timeLeft}초</span>
              </div>
              {renderEventCardInfo}
              <p className="embedded-action-desc">
                생존자들이 바친 도구 카드의 총합이 생존자 수(<strong>{alivePlayersCount}장</strong>) 이상 모이면 사망자 부활 투표가 진행됩니다.<br />
                (0장부터 보유한 도구 카드 전체까지 자유롭게 선택하여 바칠 수 있습니다)
              </p>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '6px' }}>
                <div>
                  <div style={{ fontSize: '0.85rem', color: '#ffb74d', fontWeight: 'bold', marginBottom: '6px' }}>
                    제물로 바칠 도구 카드 선택 ({selectedTransmuteCardIds.length}장 선택됨):
                  </div>
                  {myToolCards.length === 0 ? (
                    <div className="empty-defense-warning">
                      바칠 수 있는 도구 카드가 없습니다. (0장 제출 가능)
                    </div>
                  ) : (
                    <div className="embedded-submission-cards-row">
                      {myToolCards.map((card) => {
                        const isSelected = selectedTransmuteCardIds.includes(card.id);
                        return (
                          <div
                            key={card.id}
                            className={`embedded-sub-card ${isSelected ? 'selected' : ''}`}
                            onMouseEnter={() => setHoveredCard(card)}
                            onClick={() => {
                              setHoveredCard(card);
                              toggleTransmuteCard(card.id);
                            }}
                          >
                            <span className="sub-c-name">{card.name}</span>
                            <span className="sub-c-cat">{getCategoryKoreanName(card)}</span>
                            {isSelected && <span className="sub-c-check">✓</span>}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div style={{ display: 'flex', gap: '8px', marginTop: '6px' }}>
                  <button
                    className="btn-gold embedded-submit-btn"
                    style={{ flex: 1 }}
                    disabled={selectedTransmuteCardIds.length === 0}
                    onClick={() => submitCards(selectedTransmuteCardIds)}
                  >
                    ⚗️ 선택한 카드 ({selectedTransmuteCardIds.length}장) 제물로 제출하기
                  </button>
                  <button
                    className="btn-skip-defense"
                    style={{ minHeight: '44px', padding: '0 16px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                    onClick={() => submitCards([])}
                  >
                    🚫 제물 바치지 않기 (0장 제출)
                  </button>
                </div>
              </div>

              {hasEscapeKit && (
                <div className="escape-kit-bar">
                  <button
                    className="btn-embedded-interrupt"
                    style={{ width: '100%', justifyContent: 'center' }}
                    onClick={() => {
                      const kit = myHand.items.find((i) => i.name === '긴급탈출키트');
                      if (kit) interruptAction(kit.id);
                    }}
                  >
                    <span>🚀 [긴급탈출키트] 사용하여 이 이벤트 즉시 취소하기</span>
                  </button>
                </div>
              )}
            </div>
          );
        })()}

        {/* CARDS (일반 카드 제출 이벤트: 제물, 마육검, 룰렛 등) */}
        {actionRequest.type === 'CARDS' && actionRequest.eventName !== '엑스칼리버' && actionRequest.eventName !== '무장해제' && actionRequest.eventName !== '면죄부' && actionRequest.eventName !== '인체 연성' && actionRequest.eventName !== '무소유' && (() => {
          const selectableCards = (() => {
            if (actionRequest.eventName === '제물') {
              return sortCardsByNumber([
                ...myHand.weapons,
                ...myHand.shields,
                ...myHand.treasures,
                ...myHand.items,
              ]);
            }
            if (actionRequest.eventName === '마육검') {
              return sortCardsByNumber(
                allMyCards.filter(
                  (c) => c.category === 'MALICE' || ('maliceValue' in c && (c as any).maliceValue > 0) || ('evilScore' in c && (c as any).evilScore > 0)
                )
              );
            }
            return sortCardsByNumber(allMyCards);
          })();

          return (
            <div className="embedded-action-box">
              <div className="embedded-action-header">
                <span className="action-tag tag-blue">🎴 카드 제출</span>
                <h4 className="embedded-action-title">
                  {actionRequest.eventName === '마육검' ? '[마육검] 악의 경매 입찰' : `[${actionRequest.eventName}] 카드 제출`}
                </h4>
                <span className="embedded-timer-badge">{timeLeft}초</span>
              </div>
              {renderEventCardInfo}
              <p className="embedded-action-desc">
                {actionRequest.eventName === '마육검'
                  ? '마육검을 획득하고자 하는 생존자는 패에서 공개할 악의 카드(누군가의 ~ 포함)를 선택하여 입찰하세요. 가장 많은 악의를 공개한 생존자(동률 시 선착순)가 검을 차지합니다! (입찰 포기 가능)'
                  : actionRequest.eventName === '룰렛'
                  ? '패에서 원하는 카드 1장을 뒤집어 제출하세요. (셔플 후 무기를 받게 된 자는 방패로 막아야 합니다!)'
                  : actionRequest.eventName === '제물'
                  ? '악의를 제외한 도구 카드를 제출하여 목표치를 달성하세요. (누군가의 ~ 시리즈도 사용 가능)'
                  : '이벤트 요구조건을 충족하기 위해 제출할 카드를 클릭하여 선택하세요.'}
              </p>

              {actionRequest.eventName === '마육검' && (
                <div className="bidding-status-bar">
                  <div className="bidding-status-header">
                    📢 실시간 입찰 현황 ({(gameState.submittedPlayerIds || []).length}/{gameState.players.filter((p) => p.isAlive).length}명 완료)
                  </div>
                  <div className="bidding-status-chips">
                    {gameState.players
                      .filter((p) => p.isAlive)
                      .map((p) => {
                        const hasBid = (gameState.submittedPlayerIds || []).includes(p.id);
                        return (
                          <span
                            key={p.id}
                            className={`bidding-chip ${hasBid ? 'done' : 'waiting'}`}
                          >
                            {p.name} {hasBid ? '✓ (입찰 완료)' : '⏳ (입찰 중...)'}
                          </span>
                        );
                      })}
                  </div>
                </div>
              )}

              <div className="embedded-cards-selection">
                {selectableCards.length === 0 ? (
                  <div className="empty-defense-warning">
                    {actionRequest.eventName === '마육검'
                      ? '입찰에 사용할 수 있는 악의 카드가 없습니다. (입찰 포기 가능)'
                      : actionRequest.eventName === '제물'
                      ? '제출할 수 있는 도구 카드가 없습니다.'
                      : '제출할 수 있는 카드가 없습니다.'}
                  </div>
                ) : (
                  <div className="embedded-submission-cards-row">
                    {selectableCards.map((card) => {
                      const isSelected = selectedCardIds.includes(card.id);
                      return (
                        <div
                          key={card.id}
                          className={`embedded-sub-card ${isSelected ? 'selected' : ''}`}
                          onMouseEnter={() => setHoveredCard(card)}
                          onClick={() => {
                            setHoveredCard(card);
                            toggleCardSelect(card.id);
                          }}
                        >
                          <span className="sub-c-name">{card.name}</span>
                          <span className="sub-c-cat">{getCategoryKoreanName(card)}</span>
                          {isSelected && <span className="sub-c-check">✓</span>}
                        </div>
                      );
                    })}
                  </div>
                )}

                {actionRequest.eventName === '제물' ? (
                  <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
                    <button
                      className="btn-gold embedded-submit-btn"
                      style={{ flex: 1 }}
                      disabled={selectedCardIds.length === 0}
                      onClick={handleCardSubmit}
                    >
                      ⚗️ 선택한 도구 카드 {selectedCardIds.length}장 제물로 제출하기
                    </button>
                    <button
                      className="btn-skip-defense"
                      style={{ minHeight: '44px', padding: '0 16px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                      onClick={() => submitCards([])}
                    >
                      🚫 제물 바치지 않기 (0장)
                    </button>
                  </div>
                ) : actionRequest.eventName === '마육검' ? (
                  <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
                    <button
                      className="btn-gold embedded-submit-btn"
                      style={{ flex: 1 }}
                      disabled={selectedCardIds.length === 0}
                      onClick={handleCardSubmit}
                    >
                      🔥 선택한 악의 {selectedCardIds.length}장으로 입찰하기
                    </button>
                    <button
                      className="btn-skip-defense"
                      style={{ minHeight: '44px', padding: '0 16px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                      onClick={() => submitCards([])}
                    >
                      🚫 입찰 포기 (0장)
                    </button>
                  </div>
                ) : (
                  <button
                    className="btn-gold embedded-submit-btn"
                    disabled={selectedCardIds.length === 0}
                    onClick={handleCardSubmit}
                  >
                    {actionRequest.eventName === '룰렛'
                      ? `선택한 카드 ${selectedCardIds.length}장 룰렛에 넣기`
                      : `선택한 카드 ${selectedCardIds.length}장 제출하기`}
                  </button>
                )}
              </div>

              {hasEscapeKit && (
                <div className="escape-kit-bar">
                  <button
                    className="btn-embedded-interrupt"
                    style={{ width: '100%', justifyContent: 'center' }}
                    onClick={() => {
                      const kit = myHand.items.find((i) => i.name === '긴급탈출키트');
                      if (kit) interruptAction(kit.id);
                    }}
                  >
                    <span>🚀 [긴급탈출키트] 사용하여 이 이벤트 즉시 취소하기</span>
                  </button>
                </div>
              )}
            </div>
          );
        })()}

        {/* PROPHECY (예언: 드로우될 덱 맨 위 카드 순서 재배열) */}
        {actionRequest.type === 'PROPHECY' && (() => {
          const isInitiator = myId === actionRequest.initiatorId;
          const initiator = gameState.players.find((p) => p.id === actionRequest.initiatorId);

          if (!isInitiator) {
            return (
              <div className="embedded-action-box">
                <div className="embedded-action-header">
                  <span className="action-tag tag-purple">🔮 예언 진행 중</span>
                  <h4 className="embedded-action-title">
                    [{initiator ? initiator.name : '플레이어'}]님이 덱의 미래를 내다보고 있습니다...
                  </h4>
                  <span className="embedded-timer-badge">{timeLeft}초</span>
                </div>
                {renderEventCardInfo}
                <p className="embedded-action-desc">
                  [예언]을 발동한 플레이어가 앞으로 드로우될 카드들의 순서를 재배열하는 중입니다. 잠시만 기다려 주세요.
                </p>
              </div>
            );
          }

          return (
            <div className="embedded-action-box prophecy-action-box">
              <div className="embedded-action-header">
                <span className="action-tag tag-purple">🔮 예언의 서</span>
                <h4 className="embedded-action-title">[예언] 앞으로 드로우될 카드 순서 재배치</h4>
                <span className="embedded-timer-badge">{timeLeft}초</span>
              </div>
              {renderEventCardInfo}
              <p className="embedded-action-desc">
                앞으로 드로우될 카드 {prophecyCards.length}장입니다. <strong>[▲ 위로] [▼ 아래로]</strong> 버튼 또는 드래그하여 순서를 바꾼 뒤 <strong>[확인]</strong>을 누르세요.
              </p>

              <div className="prophecy-cards-list">
                {prophecyCards.map((card, idx) => {
                  const type = card.category === 'TOOL' ? (card as ToolCard).toolType : card.category;
                  const isFirst = idx === 0;
                  const isLast = idx === prophecyCards.length - 1;

                  return (
                    <div
                      key={card.id}
                      className={`prophecy-card-item ${draggedIndex === idx ? 'dragging' : ''} ${isFirst ? 'is-next-draw' : ''}`}
                      draggable
                      onDragStart={() => handleDragStart(idx)}
                      onDragOver={handleDragOver}
                      onDrop={() => handleDrop(idx)}
                    >
                      <div className="prophecy-order-badge">
                        <span className="order-num">{idx + 1}</span>
                        <span className="order-text">{isFirst ? '다음 드로우' : `${idx + 1}번째`}</span>
                      </div>

                      <div
                        className="prophecy-card-inner"
                        onMouseEnter={() => setHoveredCard(card)}
                        onClick={() => setHoveredCard(card)}
                      >
                        <div className="prophecy-card-main">
                          <span className="prophecy-card-icon">{getCardIcon(type, card.name)}</span>
                          <span className="prophecy-card-name">{card.name}</span>
                          <span className={`prophecy-card-cat cat-${card.category.toLowerCase()}`}>
                            {getCategoryKoreanName(card)}
                          </span>
                        </div>
                        <div className="prophecy-card-desc">{card.description}</div>
                      </div>

                      <div className="prophecy-move-actions">
                        <button
                          type="button"
                          className="btn-prophecy-move"
                          disabled={isFirst}
                          onClick={(e) => {
                            e.stopPropagation();
                            moveProphecyCard(idx, idx - 1);
                          }}
                          title="앞(위)으로 이동"
                        >
                          ▲
                        </button>
                        <button
                          type="button"
                          className="btn-prophecy-move"
                          disabled={isLast}
                          onClick={(e) => {
                            e.stopPropagation();
                            moveProphecyCard(idx, idx + 1);
                          }}
                          title="뒤(아래)로 이동"
                        >
                          ▼
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="embedded-actions-footer" style={{ marginTop: '10px' }}>
                <button
                  type="button"
                  className="btn-gold embedded-submit-btn btn-prophecy-confirm"
                  onClick={() => submitProphecy(prophecyCards.map((c) => c.id))}
                >
                  🔮 이 순서대로 덱에 다시 넣기 (확인)
                </button>
              </div>
            </div>
          );
        })()}
        </div>
      </div>
    );
  }

  // ── 2. GENERAL EVENT RESOLUTION (No personal action required) ───────
  if (gameState.phase === 'RESOLVING_EVENT' && gameState.activeEventName) {
    const isNonPossession = gameState.activeEventName === '무소유';
    const initiatorPlayer = gameState.players.find(
      (p) => p.id === gameState.defenseInitiatorId || p.id === gameState.currentTurnPlayerId
    );

    return (
      <div className="event-action-board event-active">
        <div className="embedded-action-header">
          <span className="action-tag tag-gold">📜 이벤트 발동</span>
          <h4 className="embedded-action-title">[{gameState.activeEventName}]</h4>
          {gameState.actionDeadline && (
            <span className="embedded-timer-badge">{timeLeft}초</span>
          )}
        </div>
        {renderEventCardInfo}
        <div className="embedded-action-desc" style={{ marginTop: '6px' }}>
          {isNonPossession ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <p style={{ fontWeight: 800, color: '#ffd54f' }}>
                {initiatorPlayer ? `[${initiatorPlayer.name}] 님이 [무소유]를 뽑았습니다!` : '[무소유]를 뽑았습니다!'}
              </p>
              <p style={{ color: '#cfd8dc' }}>
                {timeLeft > 0 
                  ? `${timeLeft}초 후 뽑은 자의 모든 패가 생존자들에게 1장씩 순서대로 이동됩니다.`
                  : '패를 분배하는 중입니다...'}
              </p>
            </div>
          ) : (
            <p>이벤트가 진행 중입니다. 이벤트 결과가 처리될 때까지 대기하세요.</p>
          )}
        </div>

        {hasEscapeKit && (
          <div className="escape-kit-bar">
            <button
              className="btn-embedded-interrupt"
              style={{ width: '100%', justifyContent: 'center' }}
              onMouseEnter={() => {
                const kit = myHand.items.find((i) => i.name === '긴급탈출키트');
                if (kit) setHoveredCard(kit);
              }}
              onClick={() => {
                const kit = myHand.items.find((i) => i.name === '긴급탈출키트');
                if (kit) {
                  setHoveredCard(kit);
                  interruptAction(kit.id);
                }
              }}
            >
              <span>🚀 [긴급탈출키트] 사용하여 이 이벤트 즉시 취소하기</span>
            </button>
          </div>
        )}
      </div>
    );
  }

  // ── 3. IDLE / MAIN TURN STATUS BOARD (Standby state) ────────────────
  if (!isAlive) {
    return (
      <div className="event-action-board idle">
        <div className="embedded-idle-content">
          <span className="idle-icon">👻</span>
          <div className="idle-text-block">
            <div className="idle-headline">사망 상태 (관전 중)</div>
            <div className="idle-subtext">
              사망한 플레이어는 일반 차례를 진행할 수 없습니다. 망자 전용 이벤트(카르마, 폴터가이스트 등)가 발동되면 참여할 수 있습니다.
            </div>
          </div>
        </div>
      </div>
    );
  }

  const isMyTurn = gameState.currentTurnPlayerId === myId;

  if (isMyTurn && gameState.phase === 'MAIN' && isAlive) {
    const hasDrawn = gameState.myInfo.hasDrawnThisTurn;

    if (!hasDrawn) {
      return (
        <div className="event-action-board my-turn-board">
          <div className="my-turn-center-content">
            <div className="my-turn-badge">카드 뽑는 중...</div>
            <p className="my-turn-guide">
              턴 시작 카드를 자동으로 뽑고 있습니다. 잠시만 기다려 주세요.
            </p>
          </div>
        </div>
      );
    }

    return (
      <div className="event-action-board my-turn-board">
        <div className="my-turn-center-content">
          <div className="my-turn-badge">✨ 당신의 턴입니다!</div>
          <p className="my-turn-guide">
            패에서 도구 카드를 사용하거나, 행동을 마치려면 아래 버튼을 눌러 턴을 종료하세요.
          </p>
          <button
            type="button"
            className="btn-center-end-turn"
            onClick={(e) => {
              e.stopPropagation();
              endTurn();
            }}
          >
            <span>턴 종료 ➔</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="event-action-board idle">
      <div className="embedded-idle-content">
        <span className="idle-icon">📜</span>
        <div className="idle-text-block">
          <div className="idle-headline">
            {gameState.freeForAll
              ? '⚔️ 난투 모드: 순서 없이 누구나 무제한 공격 가능!'
              : '현재 진행 중인 이벤트가 없습니다.'}
          </div>
          <div className="idle-subtext">
            내 턴일 때 도구 카드를 사용하거나, 턴 종료 버튼을 눌러 다음 사람에게 넘길 수 있습니다.
          </div>
        </div>
      </div>
    </div>
  );
};
