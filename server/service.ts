// Application operations. Both the HTTP routes and the chat executor call these — one source of truth.
import type { Basket, BasketItem, Deal, Purchase, ProductSearchResult } from '../shared/types.ts';
import { store, kvGet, kvSet } from './db.ts';
import { nowIso, uid } from './clock.ts';
import { allConcepts, customConceptFor, ensureNeed, estimateStock, getConcept, learnFromQuantity, learnFromRemoval, learnFromReplacement, logEvent, updateNeed } from './state.ts';
import { basketTotal, discoveryDeals, emptyPriceBook, evalCondition, generateBasket, householdDeals, toResolved, type PriceBook } from './engine/basket.ts';
import { chooseProduct, cheaper, effPrice, fit, relevant } from './engine/match.ts';
import { householdProviders, referenceBook, scanPrices } from './providers/index.ts';
import { round1 } from './catalog.ts';
import { currentJob as currentCartJob } from './cart/prepare.ts';

export type ScanResult = { book: PriceBook; failures: PriceBook['failures'] };

/** Price scan for everything the basket might touch: active needs, requested items, and a few discovery candidates. */
export async function scanForBasket(extraNeedIds: string[] = []): Promise<ScanResult> {
  const h = store.household();
  const providers = householdProviders(h);
  if (!providers.length && !h?.physicalStores.length) return { book: emptyPriceBook(), failures: [] };
  const needs = store.needs();
  const active = needs.filter((n) => n.active && !n.neverSuggest).map((n) => n.id);
  const discovery = rotatingDiscoveryCandidates();
  const groups = new Set(active.map((id) => getConcept(id).subGroup).filter(Boolean));
  const siblings = allConcepts().filter((c) => c.subGroup && groups.has(c.subGroup)).map((c) => c.id);
  const ids = [...new Set([...active, ...extraNeedIds, ...siblings, ...discovery])];
  let full = await scanPrices(ids, providers);
  // Every online chain failed → fall back to branch price files so the basket still has (labelled) prices.
  if (!full.byNeed.size) {
    const physical = householdProviders(h, { physical: true }).filter((p) => p.kind === 'physical');
    if (physical.length) {
      const fb = await scanPrices(ids, physical);
      full = { ...fb, failures: [...full.failures, ...fb.failures] };
    }
  }
  return { book: referenceBook(full, h), failures: full.failures };
}

/** A handful of not-yet-bought concepts per scan, rotating weekly, so discovery stays cheap and restrained. */
function rotatingDiscoveryCandidates(): string[] {
  const needs = store.needs();
  const pool = allConcepts()
    .filter((c) => !needs.find((n) => n.id === c.id && (n.active || n.neverSuggest || n.dismissedDeals >= 2)))
    .map((c) => c.id);
  const week = Math.floor(Date.now() / (7 * 86400000));
  const start = (week * 5) % Math.max(1, pool.length);
  return [...pool.slice(start), ...pool.slice(0, start)].slice(0, 6);
}

export async function buildBasket(horizonDays = 14): Promise<{ basket: Basket; failures: PriceBook['failures'] }> {
  const previous = store.basket();
  const prevBuilding = previous?.status === 'building' ? previous : null;
  const extra = prevBuilding?.items.filter((i) => i.source === 'user_request').map((i) => i.needId) ?? [];
  const { book, failures } = await scanForBasket(extra);
  const basket = generateBasket({ horizonDays, prices: book, previous: prevBuilding });
  if (failures.length) basket.notes.push(...failures.map((f) => `${f.name} לא החזירה מחיר כרגע — המשכתי עם שאר הרשתות.`));
  if (book.byNeed.size) basket.priceSourceNote = sourceNote(book);
  store.saveBasket(basket);
  store.saveComparison(null);
  kvSet('lastBook', serializeBook(book));
  return { basket, failures };
}

