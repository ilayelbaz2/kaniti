import type { Address, BasketQuote, DeliveryAvailability, ProductSearchResult } from '../../shared/types.ts';

export type BasketRequestItem = { needId: string; label: string; quantity: number };

export type Promotion = { productId: string; name: string; promoPrice: number; regularPrice: number; text: string };

/** One abstraction for every price source. Online chains are 'online'; price-transparency branches are 'physical'. */
export interface GroceryProvider {
  id: string;
  name: string;
  kind: 'online' | 'physical';
  checkDelivery(address: Address): Promise<DeliveryAvailability>;
  searchProducts(query: string): Promise<ProductSearchResult[]>;
  getProduct?(productId: string): Promise<ProductSearchResult | null>;
  getPromotions?(): Promise<Promotion[]>;
  /** Optional: a provider that can price a real cart. Otherwise the generic search-based quote is used. */
  quoteBasket?(items: BasketRequestItem[], address: Address): Promise<BasketQuote>;
  deliveryFee: number;
  minOrder: number;
  freeDeliveryFrom?: number;
}

export class ProviderError extends Error {
  constructor(public providerId: string, message: string) {
    super(message);
  }
}

export async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${label}: timeout after ${ms}ms`)), ms); });
  try { return await Promise.race([p, timeout]); } finally { clearTimeout(t); }
}

/** fetch with a browser-ish UA and a timeout. */
export async function httpFetch(url: string, init: RequestInit = {}, ms = 12000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      ...init,
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
        'Accept-Language': 'he-IL,he;q=0.9',
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    return res;
  } finally {
    clearTimeout(t);
  }
}

export const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? parseFloat(v.replace(/[^\d.]/g, '')) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
};
