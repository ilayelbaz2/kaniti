// Provider registry + price scanning with per-provider failure isolation and a short cache.
import type { Household, ProductSearchResult } from '../../shared/types.ts';
import { store } from '../db.ts';
import { getConcept } from '../state.ts';
import type { PriceBook } from '../engine/basket.ts';
import { demoProvider } from './demo.ts';
import { ramilevy } from './ramilevy.ts';
import { shufersal } from './shufersal.ts';
import { PHYSICAL_CHAINS, physicalProvider } from './transparency.ts';
import { withTimeout, type GroceryProvider } from './types.ts';
import { ZUZ_CHAINS, zuzProvider } from './zuz.ts';

export const DEMO = process.env.KANITI_DEMO === '1';

const LIVE_ONLINE: GroceryProvider[] = [shufersal, ramilevy, ...ZUZ_CHAINS.map(zuzProvider)];

export function onlineCatalog(): GroceryProvider[] {
  return DEMO ? LIVE_ONLINE.map((p) => demoProvider(p.id, p.name + ' · דמו', p.deliveryFee)) : LIVE_ONLINE;
}

export function householdProviders(h: Household | null, opts: { physical?: boolean } = {}): GroceryProvider[] {
  if (!h) return [];
  const online = onlineCatalog().filter((p) => h.onlineProviders.includes(p.id));
  if (!opts.physical) return online;
  const physical = h.physicalStores.flatMap((s) => {
    const chain = PHYSICAL_CHAINS.find((c) => c.id === s.chainId);
    if (!chain) return [];
    if (DEMO) return [{ ...demoProvider(`branch:${s.chainId}:${s.storeId}`, `${chain.name} — ${s.name} · דמו`, 0), kind: 'physical' as const }];
    return [physicalProvider(chain, s.storeId, s.name)];
  });
  return [...online, ...physical];
}

// ---------- cached search ----------

const cache = new Map<string, { at: number; rows: ProductSearchResult[] }>();
const TTL = 30 * 60 * 1000;

export async function cachedSearch(p: GroceryProvider, query: string, needId?: string): Promise<ProductSearchResult[]> {
  const key = `${p.id}|${query}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.rows;
  const rows = await withTimeout(p.searchProducts(query), 20000, p.name);
  cache.set(key, { at: Date.now(), rows });
  if (needId) store.addPrices(needId, rows.filter((r) => r.available));
  return rows;
}

async function mapLimit<T, R>(xs: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, xs.length) }, async () => {
    while (i < xs.length) { const k = i++; out[k] = await fn(xs[k]); }
  }));
  return out;
}

/** Search every need on every provider. One provider failing never fails the scan. */
export async function scanPrices(needIds: string[], providers: GroceryProvider[]): Promise<PriceBook & { perProvider: Map<string, Map<string, ProductSearchResult[]>> }> {
  const book = { byNeed: new Map<string, ProductSearchResult[]>(), failures: [] as PriceBook['failures'], sources: new Set<string>(), perProvider: new Map<string, Map<string, ProductSearchResult[]>>() };
  await Promise.all(providers.map(async (p) => {
    const mine = new Map<string, ProductSearchResult[]>();
    let consecutiveErrors = 0;
    let lastError = '';
    await mapLimit(needIds, 4, async (needId) => {
      if (consecutiveErrors >= 2) return; // provider looks down — stop hammering it
      try {
        const rows = await cachedSearch(p, getConcept(needId).query, needId);
        mine.set(needId, rows);
        consecutiveErrors = 0;
      } catch (e) {
        consecutiveErrors++;
        lastError = (e as Error).message;
      }
    });
    if (!mine.size && needIds.length) {
      book.failures.push({ providerId: p.id, name: p.name, error: lastError || 'אין תוצאות' });
      return;
    }
    book.perProvider.set(p.id, mine);
    book.sources.add(p.id);
    for (const [needId, rows] of mine) book.byNeed.set(needId, [...(book.byNeed.get(needId) ?? []), ...rows]);
  }));
  return book;
}

/** The basket is priced at one reference store (last place they bought, else the first chosen chain). */
export function referenceBook(book: Awaited<ReturnType<typeof scanPrices>>, h: Household | null): PriceBook {
  const last = store.purchases()[0]?.providerId;
  const refId = [last, ...(h?.onlineProviders ?? [])].find((id) => id && book.perProvider.has(id));
  if (!refId) return book;
  const ref = book.perProvider.get(refId)!;
  const byNeed = new Map<string, ProductSearchResult[]>();
  for (const [needId, rows] of book.byNeed) byNeed.set(needId, ref.get(needId)?.some((r) => r.available) ? ref.get(needId)! : rows);
  return { byNeed, failures: book.failures, sources: book.sources };
}

export function providerName(id: string): string {
  const h = store.household();
  return householdProviders(h, { physical: true }).find((p) => p.id === id)?.name ?? onlineCatalog().find((p) => p.id === id)?.name ?? id;
}
