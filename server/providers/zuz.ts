// One adapter for the chains running on the shared Stor.ai/"ZuZ" white-label store
// (Victory, Yenot Bitan, Carrefour, Tiv Taam, Keshet Teamim, Quik). Public JSON, no login for reading.
// Ref: SuperMarketScraping/documentation/{victory,keshet,ybitan}_api.md, supermeskill (2026).
import type { Address, DeliveryAvailability, ProductSearchResult } from '../../shared/types.ts';
import { cleanBrand } from '../../shared/product.ts';
import { nowIso } from '../clock.ts';
import { kvGet, kvSet } from '../db.ts';
import { httpFetch, num, type GroceryProvider } from './types.ts';
import { sameCity } from './cities.ts';
import { isoDay, normUnit, sizeOf } from './transparency.ts';

type ZuzChain = { id: string; name: string; host: string; retailerId: number; defaultBranch: number; fee: number; minOrder: number };

export const ZUZ_CHAINS: ZuzChain[] = [
  { id: 'victory', name: 'ויקטורי אונליין', host: 'https://www.victoryonline.co.il', retailerId: 1470, defaultBranch: 2930, fee: 29.9, minOrder: 200 },
  { id: 'ybitan', name: 'יינות ביתן אונליין', host: 'https://www.ybitan.co.il', retailerId: 1131, defaultBranch: 1015, fee: 29.9, minOrder: 200 },
  { id: 'carrefour', name: 'קרפור אונליין', host: 'https://www.carrefour.co.il', retailerId: 1540, defaultBranch: 0, fee: 29.9, minOrder: 200 },
  { id: 'tivtaam', name: 'טיב טעם אונליין', host: 'https://www.tivtaam.co.il', retailerId: 1062, defaultBranch: 924, fee: 29.9, minOrder: 300 },
  { id: 'keshet', name: 'קשת טעמים אונליין', host: 'https://www.keshet-teamim.co.il', retailerId: 1219, defaultBranch: 2585, fee: 29.9, minOrder: 200 },
  { id: 'quik', name: 'קוויק', host: 'https://www.quik.co.il', retailerId: 1541, defaultBranch: 3102, fee: 19.9, minOrder: 100 },
];

type ZBranch = { id: number; name: string; city?: string; isOnline?: boolean };
type ZProduct = {
  id: number; productId?: number; localName?: string; names?: Record<string, { short?: string; long?: string }>;
  brand?: { names?: Record<string, string> } | null; weight?: number; isWeighable?: boolean;
  unitOfMeasure?: { names?: Record<string, string> };
  branch?: {
    regularPrice?: number; salePrice?: number | null; isOutOfStock?: boolean; isActive?: boolean; isVisible?: boolean;
    // endDate/toDate: not in a saved response — read defensively, absent = unknown.
    specials?: { names?: Record<string, { name?: string }>; description?: string; endDate?: string | number; toDate?: string | number; firstLevel?: { type?: number; firstPurchaseTotal?: number; firstGift?: { total?: number } } }[];
  };
};

const SEARCH_FILTERS = JSON.stringify({
  must: { exists: ['family.id', 'family.categoriesPaths.id', 'branch.regularPrice'], term: { 'branch.isActive': true, 'branch.isVisible': true } },
  mustNot: { term: { 'branch.regularPrice': 0 } },
});

export function parseZuz(providerId: string, json: { products?: ZProduct[] }): ProductSearchResult[] {
  const fetchedAt = nowIso();
  return (json.products ?? []).map((p) => {
    const b = p.branch ?? {};
    const regular = num(b.regularPrice) ?? 0;
    let promoPrice = num(b.salePrice) && num(b.salePrice)! < regular ? num(b.salePrice) : undefined;
    let promoText: string | undefined;
    let promoMinQty: number | undefined;
    let promoEndsAt: string | undefined;
    for (const s of b.specials ?? []) {
      const desc = s.names?.['1']?.name ?? s.description;
      const ends = isoDay(s.endDate ?? s.toDate);
      // type 2 = "N for X": firstPurchaseTotal units for firstGift.total ₪. Other types are not decoded (no verified sample).
      if (s.firstLevel?.type === 2 && s.firstLevel.firstPurchaseTotal && s.firstLevel.firstGift?.total) {
        const per = s.firstLevel.firstGift.total / s.firstLevel.firstPurchaseTotal;
        if (per < regular && (!promoPrice || per < promoPrice)) { promoPrice = Math.round(per * 100) / 100; promoMinQty = s.firstLevel.firstPurchaseTotal; promoText = desc; promoEndsAt = ends; }
      } else if (!promoText && desc && promoPrice) { promoText = desc; promoEndsAt = ends; }
    }
    // localName is cut at 20 characters in real responses ("פסטה מריה  פסטה ביצי") — the long name is the full one.
    const name = (p.names?.['1']?.long || p.names?.['1']?.short || p.localName || '').replace(/\s+/g, ' ').trim();
    const byWeight = !!p.isWeighable;
    const unit = p.unitOfMeasure?.names?.['1']?.trim();
    return {
      providerId, productId: String(p.id ?? p.productId), name, brand: cleanBrand(p.brand?.names?.['1']),
      price: regular, promoPrice, promoMinQty, promoText: promoText ?? (promoPrice ? 'מבצע' : undefined), promoEndsAt: promoPrice ? promoEndsAt : undefined,
      sizeText: sizeOf(p.weight, unit) ?? (num(p.weight) && unit && !normUnit(unit) && !/^[\d.\s]+$/.test(unit) ? `${num(p.weight)} ${unit}` : undefined) ?? (byWeight ? 'לק"ג' : undefined),
      byWeight: byWeight || undefined,
      available: !b.isOutOfStock && b.isActive !== false,
      source: 'live' as const, fetchedAt,
    };
  }).filter((r) => r.price > 0 && r.name);
}

