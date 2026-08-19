import React from 'react';
import type { Card, ToolCard, MaliceCard, EventCard, PlayerHand } from '../shared/types';
import rawCards from '../data/cards.json';

interface RawCardItem {
  id: number;
  mainCategory: string;
  subCategory: string | null;
  isSpecial: boolean;
  name: string;
  description: string;
  detailedRule: string | null;
  evilScore: number;
  isPlayable: boolean;
}

/**
 * 전역 카드 카탈로그 사전 (이름 -> Card 객체)
 */
export const CARD_CATALOG: Map<string, Card> = new Map();

(rawCards as RawCardItem[]).forEach((item) => {
  const base: any = {
    id: `catalog_${item.id}`,
    cardId: item.id,
    name: item.name,
    description: item.description,
    detailedRule: item.detailedRule,
  };

  let cardObj: Card;
  if (item.mainCategory === '악의 카드') {
    cardObj = {
      ...base,
      category: 'MALICE',
      maliceValue: item.evilScore > 0 ? item.evilScore : 1,
    } as MaliceCard;
  } else if (item.mainCategory === '도구 카드') {
    let toolType: 'WEAPON' | 'SHIELD' | 'ITEM' | 'TREASURE' = 'ITEM';
    if (item.subCategory === '무기') toolType = 'WEAPON';
    else if (item.subCategory === '방패') toolType = 'SHIELD';
    else if (item.subCategory === '보물') toolType = 'TREASURE';
    else if (item.subCategory === '아이템') toolType = 'ITEM';

    cardObj = {
      ...base,
      category: 'TOOL',
      toolType,
      isSpecial: item.isSpecial,
      maliceValue: item.evilScore,
      maliceModifier: item.name === '선의' ? -1 : undefined,
    } as ToolCard;
  } else {
    cardObj = {
      ...base,
      category: 'EVENT',
      actionType: 'IMMEDIATE_EFFECT' as any,
    } as EventCard;
  }

  CARD_CATALOG.set(item.name, cardObj);
  // 공백 및 괄호 변형 등록 (예: "선택(善)", "인체연성")
  CARD_CATALOG.set(item.name.replace(/\s+/g, ''), cardObj);
});

/**
 * 카드의 종류와 이름에 맞는 이모지 아이콘을 반환합니다.
 */
export const getCardIcon = (type: string, name: string): string => {
  if (type === 'WEAPON') return '🗡️';
  if (type === 'SHIELD') return '🛡️';
  if (type === 'ITEM') return '🧪';
  if (type === 'TREASURE') return '👑';
  if (type === 'MALICE') return name === '짙은 악의' ? '🩸🩸' : '🩸';
  if (type === 'EVENT') return '📜';
  return '🃏';
};

/**
 * 카드의 카테고리 한국어 이름을 반환합니다.
 */
export const getCategoryKoreanName = (card: Card): string => {
  if (card.category === 'MALICE') return '악의';
  if (card.category === 'EVENT') return '이벤트';
  if (card.category === 'TOOL' || (card as any).toolType) {
    const tool = card as ToolCard;
    switch (tool.toolType) {
      case 'WEAPON': return '무기';
      case 'SHIELD': return '방패';
      case 'ITEM': return '아이템';
      case 'TREASURE': return '보물';
      default: return '도구';
    }
  }
  if ((card as any).category === 'WEAPON') return '무기';
  if ((card as any).category === 'SHIELD') return '방패';
  if ((card as any).category === 'ITEM') return '아이템';
  if ((card as any).category === 'TREASURE') return '보물';
  return '기타';
};

/**
 * 카드의 카테고리 뱃지 CSS 클래스를 반환합니다.
 */
export const getCategoryBadgeClass = (card: Card): string => {
  if (card.category === 'MALICE') return 'badge-malice';
  if (card.category === 'EVENT') return 'badge-event';
  if (card.category === 'TOOL' || (card as any).toolType) {
    const tool = card as ToolCard;
    switch (tool.toolType) {
      case 'WEAPON': return 'badge-weapon';
      case 'SHIELD': return 'badge-shield';
      case 'ITEM': return 'badge-item';
      case 'TREASURE': return 'badge-treasure';
      default: return 'badge-tool';
    }
  }
  if ((card as any).category === 'WEAPON') return 'badge-weapon';
  if ((card as any).category === 'SHIELD') return 'badge-shield';
  if ((card as any).category === 'ITEM') return 'badge-item';
  if ((card as any).category === 'TREASURE') return 'badge-treasure';
  return 'badge-default';
};

