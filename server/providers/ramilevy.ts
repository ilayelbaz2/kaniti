// Rami Levy Online — public catalog API used by the website (no login for reading).
// Ref: SuperMarketScraping/documentation/ramilevi_api.md (2026-05), rami-levy-mcp.
import type { Address, DeliveryAvailability, ProductSearchResult } from '../../shared/types.ts';
import { nowIso } from '../clock.ts';
import { kvGet, kvSet } from '../db.ts';
import { httpFetch, num, type GroceryProvider } from './types.ts';
import { sameCity } from './cities.ts';

const BASE = 'https://www.rami-levy.co.il';
const DEFAULT_STORE = 331;

type RLItem = {
  id: number; barcode?: number; name: string;
  price?: { price: number };
  prop?: { by_kilo?: number };
  gs?: { BrandName?: string; Net_Content?: { text?: string } };
  sale?: { scm?: number | string; name?: string; label?: string; is_club?: number; cmt?: number | string }[];
  available_in?: number[];
};
type RLStore = { id: string; name: string; city: string; internet_store_id: number | null; delivery: number };

export function parseRamiLevy(json: { data?: RLItem[] }, storeId: number): ProductSearchResult[] {
  const fetchedAt = nowIso();
  return (json.data ?? []).map((p) => {
    const regular = num(p.price?.price) ?? 0;
    const sale = (p.sale ?? []).find((s) => !s.is_club && num(s.scm) && num(s.scm)! < regular);
    return {
      providerId: 'ramilevy', productId: String(p.id), name: p.name, brand: p.gs?.BrandName,
      price: regular, promoPrice: sale ? num(sale.scm) : undefined, promoText: sale ? (sale.name || sale.label || 'מבצע') : undefined,
      sizeText: p.prop?.by_kilo ? 'לק"ג' : p.gs?.Net_Content?.text,
      available: !p.available_in || p.available_in.includes(storeId),
      source: 'live' as const, fetchedAt,
    };
  }).filter((r) => r.price > 0);
}

async function stores(): Promise<RLStore[]> {
  const res = await httpFetch(`${BASE}/api/stores`, { headers: { Accept: 'application/json' } });
  const j = (await res.json()) as { stores?: { data?: RLStore[] } };
  return j.stores?.data ?? [];
}

const storeId = () => kvGet<number>('provider:ramilevy:store') ?? DEFAULT_STORE;

export const ramilevy: GroceryProvider = {
  id: 'ramilevy', name: 'רמי לוי אונליין', kind: 'online', deliveryFee: 29.9, minOrder: 250,
  async checkDelivery(address: Address): Promise<DeliveryAvailability> {
    const all = await stores();
    const delivering = all.filter((s) => s.delivery && s.internet_store_id);
    const local = delivering.find((s) => sameCity(s.city, address.city)) ?? all.find((s) => s.internet_store_id && sameCity(s.city, address.city));
    if (local?.internet_store_id) {
      kvSet('provider:ramilevy:store', local.internet_store_id);
      return { providerId: 'ramilevy', status: 'likely', delivers: true, checkedLive: true, deliveryFee: 29.9, minOrder: 250, note: `יש סניף משלוחים ב${local.city} (${local.name}) — לפי העיר, לא אומת מול הכתובת` };
    }
    return {
      providerId: 'ramilevy', status: 'unknown', delivers: null, checkedLive: true, deliveryFee: 29.9, minOrder: 250,
      note: `לא מצאתי סניף משלוחים של רמי לוי ב${address.city}. ייתכן שמשלחים מסניף קרוב — אפשר לסמן ידנית.`,
    };
  },
  async searchProducts(query) {
    const sid = storeId();
    const res = await httpFetch(`${BASE}/api/catalog?`, {
      method: 'POST',
      headers: { Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json;charset=UTF-8', locale: 'he', Origin: BASE, Referer: `${BASE}/he` },
      body: JSON.stringify({ q: query, store: String(sid), aggs: 0, from: 0, size: 24 }),
    });
    return parseRamiLevy((await res.json()) as { data?: RLItem[] }, sid);
  },
};
