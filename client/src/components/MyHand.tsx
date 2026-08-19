import React from 'react';
import type { ToolCard, PlayerHand } from '../shared/types';
import { useSocket } from '../context/SocketContext';
import { getCardIcon, sortCardsByRule, getSafeMaliceValue } from '../utils/cardUtils';
import './MyHand.css';

export { getCardIcon } from '../utils/cardUtils';

interface MyHandProps {
  hand: PlayerHand;
  isMyTurn: boolean;
  canPlayWeapon: boolean;
  isDefensePhase: boolean;
  selectedCardId?: string | null;
  onSelectWeapon: (card: ToolCard) => void;
  onSelectItem: (card: ToolCard) => void;
  onSelectShield: (card: ToolCard) => void;
}

export const MyHand: React.FC<MyHandProps> = ({
  hand,
  isMyTurn,
  canPlayWeapon,
  isDefensePhase,
  selectedCardId,
  onSelectWeapon,
  onSelectItem,
  onSelectShield,
}) => {
  const { setHoveredCard } = useSocket();

  // ── 정렬 로직: 무기(칼) ➡️ 방패 ➡️ 아이템/보물 ➡️ 악의 ─────────
  const sortedCards = sortCardsByRule(hand);

  const handleCardClick = (item: (typeof sortedCards)[0]) => {
    setHoveredCard(item.card);
    if (item.type === 'WEAPON') {
      if (canPlayWeapon) {
        onSelectWeapon(item.card as ToolCard);
      }
    } else if (item.type === 'SHIELD') {
      if (isDefensePhase) {
        onSelectShield(item.card as ToolCard);
      }
    } else if (item.type === 'ITEM') {
      if (item.card.name === '인연의 끈') {
        if (isMyTurn && !isDefensePhase) {
          onSelectItem(item.card as ToolCard);
        }
      } else {
        onSelectItem(item.card as ToolCard);
      }
    }
  };

  const isCardPlayable = (type: string, name: string) => {
    if (type === 'WEAPON') return canPlayWeapon;
    if (type === 'SHIELD') return isDefensePhase;
    if (type === 'ITEM') {
      if (name === '긴급탈출키트' || name === '침묵' || name === '인간 방패') return true;
      if (name === '인연의 끈') return isMyTurn && !isDefensePhase;
      if (name === '독재') return true;
    }
    return false;
  };

  return (
    <div className="my-hand-container">
      <div className="hand-cards-row">
        {sortedCards.length === 0 ? (
          <div className="hand-empty-msg">보유한 카드가 없습니다.</div>
        ) : (
          sortedCards.map((item, idx) => {
            const playable = isCardPlayable(item.type, item.card.name);
            const isSelected = selectedCardId === item.card.id;
            const maliceVal = getSafeMaliceValue(item.card);

            return (
              <div
                key={`${item.card.id}-${idx}`}
                className={`card-slot type-${item.type.toLowerCase()} ${playable ? 'playable' : ''} ${isSelected ? 'selected' : ''}`}
                onMouseEnter={() => setHoveredCard(item.card)}
                onClick={() => handleCardClick(item)}
              >
                <div className="card-inner-box">
                  <div className="card-top-icon">{getCardIcon(item.type, item.card.name)}</div>
                  <div className="card-slot-name">{item.card.name}</div>
                  {item.type === 'MALICE' && (
                    <div className="card-sub-info">
                      {maliceVal === 2 || item.card.name === '짙은 악의' ? '악의x2' : '악의'}
                    </div>
                  )}
                  {item.type === 'WEAPON' && <div className="card-sub-info">무기</div>}
                  {item.type === 'SHIELD' && <div className="card-sub-info">방어</div>}
                  {item.type === 'ITEM' && <div className="card-sub-info">아이템</div>}
                  {item.type === 'TREASURE' && <div className="card-sub-info">보물</div>}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
