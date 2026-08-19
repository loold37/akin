import React from 'react';
import { SocketProvider, useSocket } from './context/SocketContext';
import { Lobby } from './views/Lobby';
import { GameBoard } from './views/GameBoard';
import './App.css';

const MainScreen: React.FC = () => {
  const { gameState, isReturnedToLobby, gameOverScores } = useSocket();

  // 대기실 표시 조건: 게임 상태가 없거나, WAITING 상태이거나, 게임 종료 후 개별적으로 대기실로 복귀한 경우
  if (!gameState || gameState.phase === 'WAITING' || (gameState.phase === 'ENDED' && isReturnedToLobby && !gameOverScores)) {
    return <Lobby />;
  }

  return <GameBoard gameState={gameState} />;
};

export function App() {
  return (
    <SocketProvider>
      <MainScreen />
    </SocketProvider>
  );
}

export default App;
