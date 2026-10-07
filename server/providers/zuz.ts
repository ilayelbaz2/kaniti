// One adapter for the chains running on the shared Stor.ai/"ZuZ" white-label store
// (Victory, Yenot Bitan, Carrefour, Tiv Taam, Keshet Teamim, Quik). Public JSON, no login for reading.
// Ref: SuperMarketScraping/documentation/{victory,keshet,ybitan}_api.md, supermeskill (2026).
import type { Address, DeliveryAvailability, ProductSearchResult } from '../../shared/types.ts';
import { nowIso } from '../clock.ts';
import { kvGet, kvSet } from '../db.ts';
import { httpFetch, num, type GroceryProvider } from './types.ts';
import { sameCity } from './cities.ts';

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
    specials?: { names?: Record<string, { name?: string }>; description?: string; firstLevel?: { type?: number; firstPurchaseTotal?: number; firstGift?: { total?: number } } }[];
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
    for (const s of b.specials ?? []) {
      const desc = s.names?.['1']?.name ?? s.description;
      if (s.firstLevel?.type === 2 && s.firstLevel.firstPurchaseTotal && s.firstLevel.firstGift?.total) {
        const per = s.firstLevel.firstGift.total / s.firstLevel.firstPurchaseTotal;
        if (per < regular && (!promoPrice || per < promoPrice)) { promoPrice = Math.round(per * 100) / 100; promoMinQty = s.firstLevel.firstPurchaseTotal; promoText = desc; }
      } else if (!promoText && desc && promoPrice) promoText = desc;
    }
    const name = p.localName ?? p.names?.['1']?.long ?? p.names?.['1']?.short ?? '';
    const unit = p.unitOfMeasure?.names?.['1'];
    return {
      providerId, productId: String(p.id ?? p.productId), name, brand: p.brand?.names?.['1'],
      price: regular, promoPrice, promoMinQty, promoText: promoText ?? (promoPrice ? 'מבצע' : undefined),
      sizeText: p.isWeighable ? 'לק"ג' : p.weight && unit ? `${p.weight} ${unit}` : undefined,
      available: !b.isOutOfStock && b.isActive !== false,
      source: 'live' as const, fetchedAt,
    };
  }).filter((r) => r.price > 0 && r.name);
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
      const list = await branches();
      const local = list.filter((b) => sameCity(b.city, address.city) || sameCity(b.name, address.city));
      const pick = local.find((b) => /אונליין|online|אינטרנט/i.test(b.name)) ?? local[0];
      if (pick) {
        kvSet(key, pick.id);
        return { providerId: chain.id, status: 'unknown', delivers: true, checkedLive: true, deliveryFee: chain.fee, minOrder: chain.minOrder, note: `יש סניף ב${address.city} (${pick.name}, #${pick.id}) — לפי רשימת הסניפים, לא אומת מול הכתובת` };
      }
      if (!chain.defaultBranch && list[0]) kvSet(key, list[0].id);
      return { providerId: chain.id, status: 'unknown', delivers: null, checkedLive: true, deliveryFee: chain.fee, minOrder: chain.minOrder, note: `אין סניף של הרשת ב${address.city}. ייתכן שמשלחים ממרכז הפצה — לא אומת` };
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
