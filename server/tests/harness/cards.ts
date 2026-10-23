import { generateDeck } from '../../src/Deck';
import { Card, ToolCard } from '../../../shared/types';

// card.json의 62장을 이름 또는 카드 번호로 찍어내는 팩토리.
// '십자가'는 무기(201)와 보물(502) 두 장이라 '십자가#201' / '십자가#502'처럼 번호를 붙여야 합니다.

const catalog: Card[] = generateDeck().sort((a, b) => (a.cardId ?? 0) - (b.cardId ?? 0));

export type CardSpec = string | number;

function resolveCardId(spec: CardSpec): number {
  if (typeof spec === 'number') return spec;
  const hash = spec.indexOf('#');
  if (hash !== -1) return Number(spec.slice(hash + 1));
  const matches = catalog.filter((c) => c.name === spec);
  if (matches.length === 0) throw new Error(`알 수 없는 카드: ${spec}`);
  if (matches.length > 1) {
    throw new Error(`'${spec}'는 여러 장입니다. ${matches.map((m) => `${spec}#${m.cardId}`).join(' / ')} 중 하나로 지정하세요.`);
  }
  return matches[0].cardId!;
}

/** 새 고유 id를 가진 카드 1장을 만듭니다. */
export function makeCard(spec: CardSpec): Card {
  const cardId = resolveCardId(spec);
  const fresh = generateDeck().find((c) => c.cardId === cardId);
  if (!fresh) throw new Error(`card.json에 없는 카드 번호: ${cardId}`);
  return fresh;
}

/** 서버가 마육검(보관)/엑스칼리버 획득 시 만들어 넣는 것과 같은 모양의 무기 카드. */
export function makeSyntheticWeapon(name: '마육검' | '엑스칼리버'): ToolCard {
  return {
    id: `${name === '마육검' ? 'mayuk' : 'excalibur'}_test_${Math.random().toString(16).slice(2)}`,
    cardId: name === '마육검' ? 113 : 111,
    category: 'TOOL',
    toolType: 'WEAPON',
    name,
    description: `테스트용 ${name}`,
    isSpecial: true,
    maliceValue: 0,
  } as ToolCard;
}

export function allCatalogCards(): Card[] {
  return catalog.slice();
}

export function cardLabel(card: Card): string {
  return `${card.name}(#${card.cardId ?? '?'})`;
}
