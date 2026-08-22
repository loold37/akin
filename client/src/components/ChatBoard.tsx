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

  const scrollToBottom = (behavior: ScrollBehavior = 'smooth') => {
    messagesEndRef.current?.scrollIntoView({ behavior });
  };

  useEffect(() => {
    scrollToBottom('smooth');
  }, [chatMessages]);

  // 키보드가 올라오거나 뷰포트 크기가 변할 때 즉시 최하단으로 스크롤
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const handleResize = () => {
      scrollToBottom('auto');
    };

    vv.addEventListener('resize', handleResize);
    return () => {
      vv.removeEventListener('resize', handleResize);
    };
  }, []);

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
  onFocusChange?: (isFocused: boolean) => void;
}

export const ChatInput: React.FC<ChatInputProps> = ({
  className = '',
  placeholder = '메시지를 입력하세요 (Enter로 전송)',
  onFocusChange,
}) => {
  const { sendChat } = useSocket();
  const [inputText, setInputText] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const [bottomOffset, setBottomOffset] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    onFocusChange?.(isFocused);
  }, [isFocused, onFocusChange]);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const handleViewportChange = () => {
      // Calculate how much the visual viewport is offset or shrunk compared to the window
      const offset = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop));
      setBottomOffset(offset);
    };

    vv.addEventListener('resize', handleViewportChange);
    vv.addEventListener('scroll', handleViewportChange);
    return () => {
      vv.removeEventListener('resize', handleViewportChange);
      vv.removeEventListener('scroll', handleViewportChange);
    };
  }, []);

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim()) return;

    sendChat(inputText);
    setInputText('');
    // 키보드를 닫지 않고 계속 입력할 수 있도록 포커스 유지
    inputRef.current?.focus();
  };

  const handleDismiss = () => {
    inputRef.current?.blur();
    setIsFocused(false);
  };

  return (
    <form
      className={`chat-input-form ${isFocused ? 'is-mobile-floating' : ''} ${className}`}
      style={isFocused && bottomOffset > 0 ? { bottom: `${bottomOffset}px` } : undefined}
      onSubmit={handleSend}
    >
      <input
        ref={inputRef}
        type="text"
        className="chat-input-box"
        placeholder={placeholder}
        value={inputText}
        onFocus={() => setIsFocused(true)}
        onBlur={() => {
          setTimeout(() => {
            if (document.activeElement !== inputRef.current) {
              setIsFocused(false);
            }
          }, 150);
        }}
        onChange={(e) => setInputText(e.target.value)}
      />
      {isFocused && (
        <button
          type="button"
          className="chat-dismiss-btn"
          onPointerDown={(e) => {
            e.preventDefault();
            handleDismiss();
          }}
          title="채팅창 닫기 (X)"
        >
          ✕
        </button>
      )}
      <button
        type="submit"
        className="chat-send-btn"
        onPointerDown={(e) => {
          if (inputText.trim()) {
            e.preventDefault();
            handleSend(e);
          }
        }}
      >
        전송
      </button>
    </form>
  );
};


export interface ChatBoardProps {
  silenceMode?: boolean;
  onFocusChange?: (isFocused: boolean) => void;
}

export const ChatBoard: React.FC<ChatBoardProps> = ({ silenceMode, onFocusChange }) => {
  return (
    <div className={`chat-board-container ${silenceMode ? 'silence-warning' : ''}`}>
      <ChatMessages showHeader={true} />
      <ChatInput onFocusChange={onFocusChange} />
    </div>
  );
};
