import React, { useState } from 'react';
import { useSocket } from '../context/SocketContext';
import { ChatBoard } from '../components/ChatBoard';
import './Lobby.css';

export const Lobby: React.FC = () => {
  const {
    roomCode,
    playerName,
    roomPlayers,
    joinRoom,
    leaveRoom,
    startGame,
    isConnected,
    socket,
  } = useSocket();

  const [inputCode, setInputCode] = useState('');
  const [inputName, setInputName] = useState('');
  const [isChatFocused, setIsChatFocused] = useState(false);

  // ── [요청 반영] 모바일(안드로이드/iOS) 가상 키보드 뷰포트 높이 실시간 추적 ──
  React.useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const updateViewportHeight = () => {
      document.documentElement.style.setProperty('--visual-viewport-height', `${vv.height}px`);
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

  const handleJoin = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputCode.trim() || !inputName.trim()) return;
    joinRoom(inputCode, inputName);
  };

  const isHost = roomPlayers.length > 0 && roomPlayers[0].id === socket?.id;

  return (
    <div className={`lobby-wrapper ${isChatFocused ? 'keyboard-active' : ''}`}>
      {!roomCode ? (
        /* 방 참가 폼 (단일 카드 중앙 정렬) */
        <div className="lobby-card">
          <div className="lobby-header">
            <h1 className="game-main-title">악인</h1>
            <p className="game-sub-title">심리 스릴러 배틀로얄 온라인</p>
            <div className={`connection-status ${isConnected ? 'online' : 'offline'}`}>
              {isConnected ? '● 서버 연결됨' : '○ 서버 연결 중...'}
            </div>
          </div>

          <form className="lobby-form" onSubmit={handleJoin}>
            <div className="form-group">
              <label htmlFor="room-code-input">방 코드 (Room Code)</label>
              <input
                id="room-code-input"
                type="text"
                placeholder="예: TEST, ROOM1"
                maxLength={10}
                value={inputCode}
                onChange={(e) => setInputCode(e.target.value.toUpperCase())}
                autoFocus
              />
            </div>

            <div className="form-group">
              <label htmlFor="player-name-input">플레이어 닉네임</label>
              <input
                id="player-name-input"
                type="text"
                placeholder="닉네임 입력 (최대 10자)"
                maxLength={10}
                value={inputName}
                onChange={(e) => setInputName(e.target.value)}
              />
            </div>

            <button
              type="submit"
              className="btn-danger lobby-submit-btn"
              disabled={!isConnected || !inputCode.trim() || !inputName.trim()}
            >
              방 입장하기
            </button>
          </form>
        </div>
      ) : (
        /* 대기실 화면 (좌측: 방 정보/참가자 / 우측: 실시간 채팅) */
        <div className="lobby-joined-container">
          <div className="lobby-card">
            <div className="lobby-header lobby-waiting-header">
              <div className="lobby-header-text">
                <h1 className="game-main-title">악인</h1>
                <p className="game-sub-title">심리 스릴러 배틀로얄 온라인</p>
                <div className={`connection-status ${isConnected ? 'online' : 'offline'}`}>
                  {isConnected ? '● 서버 연결됨' : '○ 서버 연결 중...'}
                </div>
              </div>
              <button
                type="button"
                className="btn-lobby-leave"
                onClick={leaveRoom}
                title="대기실 나가기"
              >
                나가기
              </button>
            </div>

            <div className="waiting-room-section">
              <div className="room-info-banner">
                <div className="room-code-label">방 코드</div>
                <div className="room-code-display">{roomCode}</div>
                <div className="my-name-display">내 닉네임: <strong>{playerName}</strong></div>
              </div>

              <div className="players-list-section">
                <div className="players-list-header">
                  대기 중인 생존자 ({roomPlayers.length}명)
                </div>
                <div className="players-list-scroll">
                  {roomPlayers.map((p, idx) => (
                    <div
                      key={p.id}
                      className={`waiting-player-item ${p.id === socket?.id ? 'is-me' : ''}`}
                    >
                      <span className="player-rank-idx">#{idx + 1}</span>
                      <span className="player-avatar-mini">{idx === 0 ? '👑' : '👤'}</span>
                      <span className="player-name-text">
                        {p.name} {p.id === socket?.id && '(나)'}
                      </span>
                      {idx === 0 && <span className="host-badge">방장</span>}
                    </div>
                  ))}
                </div>
              </div>

              <div className="waiting-footer-actions">
                {isHost ? (
                  <button
                    className="btn-gold start-game-btn"
                    onClick={startGame}
                    disabled={roomPlayers.length < 1}
                  >
                    게임 시작 ({roomPlayers.length}명)
                  </button>
                ) : (
                  <div className="waiting-host-notice">
                    방장이 게임을 시작하기를 기다리는 중입니다...
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="lobby-chat-panel">
            <ChatBoard onFocusChange={setIsChatFocused} />
          </div>
        </div>
      )}
    </div>
  );
};
