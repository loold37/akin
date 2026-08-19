import React from 'react';
import type { PlayerScore } from '../shared/types';
import { useSocket } from '../context/SocketContext';
import './GameOverModal.css';

interface GameOverModalProps {
  scores: PlayerScore[];
  onRestart: () => void;
}

export const GameOverModal: React.FC<GameOverModalProps> = ({ scores, onRestart }) => {
  const { socket } = useSocket();
  const myId = socket?.id;
  const sortedScores = [...scores].sort((a, b) => b.score - a.score);

  // 동점자 공동 순위 계산
  let currentRank = 1;
  const rankedScores = sortedScores.map((s, idx) => {
    if (idx > 0 && s.score < sortedScores[idx - 1].score) {
      currentRank = idx + 1;
    }
    return { ...s, rank: currentRank };
  });

  return (
    <div className="game-over-overlay">
      <div className="game-over-modal">
        <div className="game-over-header">
          <span className="game-over-icon">🏆</span>
          <h2 className="game-over-title">게임 종료 & 승패 정산</h2>
        </div>

        <div className="scores-table-container">
          <div className="scores-table-header">
            <span className="col-rank">순위</span>
            <span className="col-name">플레이어</span>
            <span className="col-reason">결과 / 사유</span>
            <span className="col-score">승점</span>
          </div>

          <div className="scores-table-body">
            {rankedScores.map((s) => (
              <div
                key={s.playerId}
                className={`score-row rank-${s.rank} ${s.score === 0 ? 'row-zero' : ''} ${s.playerId === myId ? 'is-me' : ''}`}
              >
                <span className="col-rank">
                  {s.rank === 1 && s.score > 0 ? `🥇 #${s.rank}` : `#${s.rank}`}
                </span>
                <span className="col-name">{s.name} {s.playerId === myId && '(나)'}</span>
                <span className="col-reason">{s.reason}</span>
                <span className={`col-score ${s.score === 0 ? 'score-zero' : ''}`}>
                  {s.score > 0 ? `+${s.score}점` : '0점'}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="game-over-footer">
          <button className="btn-gold restart-btn" onClick={onRestart}>
            대기실로 돌아가기
          </button>
        </div>
      </div>
    </div>
  );
};