function sourceNote(book: PriceBook) {
  const all = [...book.byNeed.values()].flat();
  if (all.some((r) => r.source === 'demo')) return 'מחירי דמו — לא מחירים אמיתיים';
  if (all.every((r) => r.source === 'live')) return 'מחירים חיים מאתרי הרשתות';
  if (all.every((r) => r.source === 'branch_data')) return 'אתרי האונליין לא ענו — המחירים מקבצי השקיפות של הסניפים';
  return 'חלק מהמחירים משוערים';
}

const serializeBook = (b: PriceBook) => ({ byNeed: [...b.byNeed.entries()], failures: b.failures, sources: [...b.sources] });
export function lastBook(): PriceBook {
  const s = kvGet<{ byNeed: [string, ProductSearchResult[]][]; failures: PriceBook['failures']; sources: string[] }>('lastBook');
  return s ? { byNeed: new Map(s.byNeed), failures: s.failures, sources: new Set(s.sources) } : emptyPriceBook();
}

function requireBasket(): Basket {
  const b = store.basket();
  if (b && b.status === 'building') return b;
  const fresh: Basket = { id: uid('b_'), createdAt: nowIso(), horizonDays: 14, status: 'building', items: [], skipped: [], tempSkips: [], notes: [], priced: false };
  store.saveBasket(fresh);
  return fresh;
}

// ---------- basket edits (each emits a learning event) ----------

export async function addItem(opts: { needId?: string; newLabel?: string; quantity?: number; conditional?: 'good_price' }): Promise<{ item: BasketItem; basket: Basket }> {
  let needId = opts.needId;
  if (!needId && opts.newLabel) needId = customConceptFor(opts.newLabel).id;
  if (!needId) throw new Error('missing item');
  const need = ensureNeed(needId);
  const c = getConcept(needId);
  const basket = requireBasket();
  basket.tempSkips = basket.tempSkips.filter((x) => x !== needId);
  basket.skipped = basket.skipped.filter((x) => x.needId !== needId);
  let book = lastBook();
  if (!book.byNeed.has(needId)) {
    const providers = householdProviders(store.household());
    if (providers.length) {
      const scanned = await scanPrices([needId], providers);
      book = referenceBook(scanned, store.household());
    }
  }
  const choice = chooseProduct(c, need, book.byNeed.get(needId) ?? []);
  const existing = basket.items.find((i) => i.needId === needId);
  const qty = opts.quantity ?? existing?.quantity ?? Math.max(1, Math.ceil(need.typical14DayQty / c.packSize - 0.15));
  const item: BasketItem = existing ?? {
    needId, label: c.label, emoji: c.emoji, quantity: qty, unit: c.packLabel, status: 'need', reason: 'ביקשתם להוסיף', source: 'user_request', accepted: true,
  };
  item.quantity = qty;
  item.accepted = true;
  item.source = 'user_request';
  item.lockedByUser = false;
  if (choice) item.product = toResolved(choice.product);
  if (opts.conditional) {
    item.condition = evalCondition(need, choice?.product);
    item.reason = item.condition?.met ? `ביקשתם אם יש מחיר טוב — ${item.condition.note}` : `ביקשתם רק אם המחיר טוב — ${item.condition?.note}`;
  } else {
    item.condition = undefined;
  }
  if (!existing) basket.items.unshift(item);
  store.saveBasket(basket);
  logEvent({ type: 'accepted_product', needId, value: { quantity: qty, conditional: !!opts.conditional, product: item.product?.name } });
  return { item, basket };
}