type ZAreasResponse = { areas?: { id: number; name: string; branchId?: number; deliveryAreaPrice?: number; deliveryMinimumCost?: number | null }[]; addressComponents?: { long_name: string; types: string[] }[]; error?: string };

/** Turns the site's address→area lookup into a delivery result. 200+areas = the site delivers to this exact address. */
export function zuzAddressResult(chain: ZuzChain, status: number, j: ZAreasResponse | null): DeliveryAvailability {
  const comp = (t: string) => j?.addressComponents?.find((c) => c.types.includes(t))?.long_name;
  const addressText = comp('route') ? [[comp('route'), comp('street_number')].filter(Boolean).join(' '), comp('locality')].filter(Boolean).join(', ') : undefined;
  const area = j?.areas?.[0];
  if (status === 200 && area) {
    if (area.branchId) kvSet(`provider:${chain.id}:branch`, area.branchId);
    return { providerId: chain.id, status: 'confirmed', delivers: true, checkedLive: true, addressText, deliveryFee: area.deliveryAreaPrice ?? chain.fee, minOrder: area.deliveryMinimumCost ?? chain.minOrder, note: `האתר מאשר משלוח לכתובת${addressText ? ` (${addressText})` : ''} — אזור ${area.name}` };
  }
  if (status === 404 || (status === 200 && !area)) return { providerId: chain.id, status: 'unavailable', delivers: false, checkedLive: true, addressText, note: 'לפי האתר, הכתובת מחוץ לאזורי המשלוח של הרשת.' };
  if (status === 400) return { providerId: chain.id, status: 'unknown', delivers: null, checkedLive: true, note: 'האתר לא זיהה את הכתובת — בדקו רחוב ומספר בית.' };
  return { providerId: chain.id, status: 'unknown', delivers: null, checkedLive: false, note: `לא הצלחתי לבדוק כרגע (HTTP ${status}).` };
}

export function zuzProvider(chain: ZuzChain): GroceryProvider {
  const key = `provider:${chain.id}:branch`;
  const branch = () => kvGet<number>(key) ?? chain.defaultBranch;
  async function branches(): Promise<ZBranch[]> {
    const res = await httpFetch(`${chain.host}/v2/retailers/${chain.retailerId}/branches?appId=4&languageId=1`, { headers: { Accept: 'application/json' } });
    const j = (await res.json()) as { branches?: ZBranch[] };
    return j.branches ?? [];
  }
  return {
    id: chain.id, name: chain.name, kind: 'online', deliveryFee: chain.fee, minOrder: chain.minOrder,
    async checkDelivery(address: Address): Promise<DeliveryAvailability> {
      // Exact address: the site's own lookup geocodes the street address against the chain's delivery polygons.
      if (address.street) {
        const url = `${chain.host}/v2/retailers/${chain.retailerId}/areas?appId=4&languageId=1&deliveryTypeId=1&deliveryTypeId=5&query=${encodeURIComponent(`${address.street}, ${address.city}`)}`;
        const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126 Safari/537.36' }, signal: AbortSignal.timeout(12000) });
        const j = (await res.json().catch(() => null)) as ZAreasResponse | null;
        return zuzAddressResult(chain, res.status, j);
      }
      const list = await branches();
      const local = list.filter((b) => sameCity(b.city, address.city) || sameCity(b.name, address.city));
      const pick = local.find((b) => /אונליין|online|אינטרנט/i.test(b.name)) ?? local[0];
      if (pick) kvSet(key, pick.id);
      else if (!chain.defaultBranch && list[0]) kvSet(key, list[0].id);
      return { providerId: chain.id, status: 'unknown', delivers: pick ? true : null, checkedLive: true, deliveryFee: chain.fee, minOrder: chain.minOrder, note: 'בלי רחוב ומספר בית אי אפשר לבדוק משלוח לכתובת מדויקת.' };
    },
    async searchProducts(query) {
      let bid = branch();
      if (!bid) { const list = await branches(); bid = list[0]?.id ?? 0; kvSet(key, bid); }
      const url = `${chain.host}/v2/retailers/${chain.retailerId}/branches/${bid}/products?appId=4&languageId=1&isSearch=true&from=0&size=24&query=${encodeURIComponent(query)}&filters=${encodeURIComponent(SEARCH_FILTERS)}`;
      const res = await httpFetch(url, { headers: { Accept: 'application/json' } });
      const rows = parseZuz(chain.id, (await res.json()) as { products?: ZProduct[] });
      if (!rows.length && chain.defaultBranch && bid !== chain.defaultBranch) {
        // Some branches return an empty online catalog — fall back to the chain's main online branch.
        const res2 = await httpFetch(url.replace(`/branches/${bid}/`, `/branches/${chain.defaultBranch}/`), { headers: { Accept: 'application/json' } });
        return parseZuz(chain.id, (await res2.json()) as { products?: ZProduct[] });
      }
      return rows;
    },
  };
}