/**
 * 카드의 정렬 순서 가중치를 반환합니다.
 */
export const getCardSortOrder = (card: Card): number => {
  if (typeof (card as any).cardId === 'number' && !isNaN((card as any).cardId)) {
    return (card as any).cardId;
  }
  if (card.category === 'EVENT') return 100;
  if (card.category === 'TOOL' || (card as any).toolType) {
    const t = (card as ToolCard).toolType || (card as any).category;
    if (t === 'WEAPON') return 200;
    if (t === 'SHIELD') return 300;
    if (t === 'ITEM') return 400;
    if (t === 'TREASURE') return 500;
    return 200;
  }
  if ((card as any).category === 'WEAPON') return 200;
  if ((card as any).category === 'SHIELD') return 300;
  if ((card as any).category === 'ITEM') return 400;
  if ((card as any).category === 'TREASURE') return 500;
  if (card.category === 'MALICE') return 600;
  return 999;
};

/**
 * 악의 수치를 부동소수점 오차 없이 안전하게 정수로 반환합니다.
 */
export const getSafeMaliceValue = (card: Card): number => {
  if (card.category === 'MALICE') {
    const m = card as MaliceCard;
    if (m.name === '짙은 악의') return 2;
    if (typeof m.maliceValue === 'number' && !isNaN(m.maliceValue)) {
      return Math.round(m.maliceValue);
    }
    if (typeof (m as any).evilScore === 'number' && !isNaN((m as any).evilScore)) {
      return Math.round((m as any).evilScore);
    }
    return 1;
  }
  if (card.category === 'TOOL') {
    const t = card as ToolCard;
    if (typeof t.maliceValue === 'number' && !isNaN(t.maliceValue)) {
      return Math.round(t.maliceValue);
    }
  }
  return 0;
};

/**
 * 도구 카드의 악의 수정치(maliceModifier)를 안전하게 정수로 반환합니다.
 */
export const getSafeMaliceModifier = (card: Card): number => {
  if (card.category === 'TOOL') {
    const t = card as ToolCard;
    if (typeof t.maliceModifier === 'number' && !isNaN(t.maliceModifier)) {
      return Math.round(t.maliceModifier);
    }
  }
  return 0;
};

/**
 * 카드를 공식 룰에 맞게 정렬합니다. (무기 ➔ 방패 ➔ 아이템/보물 ➔ 악의)
 */
export const sortCardsByRule = (
  hand: PlayerHand
): Array<{ card: Card; type: 'WEAPON' | 'SHIELD' | 'ITEM' | 'TREASURE' | 'MALICE' }> => {
  const result: Array<{ card: Card; type: 'WEAPON' | 'SHIELD' | 'ITEM' | 'TREASURE' | 'MALICE' }> = [];

  // 1. 무기 (칼)
  const weapons = [...(hand.weapons || [])].sort((a, b) => (a.cardId || 0) - (b.cardId || 0));
  weapons.forEach((w) => result.push({ card: w, type: 'WEAPON' }));

  // 2. 방패
  const shields = [...(hand.shields || [])].sort((a, b) => (a.cardId || 0) - (b.cardId || 0));
  shields.forEach((s) => result.push({ card: s, type: 'SHIELD' }));

  // 3. 아이템 & 보물
  const itemsAndTreasures: ToolCard[] = [
    ...(hand.items || []),
    ...(hand.treasures || []),
  ].sort((a, b) => (a.cardId || 0) - (b.cardId || 0));
  itemsAndTreasures.forEach((it) => result.push({ card: it, type: it.toolType }));

  // 4. 악의
  const malices = [...(hand.malices || [])].sort((a, b) => (a.cardId || 0) - (b.cardId || 0));
  malices.forEach((m) => result.push({ card: m, type: 'MALICE' }));

  return result;
};

/**
 * 카드 배열을 cardId 순으로 정렬합니다.
 */
export const sortCardsByNumber = <T extends Card>(cards: T[]): T[] => {
  return [...cards].sort((a, b) => getCardSortOrder(a) - getCardSortOrder(b));
};

/**
 * 카드 이름으로 카탈로그에서 카드 정보를 찾습니다.
 */