export function removeItem(needId: string, temporary = true): Basket {
  const basket = requireBasket();
  const it = basket.items.find((i) => i.needId === needId);
  basket.items = basket.items.filter((i) => i.needId !== needId);
  if (!basket.tempSkips.includes(needId)) basket.tempSkips.push(needId);
  const c = getConcept(needId);
  basket.skipped = [...basket.skipped.filter((s) => s.needId !== needId), { needId, label: c.label, emoji: c.emoji, reason: 'ביקשתם לדלג הפעם' }];
  store.saveBasket(basket);
  if (it && it.status === 'discovery') {
    const n = ensureNeed(needId);
    n.dismissedDeals += 1;
    store.saveNeed(n);
    logEvent({ type: 'deal_dismissed', needId });
  } else learnFromRemoval(needId, temporary);
  return basket;
}

export function setQuantity(needId: string, quantity: number): Basket {
  const basket = requireBasket();
  const it = basket.items.find((i) => i.needId === needId);
  if (!it) throw new Error('not in basket');
  if (quantity <= 0) return removeItem(needId, true);
  it.quantity = quantity;
  if (it.status !== 'discovery') learnFromQuantity(needId, quantity, basket.horizonDays);
  store.saveBasket(basket);
  return basket;
}

export function acceptItem(needId: string): Basket {
  const basket = requireBasket();
  const it = basket.items.find((i) => i.needId === needId);
  if (it) {
    it.accepted = true;
    if (it.status === 'discovery') updateNeed(needId, { dismissedDeals: 0 });
    logEvent({ type: it.status === 'discovery' ? 'deal_accepted' : 'accepted_product', needId, toProductId: it.product?.name });
  }
  store.saveBasket(basket);
  return basket;
}

export function lockItem(needId: string, locked: boolean): Basket {
  const basket = requireBasket();
  const it = basket.items.find((i) => i.needId === needId);
  if (it) it.lockedByUser = locked;
  store.saveBasket(basket);
  return basket;
}

/** Alternatives for "replace": other relevant products from the last scan, cheapest first. */
export function alternatives(needId: string): ProductSearchResult[] {
  const c = getConcept(needId);
  const n = ensureNeed(needId);
  const book = lastBook();
  const current = store.basket()?.items.find((i) => i.needId === needId)?.product;
  const seen = new Set<string>();
  return (book.byNeed.get(needId) ?? [])
    .filter((p) => relevant(c, { ...n, forbiddenBrands: [] }, p) && p.productId !== current?.productId)
    .sort((a, b) => fit(c, b) - fit(c, a) || cheaper(a, b))
    .filter((p) => (seen.has(p.name) ? false : (seen.add(p.name), true)))
    .slice(0, 6);
}

export function replaceItem(needId: string, productId?: string): { basket: Basket; replacements: number; product?: ProductSearchResult; inferred?: string } {
  const basket = requireBasket();
  const it = basket.items.find((i) => i.needId === needId);
  if (!it) throw new Error('not in basket');
  const alts = alternatives(needId);
  const next = productId ? alts.find((p) => p.productId === productId) : alts[0];
  if (!next) return { basket, replacements: 0 };
  const from = it.product?.name;
  const restoredUsual = !!it.usualProductName && next.name === it.usualProductName;
  it.product = toResolved(next);
  it.usualProductName = undefined;
  it.uncertain = false;
  it.lockedByUser = true;
  it.reason = `בחרתם ידנית: ${next.name}`;
  store.saveBasket(basket);
  const c = getConcept(needId);
  const brand = next.brand ?? c.brands.find((b) => next.name.includes(b));
  const { replacements, inferred } = learnFromReplacement(needId, from, next.name, brand, restoredUsual);
  return { basket, replacements, product: next, inferred };
}

export function setBudget(cap: number | null): Basket {
  const basket = requireBasket();
  basket.budgetCap = cap ?? undefined;
  store.saveBasket(basket);
  return basket;
}

// ---------- deals / prices ----------

