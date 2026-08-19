import React from 'react';
import type { PublicPlayerInfo } from '../shared/types';
import { useSocket } from '../context/SocketContext';
import './PlayerRing.css';

interface PlayerRingProps {
  players: PublicPlayerInfo[];
  currentTurnPlayerId: string | null;
  targetSelectionMode: boolean;
  validTargets?: string[];
  allowSelf?: boolean;
  disabledTargetIds?: string[];
  onSelectTarget: (targetId: string) => void;
}

export const PlayerRing: React.FC<PlayerRingProps> = ({
  players,
  currentTurnPlayerId,
  targetSelectionMode,
  validTargets,
  allowSelf,
  disabledTargetIds,
  onSelectTarget,
}) => {
  const { socket, gameState } = useSocket();
  const myId = socket?.id;

  return (
    <div className="player-ring-container">
      <div className="player-ring-grid">
        {players.map((p) => {
          const isMe = p.id === myId;
          const isCurrentTurn = p.id === currentTurnPlayerId;
          const isLinked = !!(gameState?.linkedPlayers && gameState.linkedPlayers.includes(p.id));
          const totalCards =
            p.handCount.malices +
            p.handCount.weapons +
            p.handCount.shields +
            p.handCount.treasures +
            p.handCount.items;

          const isSelectable =
            targetSelectionMode &&
            p.isAlive &&
            (!validTargets || validTargets.includes(p.id)) &&
            (!disabledTargetIds || !disabledTargetIds.includes(p.id)) &&
            (allowSelf || p.id !== myId);

          return (
            <div
              key={p.id}
              className={`player-card ${!p.isAlive ? 'dead' : ''} ${isCurrentTurn ? 'active-turn' : ''} ${
                isSelectable ? 'selectable' : ''
              } ${isMe ? 'is-me' : ''} ${isLinked ? 'fate-linked' : ''}`}
              onClick={() => {
                if (isSelectable) onSelectTarget(p.id);
              }}
            >
              <div className="player-avatar-box">
                <span className="player-avatar-icon">
                  {!p.isAlive ? '💀' : isCurrentTurn ? '👑' : '👤'}
                </span>
                {isCurrentTurn && <div className="turn-indicator-badge">TURN</div>}
              </div>

              <div className="player-info-content">
                <div className="player-name-row">
                  <span className="player-name">
                    {p.name} {isMe && '(나)'}
                  </span>
                  <div className="badge-cluster">
                    {gameState?.activeEventName === '마육검' && gameState?.submittedPlayerIds?.includes(p.id) && (
                      <span className="bid-badge">입찰 완료</span>
                    )}
                    {isLinked && <span className="fate-badge" title="인연의 끈으로 운명이 묶여 있음">🔗</span>}
                    {p.isSilenced && <span className="silence-badge">침묵</span>}
                  </div>
                </div>

                <div className="player-status-row">
                  {!p.isAlive ? (
                    <span className="status-dead-label">사망</span>
                  ) : (
                    <span className="card-count-label">
                      남은 패: <strong>{totalCards}장</strong>
                    </span>
                  )}
                </div>
              </div>

              {isSelectable && <div className="target-select-overlay">🎯 지목</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
};
