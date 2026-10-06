// Typed actions — the only way chat (rule parser or LLM) can change state.
import type { Flexibility, Level } from '../../shared/types.ts';

export type StockLevel = 'none' | 'little' | 'some' | 'lots';

export type Action =
  | { type: 'updateHouseholdStock'; needId: string; qty?: number; level?: StockLevel; raw?: string }
  | { type: 'updatePreference'; needId: string; flexibility?: Flexibility; preferredBrands?: string[]; forbiddenBrands?: string[]; addForbiddenBrand?: string; neverSuggest?: boolean; active?: boolean; dealSensitivity?: Level; dislikeCurrent?: boolean; statement: string }
  | { type: 'searchProductPrices'; needId?: string; query: string }
  | { type: 'searchPromotions'; needId?: string }
  | { type: 'addBasketItem'; needId?: string; newLabel?: string; quantity?: number; conditional?: 'good_price' }
  | { type: 'removeBasketItem'; needId: string; temporary: boolean }
  | { type: 'replaceBasketItem'; needId: string }
  | { type: 'updateBasketQuantity'; needId: string; quantity: number }
  | { type: 'generateBasket'; horizonDays: number; skipCheckin?: boolean }
  | { type: 'quoteBasketAcrossProviders' }
  | { type: 'explainBasketDecision'; needId?: string; about?: 'store' }
  | { type: 'setBudget'; cap: number | null }
  | { type: 'showStock' }
  | { type: 'confirmPurchase' }
  | { type: 'help' };

export const ACTION_ORDER: Action['type'][] = [
  'updateHouseholdStock', 'updatePreference', 'setBudget', 'removeBasketItem', 'generateBasket',
  'addBasketItem', 'updateBasketQuantity', 'replaceBasketItem', 'searchProductPrices', 'searchPromotions',
  'quoteBasketAcrossProviders', 'explainBasketDecision', 'showStock', 'confirmPurchase', 'help',
];