export async function getDeals(): Promise<{ deals: Deal[]; failures: PriceBook['failures']; demo: boolean; providers: Record<string, string> }> {
  let book = lastBook();
  let failures = book.failures;
  if (!book.byNeed.size) {
    const r = await scanForBasket();
    book = r.book;
    failures = r.failures;
    kvSet('lastBook', serializeBook(book));
  }
  const dismissed = new Set(kvGet<string[]>('dismissedDealIds') ?? []);
  const deals = householdDeals(book).filter((d) => !dismissed.has(d.id));
  const all = [...book.byNeed.values()].flat();
  const names = Object.fromEntries(householdProviders(store.household(), { physical: true }).map((p) => [p.id, p.name]));
  return { deals, failures, demo: all.some((r) => r.source === 'demo'), providers: names };
}

export function dismissDeal(dealId: string, needId: string) {
  const ids = kvGet<string[]>('dismissedDealIds') ?? [];
  kvSet('dismissedDealIds', [...ids, dealId].slice(-200));
  const n = ensureNeed(needId);
  n.dismissedDeals += 1;
  if (n.dismissedDeals >= 2 && n.dealSensitivity !== 'low') n.dealSensitivity = n.dealSensitivity === 'high' ? 'medium' : 'low';
  store.saveNeed(n);
  logEvent({ type: 'deal_dismissed', needId, value: dealId });
}

export async function priceLookup(needId: string) {
  const h = store.household();
  const c = getConcept(needId);
  const need = ensureNeed(needId);
  const providers = householdProviders(h, { physical: true });
  const book = await scanPrices([needId], providers);
  const rows: { provider: string; name: string; price: number; promoText?: string; source: ProductSearchResult['source'] }[] = [];
  for (const p of providers) {
    const cands = (book.perProvider.get(p.id)?.get(needId) ?? []).filter((x) => relevant(c, need, x)).sort(cheaper);
    if (cands[0]) rows.push({ provider: p.name, name: cands[0].name, price: effPrice(cands[0]), promoText: cands[0].promoText, source: cands[0].source });
  }
  rows.sort((a, b) => a.price - b.price);
  return { rows, failures: book.failures.map((f) => f.name), concept: c };
}

export async function discoveryList(): Promise<Deal[]> {
  return discoveryDeals(lastBook(), store.basket()?.items.map((i) => i.needId) ?? []);
}

// ---------- purchase ----------

export type ConfirmInput = { storeName: string; providerId?: string; total?: number; viaCart?: boolean; items: { needId: string; quantity: number; productName?: string; price?: number }[] };

