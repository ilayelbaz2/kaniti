import type { AppState, CartJob, ChatMessage, Comparison, Deal, Purchase, ProductSearchResult } from '../shared/types.ts';

async function call<T>(path: string, body?: unknown, method?: string): Promise<T> {
  const res = await fetch('/api' + path, {
    method: method ?? (body !== undefined ? 'POST' : 'GET'),
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `שגיאה ${res.status}`);
  return data as T;
}

export type DeliveryResult = { providerId: string; name: string; status?: 'confirmed' | 'unavailable' | 'user_action_required' | 'unknown'; needsLogin?: boolean; addressText?: string; delivers: boolean | null; note: string; deliveryFee?: number; minOrder?: number; checkedLive: boolean };
export type StoreOption = { storeId: string; name: string; city: string; address?: string };
export type Confidence = 'observed' | 'estimated' | 'insufficient';
export type Insight = { id: string; kind: string; text: string; confidence: Confidence; basis?: string; value?: number; needId?: string; date?: string };
export type InsightsReport = { spending: Insight[]; categories: { rows: { group: string; amount: number; share: number }[]; insight: Insight }; rhythm: Insight[]; consumption: Insight[]; savings: { insights: Insight[]; saved: number; estimated: number; potential: number }; nextShop: Insight; weekday: Insight };
export type SearchCard = ProductSearchResult & { providerName: string; ambiguous: boolean };
export type SearchResponse = { query: string; concept?: { id: string; label: string; emoji: string }; results: SearchCard[]; failures: string[] };
export type CatalogItem = { id: string; label: string; emoji: string; staple: boolean; category: string; group: string; kidItem: boolean; dairy: boolean; meat: boolean };
export type LearningEventRow = { id: number; type: string; needId?: string; label?: string; value?: unknown; createdAt: string };

export const api = {
  state: () => call<AppState>('/state'),
  catalog: () => call<CatalogItem[]>('/catalog'),
  providers: () => call<{ online: { id: string; name: string; deliveryFee: number }[]; physicalChains: { id: string; name: string }[] }>('/providers'),
  deliveryCheck: (city: string, street?: string, providerId?: string) => call<DeliveryResult[]>('/delivery-check', { city, street, providerId }),
  stores: (chainId: string, city: string) => call<StoreOption[]>(`/stores/${chainId}?city=${encodeURIComponent(city)}`),
  onboarding: (body: unknown) => call<AppState>('/onboarding', body),
  patchHousehold: (body: unknown) => call<AppState>('/household', body, 'PATCH'),
  chatHistory: () => call<ChatMessage[]>('/chat'),
  chat: (text: string, label?: string) => call<{ messages: ChatMessage[]; state: AppState }>('/chat', { text, label }),
  build: (horizonDays = 14) => call<{ state: AppState; failures: { name: string }[] }>('/basket/build', { horizonDays }),
  qty: (needId: string, quantity: number) => call<AppState>(`/basket/${needId}/qty`, { quantity }),
  remove: (needId: string, temporary = true) => call<AppState>(`/basket/${needId}/remove`, { temporary }),
  accept: (needId: string) => call<AppState>(`/basket/${needId}/accept`, {}),
  lock: (needId: string, locked: boolean) => call<AppState>(`/basket/${needId}/lock`, { locked }),
  alternatives: (needId: string) => call<ProductSearchResult[]>(`/basket/${needId}/alternatives`),
  replace: (needId: string, productId?: string) => call<{ state: AppState; replacements: number }>(`/basket/${needId}/replace`, { productId }),
  why: (needId: string) => call<{ text: string }>(`/basket/${needId}/why`),
  add: (needId: string, quantity?: number, product?: { providerId: string; productId: string }) => call<AppState>('/basket/add', { needId, quantity, product }),
  addLabel: (newLabel: string, quantity?: number, product?: { providerId: string; productId: string }) => call<AppState>('/basket/add', { newLabel, quantity, product }),
  insights: () => call<InsightsReport>('/insights'),
  search: (q: string) => call<SearchResponse>(`/products/search?q=${encodeURIComponent(q)}`),
  patchNeed: (id: string, patch: unknown) => call<AppState>(`/needs/${id}`, patch, 'PATCH'),
  setStock: (id: string, qty: number) => call<AppState>(`/needs/${id}/stock`, { qty }),
  events: () => call<LearningEventRow[]>('/events'),
  deals: () => call<{ deals: Deal[]; failures: { name: string }[]; demo: boolean; providers: Record<string, string>; note?: string; checkedNeeds: number }>('/deals'),
  dismissDeal: (dealId: string, needId: string) => call('/deals/dismiss', { dealId, needId }),
  alwaysDeal: (needId: string) => call('/deals/always', { needId }),
  comparison: () => call<Comparison | null>('/compare'),
  compare: () => call<Comparison>('/compare', {}),
  purchase: (body: unknown) => call<{ purchase: Purchase; state: AppState }>('/purchase', body),
  purchases: () => call<Purchase[]>('/purchases'),
  feedback: (id: string, needId: string, value: string) => call<Purchase>(`/purchases/${id}/feedback`, { needId, value }),
  prepareCart: (providerId?: string, verifyOnly = false) => call<CartJob>('/cart/prepare', { providerId, verifyOnly }),
  cartJob: () => call<CartJob | null>('/cart/job'),
  resumeCart: (kind: 'continue' | 'skip_login' | 'skip_address' = 'continue') => call<CartJob | null>('/cart/resume', { kind }),
  showCart: () => call<{ ok: boolean; message: string }>('/cart/show', {}),
  cartSeed: () => call<{ providerId: string; providerName: string; total?: number; items: { needId: string; quantity: number; productName?: string; price?: number }[] } | null>('/cart/seed'),
  devAdvance: (days: number) => call<AppState>('/dev/advance', { days }),
};
