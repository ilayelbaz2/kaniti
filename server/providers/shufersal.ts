// Shufersal Online — public JSON search (same endpoint the website uses). Prices are chain-wide online prices.
// Ref: OpenIsraeliSupermarkets / SuperMarketScraping docs (2026-03).
import type { DeliveryAvailability, ProductSearchResult } from '../../shared/types.ts';
import { nowIso } from '../clock.ts';
import { httpFetch, num, type GroceryProvider } from './types.ts';

const BASE = 'https://www.shufersal.co.il/online/he';

type ShufersalProduct = {
  code: string; sku?: string; name: string;
  price?: { value: number }; categoryPrice?: { value: number };
  brand?: { name?: string } | null; manufacturer?: string | null;
  unitDescription?: string | null; unitForComparison?: string | null; valueForComparison?: number | null;
  sellingMethod?: { code?: string };
  promotionMsg?: string | null;
  stock?: { stockLevelStatus?: { code?: string } };
};

export function parseShufersal(json: { results?: ShufersalProduct[] }): ProductSearchResult[] {
  const fetchedAt = nowIso();
  return (json.results ?? []).map((p) => {
    const regular = num(p.price?.value) ?? num(p.categoryPrice?.value) ?? 0;
    const cat = num(p.categoryPrice?.value);
    let promoPrice = cat && cat < regular ? cat : undefined;
    let promoMinQty: number | undefined;
    // "2 יח' ב- 22 ₪" → 11 per unit
    const m = p.promotionMsg?.match(/(\d+)\s*(?:יח'?|יחידות|ב)\D*?(\d+(?:\.\d+)?)\s*₪/);
    if (m) {
      const per = parseFloat(m[2]) / parseInt(m[1]);
      if (per > 0 && per < regular) { promoPrice = Math.round(per * 100) / 100; promoMinQty = parseInt(m[1]); }
    }
    const byWeight = p.sellingMethod?.code === 'BY_WEIGHT';
    return {
      providerId: 'shufersal', productId: p.code, name: p.name, brand: p.brand?.name ?? p.manufacturer ?? undefined,
      price: regular, promoPrice, promoMinQty, promoText: p.promotionMsg ?? undefined,
      sizeText: byWeight ? 'לק"ג' : p.unitDescription ?? undefined,
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
      providerId: 'shufersal', delivers: true, checkedLive: false, deliveryFee: 35.9, minOrder: 150,
      note: `שופרסל אונליין מגיעה לרוב הארץ. לא הצלחתי לאמת את ${address.city} מול האתר — כדאי לוודא בהזמנה הראשונה.`,
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