export function confirmPurchase(input: ConfirmInput): Purchase {
  const basket = store.basket();
  const items: Purchase['items'] = [];
  for (const row of input.items.filter((r) => r.quantity > 0)) {
    const c = getConcept(row.needId);
    const n = ensureNeed(row.needId);
    const bi = basket?.items.find((i) => i.needId === row.needId);
    const units = row.quantity * c.packSize;
    const est = estimateStock(n);
    n.currentStockEstimate = round1(est.qty + units);
    n.stockAsOf = nowIso();
    n.stockConfidence = Math.max(0.75, est.confidence);
    n.lastPurchasedAt = nowIso();
    n.lastPurchasedQty = units;
    if (row.productName) n.lastProductName = row.productName;
    if (!n.active && bi?.status !== 'discovery') n.active = true; // bought it → it's part of the household now
    if (bi?.status === 'discovery') { n.active = false; }
    // Bought a different amount than suggested → learn
    if (bi && bi.quantity !== row.quantity && bi.status !== 'discovery') learnFromQuantity(row.needId, row.quantity, basket?.horizonDays ?? 14);
    store.saveNeed(n);
    items.push({ needId: row.needId, label: c.label, emoji: c.emoji, quantity: row.quantity, unit: c.packLabel, productName: row.productName, price: row.price, status: bi?.status ?? 'need' });
  }
  // Items we suggested but they chose not to buy count as a soft removal — but not when it wasn't their choice:
  // an unmet "only if cheap" condition, or an item the store didn't have / we couldn't match safely.
  const job = input.viaCart ? currentCartJob() : null;
  const notTheirChoice = new Set(job?.lines.filter((l) => l.state !== 'added').map((l) => l.needId) ?? []);
  for (const bi of basket?.items ?? []) {
    if (!bi.accepted || bi.status === 'discovery' || bi.condition?.met === false || bi.uncertain || notTheirChoice.has(bi.needId)) continue;
    if (!input.items.some((r) => r.needId === bi.needId && r.quantity > 0)) learnFromRemoval(bi.needId, false);
  }
  const purchase: Purchase = {
    id: uid('p_'), createdAt: nowIso(), storeName: input.storeName, providerId: input.providerId,
    total: input.total ?? round1(items.reduce((s, i) => s + (i.price ?? 0) * i.quantity, 0)),
    items, dealsUsed: items.filter((i) => i.status === 'opportunity').length,
    substitutions: basket?.items.filter((i) => i.usualProductName || i.substitutedFrom).length ?? 0,
    removed: (basket?.items ?? []).filter((bi) => bi.accepted && bi.condition?.met !== false && !items.some((x) => x.needId === bi.needId)).map((bi) => ({ needId: bi.needId, label: bi.label })),
    stockUps: items.filter((i) => i.status === 'opportunity').map((i) => i.label),
    viaCart: input.viaCart || undefined,
  };
  store.savePurchase(purchase);
  logEvent({ type: 'purchase_confirmed', value: { purchaseId: purchase.id, items: items.length, total: purchase.total } });
  if (basket) { basket.status = 'purchased'; store.saveBasket(basket); }
  store.saveComparison(null);
  kvSet('lastBook', null);
  kvSet('cartJob', null);
  void import('./cart/prepare.ts').then((m) => m.clearJob());
  return purchase;
}

export function basketSummary(b: Basket) {
  return {
    items: b.items.filter((i) => i.accepted && i.condition?.met !== false).length,
    total: b.priced ? Math.round(basketTotal(b)) : undefined,
    deals: b.items.filter((i) => i.status === 'opportunity').length,
    substitutions: b.items.filter((i) => i.usualProductName).length,
    discoveries: b.items.filter((i) => i.status === 'discovery' && !i.accepted).length,
  };
}

// ---------- cart handoff ----------

/** Fingerprint of what's actually being bought, to know whether a stored comparison still applies. */
export function basketKey(b: Basket): string {
  return b.items.filter((i) => i.accepted && i.condition?.met !== false).map((i) => `${i.needId}:${i.quantity}:${i.lockedByUser ? i.product?.productId : ''}`).sort().join('|');
}

export async function prepareProviderCart(providerId?: string) {
  const { quoteOne } = await import('./engine/compare.ts');
  const { startCartJob } = await import('./cart/prepare.ts');
  const b = store.basket();
  if (!b || b.status !== 'building' || !b.items.length) throw new Error('אין סל פעיל להכין ממנו עגלה');
  const cmp = store.comparison();
  const fresh = cmp && cmp.basketKey === basketKey(b);
  const onlineOk = (cmp?.quotes ?? []).filter((q) => q.ok && q.kind === 'online');
  const pid = providerId ?? (cmp?.recommendation.kind === 'online' ? cmp.recommendation.winnerId : onlineOk[0]?.providerId);
  if (!pid) throw new Error('לא נבחרה רשת. השוו רשתות קודם.');
  let quote = fresh ? onlineOk.find((q) => q.providerId === pid) : undefined;
  if (!quote) {
    const p = householdProviders(store.household()).find((x) => x.id === pid);
    if (!p) throw new Error('הרשת הזאת לא ברשימת הרשתות שלכם');
    quote = await quoteOne(p, b);
    if (!quote.ok) throw new Error(`לא הצלחתי לתמחר את הסל ב${p.name}: ${quote.error ?? ''}`);
  }
  logEvent({ type: 'accepted_product', value: { cartPreparedAt: pid } });
  return startCartJob({ quote });
}
