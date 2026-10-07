// Shufersal Online — public JSON search (same endpoint the website uses). Prices are chain-wide online prices.
// Ref: OpenIsraeliSupermarkets / SuperMarketScraping docs (2026-03).
import type { DeliveryAvailability, ProductSearchResult } from '../../shared/types.ts';
import { cleanBrand } from '../../shared/product.ts';
import { nowIso } from '../clock.ts';
import { isoDay } from './transparency.ts';
import { httpFetch, num, type GroceryProvider } from './types.ts';

const BASE = 'https://www.shufersal.co.il/online/he';

type ShufersalProduct = {
  code: string; sku?: string; name: string;
  price?: { value: number }; categoryPrice?: { value: number };
  brand?: { name?: string } | null; manufacturer?: string | null;
  unitDescription?: string | null; unitForComparison?: string | null; valueForComparison?: number | null;
  sellingMethod?: { code?: string };
  promotionMsg?: string | null;
  // Not seen in a saved response — read defensively (SAP Commerce PromotionData carries endDate).
  promotionEndDate?: string | number | null;
  potentialPromotions?: { endDate?: string | number | null }[] | null;
  stock?: { stockLevelStatus?: { code?: string } };
};

/** Per-unit price of a Shufersal promotion message, or undefined when the message isn't a clear multi-buy.
 *  "2 יח' ב- 22 ₪" → 11 ×2 · "1+1" → ½ ×2 · "2+1" → ⅔ ×3 · "השני ב-50%" / "השני בחצי מחיר" → ¾ ×2 · "השני חינם" → ½ ×2 ·
 *  "3 ב-10" (no ₪) → 3.33 ×3. */
export function shufersalPromo(msg: string | null | undefined, regular: number): { per: number; minQty: number } | undefined {
  const t = (msg ?? '').replace(/\s+/g, ' ');
  if (!t || !(regular > 0)) return undefined;
  let per = 0, minQty = 0;
  let m: RegExpMatchArray | null;
  if ((m = t.match(/(?<![\d.])(\d{1,2})\s*\+\s*(\d{1,2})(?![\d.%])/))) {
    const [buy, free] = [parseInt(m[1]), parseInt(m[2])];
    if (buy >= 1 && free >= 1 && free <= buy) { minQty = buy + free; per = (regular * buy) / minQty; }
  } else if (/השני\s*(?:ב-?\s*50\s*%|בחצי(?:\s*מחיר)?|ב-?\s*חצי(?:\s*מחיר)?)/.test(t)) {
    minQty = 2; per = regular * 0.75;
  } else if (/השני\s*(?:חינם|מתנה|ב-?\s*100\s*%)/.test(t)) {
    minQty = 2; per = regular / 2;
  } else if ((m = t.match(/(?<![\d.])(\d{1,2})\s*(?:יח'?|יח׳|יחידות)?\s*ב\s*-?\s*(?:₪\s*)?(\d+(?:\.\d+)?)\s*(₪|ש"ח|ש״ח|שח)?(?!\s*%|[\d.])/))) {
    const n = parseInt(m[1]);
    const total = parseFloat(m[2]);
    // Without a currency sign "3 ב-10" is still a multi-buy when the total is in a believable range for n units.
    if (n >= 2 && total > 0 && (m[3] || (total < regular * n && total >= regular * 0.5))) { minQty = n; per = total / n; }
  }
  if (!(per > 0 && per < regular && per >= regular * 0.3)) return undefined;
  return { per: Math.round(per * 100) / 100, minQty };
}

export function parseShufersal(json: { results?: ShufersalProduct[] }): ProductSearchResult[] {
  const fetchedAt = nowIso();
  return (json.results ?? []).map((p) => {
    const regular = num(p.price?.value) ?? num(p.categoryPrice?.value) ?? 0;
    const cat = num(p.categoryPrice?.value);
    let promoPrice = cat && cat < regular ? cat : undefined;
    let promoMinQty: number | undefined;
    const deal = shufersalPromo(p.promotionMsg, regular);
    if (deal && (!promoPrice || deal.per < promoPrice)) { promoPrice = deal.per; promoMinQty = deal.minQty; }
    const byWeight = p.sellingMethod?.code === 'BY_WEIGHT';
    const promoEndsAt = promoPrice ? isoDay(p.promotionEndDate ?? p.potentialPromotions?.find((x) => x?.endDate)?.endDate) : undefined;
    return {
      providerId: 'shufersal', productId: p.code, name: p.name, brand: cleanBrand(p.brand?.name ?? undefined) ?? cleanBrand(p.manufacturer ?? undefined),
      price: regular, promoPrice, promoMinQty, promoText: p.promotionMsg ?? undefined, promoEndsAt,
      sizeText: byWeight ? 'לק"ג' : p.unitDescription ?? undefined, byWeight: byWeight || undefined,
      unitPriceText: p.valueForComparison && p.unitForComparison ? `${p.valueForComparison} ${p.unitForComparison}` : undefined,
      available: p.stock?.stockLevelStatus?.code !== 'outOfStock',
      source: 'live' as const, fetchedAt,
    };
  }).filter((r) => r.price > 0);
}

export const shufersal: GroceryProvider = {
  id: 'shufersal', name: 'שופרסל אונליין', kind: 'online', deliveryFee: 35.9, minOrder: 150, freeDeliveryFrom: undefined,
  async checkDelivery(address): Promise<DeliveryAvailability> {
    // No public address check — Shufersal Online delivers to most of the country. Be honest about it.
    return {
      providerId: 'shufersal', status: 'user_action_required', needsLogin: true, delivers: true, checkedLive: false, deliveryFee: 35.9, minOrder: 150,
      note: `שופרסל לא מאפשרת לבדוק כתובת בלי חשבון. אאמת את ${address.street ? `${address.street}, ` : ''}${address.city} באתר כשתתחברו (בהכנת העגלה או בבדיקת משלוח).`,
    };
  },
  async searchProducts(query) {
    const res = await httpFetch(`${BASE}/search/results?q=${encodeURIComponent(query)}&limit=20`, {
      headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    });
    const text = await res.text();
    if (text.trimStart().startsWith('<')) throw new Error('שופרסל החזירה HTML במקום JSON (כנראה חסימה)');
    return parseShufersal(JSON.parse(text));
  },
};
