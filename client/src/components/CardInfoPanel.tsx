import React from 'react';
import type { Card, ToolCard } from '../shared/types';
import {
  getCategoryKoreanName,
  getCategoryBadgeClass,
  getSafeMaliceValue,
  getSafeMaliceModifier,
} from '../utils/cardUtils';
import './CardInfoPanel.css';

interface CardInfoPanelProps {
  card: Card | null;
}

export const CardInfoPanel: React.FC<CardInfoPanelProps> = ({ card }) => {
  if (!card) {
    return (
      <div className="card-info-panel empty">
        <div className="card-info-empty-icon">🃏</div>
        <div className="card-info-empty-text">
          카드에 마우스를 올리거나<br />클릭하면 상세 정보가 표시됩니다.
        </div>
      </div>
    );
  }

  const categoryName = getCategoryKoreanName(card);
  const badgeClass = getCategoryBadgeClass(card);
  const maliceVal = getSafeMaliceValue(card);
  const maliceMod = getSafeMaliceModifier(card);
  const isSpecialTool = card.category === 'TOOL' && (card as ToolCard).isSpecial;
  const isDarkMalice = card.category === 'MALICE' && (card.name === '짙은 악의' || maliceVal === 2);

  return (
    <div className="card-info-panel active">
      <div className="card-info-header">
        <span className={`card-badge ${badgeClass}`}>{categoryName}</span>
        <h4 className="card-info-title">{card.name}</h4>

        {maliceVal > 0 && (
          <span className="card-malice-val">악의 +{maliceVal}</span>
        )}

        {maliceMod !== 0 && (
          <span className={`card-malice-mod ${maliceMod < 0 ? 'negative' : 'positive'}`}>
            악의 {maliceMod > 0 ? `+${maliceMod}` : maliceMod}
          </span>
        )}
      </div>

      <div className="card-info-body">
        <p className="card-info-desc">{card.description}</p>
        {card.detailedRule && (
          <div className="card-info-detailed-rule">
            <span className="detailed-rule-label">💡 세부 룰:</span>
            <p className="detailed-rule-text">{card.detailedRule}</p>
          </div>
        )}
      </div>

      <div className="card-info-footer">
        {isSpecialTool && <span className="card-special-tag">★ 특수 도구</span>}
        {isDarkMalice && <span className="card-special-tag tag-dark-malice">★ 짙은 악의</span>}
        {card.category === 'EVENT' && <span className="card-special-tag tag-event">★ 이벤트 카드</span>}
      </div>
    </div>
  );
};
