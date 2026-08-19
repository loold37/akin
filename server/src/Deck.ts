import { Card, MaliceCard, ToolCard, EventCard, EventActionType, CardName } from '../../shared/types';
import { MALICE_PER_CARD } from './constants';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

function generateId(): string {
  return crypto.randomBytes(8).toString('hex');
}

interface RawCardData {
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

function getEventActionType(name: string): EventActionType {
  switch (name) {
    case '피바라기':
    case '선택 (善)':
    case '선택 (惡)':
    case '카르마':
    case '폴터가이스트':
    case '뒤바뀐 영혼':
    case '선물':
      return 'REQUIRE_TARGET_SELECT';
    case '천사의 심판대':
    case '악마의 고해소':
    case '구덩이':
    case '미끼':
      return 'REQUIRE_VOTE';
    case '제물':
    case '룰렛':
    case '인체 연성':
    case '무장해제':
    case '면죄부':
      return 'REQUIRE_CARD_SUBMISSION';
    case '엑스칼리버':
      return 'EXCALIBUR_RACE';
    case '화살 함정':
      return 'WAITING_FOR_DEFENSE';
    case '눈 없는 괴물':
      return 'SILENCE_MODE';
    case '난투':
      return 'FREE_FOR_ALL';
    case '무소유':
      return 'AUCTION';
    default:
      return 'IMMEDIATE_EFFECT';
  }
}

/**
 * card.json 파일을 기반으로 62장의 카드 덱을 생성하고 셔플하여 반환합니다.
 */
export function generateDeck(): Card[] {
  const possiblePaths = [
    path.resolve(__dirname, '../card.json'),
    path.resolve(__dirname, '../../card.json'),
    path.resolve(process.cwd(), 'card.json'),
    path.resolve(process.cwd(), 'server/card.json'),
  ];

  let rawList: RawCardData[] | null = null;
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      try {
        rawList = JSON.parse(fs.readFileSync(p, 'utf-8'));
        break;
      } catch {
        // continue
      }
    }
  }

  if (!rawList) {
    throw new Error('card.json 파일을 찾을 수 없습니다.');
  }

  const deck: Card[] = rawList.map((item) => {
    const base = {
      id: generateId(),
      cardId: item.id,
      name: item.name as CardName,
      description: item.description,
      detailedRule: item.detailedRule,
    };

    if (item.mainCategory === '악의 카드') {
      return {
        ...base,
        category: 'MALICE',
        name: item.name as CardName,
        maliceValue: item.evilScore * MALICE_PER_CARD,
      } as MaliceCard;
    } else if (item.mainCategory === '도구 카드') {
      let toolType: 'WEAPON' | 'SHIELD' | 'ITEM' | 'TREASURE' = 'ITEM';
      if (item.subCategory === '무기') toolType = 'WEAPON';
      else if (item.subCategory === '방패') toolType = 'SHIELD';
      else if (item.subCategory === '보물') toolType = 'TREASURE';
      else if (item.subCategory === '아이템') toolType = 'ITEM';

      return {
        ...base,
        category: 'TOOL',
        name: item.name as CardName,
        toolType,
        isSpecial: item.isSpecial,
        maliceValue: item.evilScore * MALICE_PER_CARD,
        maliceModifier: item.name === '선의' ? -MALICE_PER_CARD : undefined,
      } as ToolCard;
    } else {
      return {
        ...base,
        category: 'EVENT',
        name: item.name as CardName,
        actionType: getEventActionType(item.name),
      } as EventCard;
    }
  });

  return shuffle(deck);
}

/** Fisher-Yates 셔플 */
function shuffle<T>(array: T[]): T[] {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}
