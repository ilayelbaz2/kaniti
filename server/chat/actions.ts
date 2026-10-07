// Typed actions — the only way chat (rule parser or LLM) can change state.
import type { Flexibility, Level } from '../../shared/types.ts';

export type StockLevel = 'none' | 'little' | 'some' | 'lots';
export type InsightQuestion = 'spend_month' | 'top_category' | 'savings' | 'when_shop' | 'fastest' | 'overbuy' | 'cheap_day' | 'lasts';

export type Action =
  | { type: 'updateHouseholdStock'; needId: string; qty?: number; level?: StockLevel; raw?: string }
  | { type: 'updatePreference'; needId: string | 'FOCUS'; flexibility?: Flexibility; preferredBrands?: string[]; forbiddenBrands?: string[]; addForbiddenBrand?: string; neverSuggest?: boolean; active?: boolean; dealSensitivity?: Level; dislikeCurrent?: boolean; statement: string }
  /** query = free text when there's no known need (e.g. "חרדל"); category/subGroup for "איזה דג זול". */
  | { type: 'searchProductPrices'; needId?: string; query: string; category?: string; subGroup?: string }
  | { type: 'searchPromotions'; needId?: string; query?: string; stockUp?: boolean }
  | { type: 'addBasketItem'; needId?: string; newLabel?: string; quantity?: number; conditional?: 'good_price'; force?: boolean }
  | { type: 'removeBasketItem'; needId: string; temporary: boolean }
  | { type: 'replaceBasketItem'; needId: string }
  | { type: 'updateBasketQuantity'; needId: string; quantity?: number; delta?: number }
  | { type: 'generateBasket'; horizonDays: number; skipCheckin?: boolean }
  | { type: 'compareProviders'; providerId?: string }
  | { type: 'explainDecision'; needId?: string; needIds?: string[]; about?: 'store' }
  | { type: 'setTemporaryInstruction'; needId?: string; newLabel?: string; mode: 'skip' | 'include'; quantity?: number }
  | { type: 'prepareProviderCart'; providerId?: string }
  | { type: 'setBudget'; cap: number | null }
  | { type: 'askInsight'; q: InsightQuestion; needId?: string }
  | { type: 'clarify'; question: string; options: { label: string; send: string }[] }
  | { type: 'showStock' }
  | { type: 'confirmPurchase' }
  | { type: 'help' };

export const ACTION_ORDER: Action['type'][] = [
  'updateHouseholdStock', 'updatePreference', 'setBudget', 'setTemporaryInstruction', 'removeBasketItem', 'generateBasket',
  'addBasketItem', 'updateBasketQuantity', 'replaceBasketItem', 'searchProductPrices', 'searchPromotions',
  'compareProviders', 'prepareProviderCart', 'explainDecision', 'askInsight', 'showStock', 'confirmPurchase', 'clarify', 'help',
];