export const findCardByName = (name: string): Card | null => {
  const clean = name.trim();
  if (CARD_CATALOG.has(clean)) return CARD_CATALOG.get(clean)!;
  const noSpace = clean.replace(/\s+/g, '');
  if (CARD_CATALOG.has(noSpace)) return CARD_CATALOG.get(noSpace)!;

  // 괄호 제거 후 검색 (예: "[피바라기]" -> "피바라기")
  const unbracketed = clean.replace(/^\[+|\]+$/g, '').trim();
  if (CARD_CATALOG.has(unbracketed)) return CARD_CATALOG.get(unbracketed)!;
  const unbracketedNoSpace = unbracketed.replace(/\s+/g, '');
  if (CARD_CATALOG.has(unbracketedNoSpace)) return CARD_CATALOG.get(unbracketedNoSpace)!;

  return null;
};

/**
 * 모든 카드 이름을 길이 역순으로 정렬한 목록을 반환합니다.
 */
const allCardNamesSorted = Array.from(
  new Set((rawCards as RawCardItem[]).map((c) => c.name))
).sort((a, b) => b.length - a.length);

/**
 * 일반 대화에서 오탐(False-positive)을 방지하기 위해,
 * 4글자 이상이거나 공백/특수문자가 포함된 고유/복합 카드명만 단독 매칭을 허용합니다.
 * (짧은 일반 단어인 '선물', '상처', '질투', '탐욕', '시선', '침묵', '독재' 등은 [선물] 처럼 대괄호가 있을 때만 매칭)
 */
const unambiguousCardNamesSorted = allCardNamesSorted.filter((name) =>
  name.length >= 4 ||
  name.includes(' ') ||
  name.includes('(') ||
  ['엑스칼리버', '피바라기', '스캐빈져', '무장해제', '수호천사', '마육검', '골든레코드'].includes(name)
).sort((a, b) => b.length - a.length);

// 특수 정규식 이스케이프
const escapeRegExp = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 시스템 로그 전용: 대괄호가 있든 없든 모든 카드명 매칭 ("카드를 뽑았습니다: 선물" 등)
const systemCardKeywordsPattern = new RegExp(
  `\\[(${allCardNamesSorted.map(escapeRegExp).join('|')})\\]|(${allCardNamesSorted.map(escapeRegExp).join('|')})`,
  'g'
);

// 일반 유저 채팅 전용: 대괄호가 있거나 고유한 복합 카드명만 매칭 (일상 단어 오탐 방지)
const userCardKeywordsPattern = new RegExp(
  `\\[(${allCardNamesSorted.map(escapeRegExp).join('|')})\\]|(${unambiguousCardNamesSorted.map(escapeRegExp).join('|')})`,
  'g'
);

/**
 * 채팅 및 게임 로그 텍스트에서 카드 이름을 찾아 하이라이트 링크로 변환합니다.
 * - 시스템 로그(isSystem=true): "카드를 뽑았습니다: 선물" 등 모든 카드명 자동 하이라이트
 * - 유저 대화(isSystem=false): [선물], [황금칼] 처럼 대괄호가 있거나 고유 카드명만 하이라이트
 */
export const renderChatTextWithCardLinks = (
  text: string,
  onCardHoverOrClick: (card: Card) => void,
  isSystem: boolean = true
): React.ReactNode => {
  if (!text) return text;

  const elements: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  const pattern = isSystem ? systemCardKeywordsPattern : userCardKeywordsPattern;
  const regex = new RegExp(pattern);

  while ((match = regex.exec(text)) !== null) {
    const matchStart = match.index;
    const matchEnd = regex.lastIndex;
    const isBracketed = Boolean(match[1]);
    const cardName = match[1] || match[2];

    // 매칭 이전 일반 텍스트 추가
    if (matchStart > lastIndex) {
      elements.push(text.substring(lastIndex, matchStart));
    }

    const card = findCardByName(cardName);
    if (card) {
      const type = card.category === 'TOOL' ? (card as ToolCard).toolType : card.category;
      const typeClass = `chat-card-type-${type.toLowerCase()}`;

      if (isBracketed) {
        elements.push('[');
      }

      elements.push(
        <span
          key={`${matchStart}-${cardName}`}
          className={`chat-card-link ${typeClass}`}
          title={`클릭/호버: [${card.name}] 상세 정보 보기`}
          onMouseEnter={() => onCardHoverOrClick(card)}
          onClick={(e) => {
            e.stopPropagation();
            onCardHoverOrClick(card);
          }}
        >
          {cardName}
        </span>
      );

      if (isBracketed) {
        elements.push(']');
      }
    } else {
      elements.push(match[0]);
    }

    lastIndex = matchEnd;
  }

  // 매칭 이후 일반 텍스트 추가
  if (lastIndex < text.length) {
    elements.push(text.substring(lastIndex));
  }

  return elements.length > 0 ? <>{elements}</> : text;
};
