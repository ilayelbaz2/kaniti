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

export type DeliveryResult = { providerId: string; name: string; delivers: boolean | null; note: string; deliveryFee?: number; checkedLive: boolean };
export type StoreOption = { storeId: string; name: string; city: string; address?: string };
export type CatalogItem = { id: string; label: string; emoji: string; staple: boolean; category: string };
export type LearningEventRow = { id: number; type: string; needId?: string; label?: string; value?: unknown; createdAt: string };

export const api = {
  state: () => call<AppState>('/state'),
  catalog: () => call<CatalogItem[]>('/catalog'),
  providers: () => call<{ online: { id: string; name: string; deliveryFee: number }[]; physicalChains: { id: string; name: string }[] }>('/providers'),
  deliveryCheck: (city: string, street?: string) => call<DeliveryResult[]>('/delivery-check', { city, street }),
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
  add: (needId: string, quantity?: number) => call<AppState>('/basket/add', { needId, quantity }),
  patchNeed: (id: string, patch: unknown) => call<AppState>(`/needs/${id}`, patch, 'PATCH'),
  setStock: (id: string, qty: number) => call<AppState>(`/needs/${id}/stock`, { qty }),
  events: () => call<LearningEventRow[]>('/events'),
  deals: () => call<{ deals: Deal[]; failures: { name: string }[]; demo: boolean; providers: Record<string, string> }>('/deals'),
  dismissDeal: (dealId: string, needId: string) => call('/deals/dismiss', { dealId, needId }),
  alwaysDeal: (needId: string) => call('/deals/always', { needId }),
  comparison: () => call<Comparison | null>('/compare'),
  compare: () => call<Comparison>('/compare', {}),
  purchase: (body: unknown) => call<{ purchase: Purchase; state: AppState }>('/purchase', body),
  purchases: () => call<Purchase[]>('/purchases'),
  feedback: (id: string, needId: string, value: string) => call<Purchase>(`/purchases/${id}/feedback`, { needId, value }),
  prepareCart: (providerId?: string) => call<CartJob>('/cart/prepare', { providerId }),
  cartJob: () => call<CartJob | null>('/cart/job'),
  resumeCart: (withoutLogin = false) => call<CartJob | null>('/cart/resume', { withoutLogin }),
  cartSeed: () => call<{ providerId: string; providerName: string; total?: number; items: { needId: string; quantity: number; productName?: string; price?: number }[] } | null>('/cart/seed'),
  devAdvance: (days: number) => call<AppState>('/dev/advance', { days }),
};
