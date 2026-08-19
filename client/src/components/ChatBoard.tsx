import React, { useState, useRef, useEffect } from 'react';
import { useSocket } from '../context/SocketContext';
import { renderChatTextWithCardLinks } from '../utils/cardUtils';
import './ChatBoard.css';

export interface ChatMessagesProps {
  showHeader?: boolean;
  className?: string;
}

export const ChatMessages: React.FC<ChatMessagesProps> = ({
  showHeader = true,
  className = '',
}) => {
  const { chatMessages, playerName, setHoveredCard } = useSocket();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [chatMessages]);

  return (
    <div className={`chat-messages-container ${className}`}>
      {showHeader && (
        <div className="chat-header">
          <span className="chat-header-title">💬 게임 로그 & 대화</span>
        </div>
      )}

      <div className="chat-messages-area">
        {chatMessages.length === 0 ? (
          <div className="chat-empty-msg">기록된 메시지가 없습니다.</div>
        ) : (
          chatMessages.map((msg) => {
            const isMe = msg.sender === playerName || msg.sender === `👻 ${playerName}`;
            const isGhost = msg.sender.startsWith('👻');
            return (
              <div
                key={msg.id}
                className={`chat-message-item ${msg.isSystem ? 'system-msg' : isMe ? 'my-msg' : 'other-msg'} ${isGhost ? 'ghost-msg' : ''}`}
              >
                {!msg.isSystem && <span className="chat-sender">{msg.sender}:</span>}
                <span className="chat-text">
                  {msg.isSystem
                    ? renderChatTextWithCardLinks(msg.text, setHoveredCard)
                    : msg.text}
                </span>
                <span className="chat-time">{msg.timestamp}</span>
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>
    </div>
  );
};

export interface ChatInputProps {
  className?: string;
  placeholder?: string;
}

export const ChatInput: React.FC<ChatInputProps> = ({
  className = '',
  placeholder = '메시지를 입력하세요 (Enter로 전송)',
}) => {
  const { sendChat } = useSocket();
  const [inputText, setInputText] = useState('');

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim()) return;

    sendChat(inputText);
    setInputText('');
  };

  return (
    <form className={`chat-input-form ${className}`} onSubmit={handleSend}>
      <input
        type="text"
        className="chat-input-box"
        placeholder={placeholder}
        value={inputText}
        onChange={(e) => setInputText(e.target.value)}
      />
      <button type="submit" className="chat-send-btn">
        전송
      </button>
    </form>
  );
};

export interface ChatBoardProps {
  silenceMode?: boolean;
}

export const ChatBoard: React.FC<ChatBoardProps> = ({ silenceMode }) => {
  return (
    <div className={`chat-board-container ${silenceMode ? 'silence-warning' : ''}`}>
      <ChatMessages showHeader={true} />
      <ChatInput />
    </div>
  );
};
