// Deterministic basket engine: NEED / OPPORTUNITY / DISCOVERY.
import type { Basket, BasketItem, CheckInQuestion, Deal, HouseholdNeed, ProductSearchResult, SkippedItem } from '../../shared/types.ts';
import type { Concept } from '../catalog.ts';
import { round1 } from '../catalog.ts';
import { store } from '../db.ts';
import { daysBetween, now, nowIso, uid } from '../clock.ts';
import { allConcepts, dealSensitivityFor, estimateStock, getConcept } from '../state.ts';
import { brandOf, chooseProduct, effPrice, headMatch, relevant } from './match.ts';

export type PriceBook = {
  byNeed: Map<string, ProductSearchResult[]>;
  failures: { providerId: string; name: string; error: string }[];
  sources: Set<string>;
};
export const emptyPriceBook = (): PriceBook => ({ byNeed: new Map(), failures: [], sources: new Set() });

const ceilPacks = (units: number, packSize: number) => Math.max(1, Math.ceil(units / packSize - 0.15));

/** Discount of a product vs. its regular price and vs. what we've normally seen for this need. */
export function discountOf(_needId: string, p: ProductSearchResult): number {
  const eff = effPrice(p);
  const vsShelf = p.promoPrice ? 1 - p.promoPrice / p.price : 0;
  const since = new Date(now().getTime() - 60 * 86400000).toISOString();
  const normal = store.normalPrice(p.providerId, p.productId, since);
  const vsHistory = normal && normal > eff ? 1 - eff / normal : 0;
  return Math.max(vsShelf, vsHistory);
}

export type CheckIn = { questions: CheckInQuestion[] };

/** Up to 3 questions about needs where stock is uncertain AND it matters (expensive / perishable / ambiguous). */
export function checkInQuestions(horizonDays: number, tempSkips: string[] = []): CheckInQuestion[] {
  const out: { q: CheckInQuestion; score: number }[] = [];
  for (const n of store.needs()) {
    if (!n.active || tempSkips.includes(n.id)) continue;
    if (n.lastAskedAt && daysBetween(n.lastAskedAt) < 4) continue;
    const c = getConcept(n.id);
    const est = estimateStock(n);
    if (est.confidence >= 0.45) continue;
    const need = (n.typical14DayQty / 14) * horizonDays;
    const ambiguity = est.known ? Math.min(est.qty, need) / Math.max(need, 0.01) : 0.6;
    const importance = (c.meat || c.category === 'fish' ? 2 : 0) + (n.wasteRisk === 'high' ? 1 : 0) + (c.shelfStable ? 0 : 0.5);
    const score = importance + ambiguity;
    if (score < 1.2) continue;
    const text = c.meat || c.category === 'fish'
      ? `נשאר ${c.label} במקפיא?`
      : est.known && est.qty < need * 0.3
        ? `אני חושב ש${c.label} כמעט נגמר. נכון?`
        : `כמה ${c.label} נשאר בבית?`;
    out.push({
      score,
      q: {
        id: 'q_' + n.id, needId: n.id, text,
        options: [
          { label: 'הרבה', value: 'lots' }, { label: 'קצת', value: 'little' },
          { label: 'כמעט כלום', value: 'none' }, { label: 'לא יודע', value: 'unknown' },
        ],
      },
    });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 3).map((x) => x.q);
}

export type GenerateOpts = { horizonDays: number; prices: PriceBook; previous?: Basket | null; budgetCap?: number };

export function generateBasket({ horizonDays, prices, previous, budgetCap }: GenerateOpts): Basket {
  const household = store.household();
  const tempSkips = previous?.status === 'building' ? previous.tempSkips : [];
  const keep = (previous?.status === 'building' ? previous.items : []).filter((i) => i.lockedByUser || i.source === 'user_request' || (i.status === 'discovery' && i.accepted));
  const items: BasketItem[] = [];
  const skipped: SkippedItem[] = [];
  const notes: string[] = [];
  const priced = prices.byNeed.size > 0;

  for (const n of store.needs()) {
    if (!n.active || n.neverSuggest) continue;
    const c = getConcept(n.id);
    if (keep.some((k) => k.needId === n.id)) continue;
    if (tempSkips.includes(n.id)) { skipped.push(sk(n, 'ביקשתם לדלג הפעם')); continue; }

    const est = estimateStock(n);
    const rate = n.typical14DayQty / 14;
    const buffer = c.shelfStable ? rate * 3 : rate * 1;
    const required = rate * horizonDays + buffer;
    const deficit = required - est.qty;
    const choice = priced ? chooseProduct(c, n, prices.byNeed.get(n.id) ?? []) : null;
    const sure = choice && !choice.uncertain ? choice : null; // never chase a "deal" on a doubtful match
    const disc = sure ? discountOf(n.id, sure.product) : 0;
    const strongDeal = sure && disc >= dealSensitivityFor(n.dealSensitivity);

    if (deficit > c.packSize * 0.25) {
      let qty = ceilPacks(deficit, c.packSize);
      let status: BasketItem['status'] = 'need';
      let reason = est.known && est.qty < rate * 2
        ? (est.qty <= 0.01 ? 'נגמר בבית' : `נשאר ~${fmt(est.qty)} ${c.stockUnit}, ייגמר לפני הקנייה הבאה`)
        : !est.known ? `אתם צורכים ~${fmt(n.typical14DayQty)} ${c.stockUnit} לשבועיים` : 'צפוי להיגמר עד הקנייה הבאה';
      let source: BasketItem['source'] = 'stock_gap';
      if (strongDeal && c.shelfStable && n.wasteRisk === 'low') {
        const extra = Math.max(1, Math.round(ceilPacks(n.typical14DayQty, c.packSize) * 0.5));
        qty += extra;
        status = 'opportunity';
        source = 'promotion';
        reason += ` + מחיר טוב לסטוק (‎−${pct(disc)})`;
      } else if (strongDeal) {
        reason += ` · במבצע (‎−${pct(disc)})`;
      }
      items.push(item(n, c, qty, status, reason, source, choice));
    } else if (strongDeal && c.shelfStable && n.wasteRisk === 'low' && est.qty < n.typical14DayQty * 1.1 && !recentlyReportedPlenty(n)) {
      const qty = ceilPacks(Math.max(n.typical14DayQty * 0.75, c.packSize), c.packSize);
      items.push(item(n, c, qty, 'opportunity', `יש עוד בבית, אבל ‎−${pct(disc)} — שווה להצטייד`, 'promotion', choice));
    } else {
      const reason = n.lastPurchasedAt && daysBetween(n.lastPurchasedAt) < 10 ? 'קניתם לאחרונה'
        : est.known ? `לפי ההערכה נשאר מספיק (~${fmt(est.qty)} ${c.stockUnit})` : 'כנראה יש מספיק';
      skipped.push(sk(n, reason));
    }
  }

  // Preserve things the user explicitly asked for or locked; re-resolve their price.
  for (const k of keep) {
    const n = store.need(k.needId);
    const c = getConcept(k.needId);
    if (n && priced && !k.lockedByUser) {
      const choice = chooseProduct(c, n, prices.byNeed.get(n.id) ?? []);
      if (choice) k.product = toResolved(choice.product);
      if (k.condition) k.condition = evalCondition(n, choice?.product);
    }
    items.unshift(k);
  }

  // Discovery: restrained, suggestions only.
  if (priced) {
    for (const d of discoveryDeals(prices, items.map((i) => i.needId)).slice(0, household?.flexibilityStyle === 'adventurous' ? 3 : 2)) {
      items.push({
        needId: d.needId, label: d.label, emoji: d.emoji, quantity: d.suggestQty, unit: d.unit, status: 'discovery',
        reason: d.why, source: 'discovery', accepted: false, product: toResolved(d.product),
      });
    }
  }

  const basket: Basket = {
    id: previous?.status === 'building' ? previous.id : uid('b_'),
    createdAt: nowIso(), horizonDays, status: 'building', items, skipped, tempSkips,
    budgetCap: budgetCap ?? (previous?.status === 'building' ? previous.budgetCap : undefined),
    notes, priced,
  };
  applyBudget(basket);
  if (!priced) basket.priceSourceNote = 'אין כרגע מחירים — הסל מבוסס על צריכה ומלאי בלבד';
  return basket;
}

export function basketTotal(b: Basket): number {
  return round1(b.items.filter((i) => i.accepted && i.condition?.met !== false).reduce((s, i) => s + (i.product ? i.product.price * i.quantity : 0), 0));
}

function applyBudget(b: Basket) {
  if (!b.budgetCap || !b.priced) return;
  let total = basketTotal(b);
  if (total <= b.budgetCap) return;
  // Trim stock-ups first, then drop pure opportunities.
  for (const i of b.items.filter((x) => x.status === 'opportunity' && !x.lockedByUser)) {
    if (total <= b.budgetCap) break;
    const c = getConcept(i.needId);
    const n = store.need(i.needId);
    const base = n ? ceilPacks(Math.max(0, (n.typical14DayQty / 14) * b.horizonDays - estimateStock(n).qty), c.packSize) : 1;
    const target = i.source === 'promotion' && i.reason.startsWith('יש עוד') ? 0 : base;
    const saved = (i.quantity - target) * (i.product?.price ?? 0);
    if (target === 0) {
      b.items = b.items.filter((x) => x !== i);
      b.skipped.push({ needId: i.needId, label: i.label, emoji: i.emoji, reason: `ויתרתי על הסטוק בגלל התקרה של ₪${b.budgetCap}` });
    } else {
      i.quantity = target;
      i.status = 'need';
      i.reason += ` (בלי סטוק — תקרה ₪${b.budgetCap})`;
    }
    total -= saved;
  }
  total = basketTotal(b);
  if (total > b.budgetCap) b.notes.push(`הסל עדיין ~₪${Math.round(total)}, מעל התקרה של ₪${b.budgetCap}. אפשר להוריד משהו?`);
  else b.notes.push(`שמרתי על התקרה של ₪${b.budgetCap}`);
}

export function evalCondition(n: HouseholdNeed, p?: ProductSearchResult): BasketItem['condition'] {
  if (!p) return { kind: 'good_price', met: null, note: 'אין עדיין מחיר לבדוק' };
  const d = discountOf(n.id, p);
  const met = d >= 0.12;
  return { kind: 'good_price', met, note: met ? `יש מבצע: ‎−${pct(d)}` : `המחיר כרגע רגיל (₪${effPrice(p)}), לא הכנסתי` };
}

/** Deals relevant to this household. Shared by the basket engine and the Deals screen. */
export function householdDeals(prices: PriceBook): Deal[] {
  const out: Deal[] = [];
  for (const n of store.needs()) {
    if (!n.active || n.neverSuggest || n.dismissedDeals >= 3) continue;
    const c = getConcept(n.id);
    const choice = chooseProduct(c, n, prices.byNeed.get(n.id) ?? []);
    if (!choice || choice.uncertain) continue;
    const disc = discountOf(n.id, choice.product);
    if (disc < dealSensitivityFor(n.dealSensitivity) - (n.dismissedDeals > 0 ? -0.1 : 0)) continue;
    const stock = c.shelfStable && n.wasteRisk === 'low';
    out.push({
      id: `${n.id}:${choice.product.productId}`, kind: stock ? 'stock' : 'now', needId: n.id, label: c.label, emoji: c.emoji,
      product: choice.product, discountPct: Math.round(disc * 100),
      why: stock ? 'נשמר לאורך זמן ואתם קונים את זה קבוע' : 'אתם קונים את זה, והמחיר עכשיו טוב',
      suggestQty: stock ? Math.max(2, ceilPacks(n.typical14DayQty, c.packSize)) : ceilPacks(n.typical14DayQty, c.packSize),
      unit: c.packLabel,
    });
  }
  return [...out.sort((a, b) => b.discountPct - a.discountPct), ...discoveryDeals(prices, [])];
}

/** New things worth a look: strong discount, category the household is open to, never auto-added. */
export function discoveryDeals(prices: PriceBook, exclude: string[]): Deal[] {
  const needs = store.needs();
  const openCats = new Set(needs.filter((n) => n.active && (n.flexibility === 'exploratory' || n.flexibility === 'category_flexible')).map((n) => getConcept(n.id).category));
  const out: Deal[] = [];
  for (const c of allConcepts()) {
    const n = needs.find((x) => x.id === c.id) ?? null;
    if (n && (n.active || n.neverSuggest || n.dismissedDeals >= 2)) continue;
    if (exclude.includes(c.id)) continue;
    const openToIt = openCats.has(c.category) || c.category === 'cleaning' || c.category === 'produce';
    if (!openToIt) continue;
    const cands = (prices.byNeed.get(c.id) ?? []).filter((p) => relevant(c, n, p) && headMatch(c, p)).sort((a, b) => discountOf(c.id, b) - discountOf(c.id, a));
    const p = cands[0];
    if (!p) continue;
    const disc = discountOf(c.id, p);
    if (disc < 0.25) continue;
    out.push({
      id: `${c.id}:${p.productId}`, kind: 'discovery', needId: c.id, label: c.label, emoji: c.emoji, product: p,
      discountPct: Math.round(disc * 100), why: discoveryWhy(c, openCats.has(c.category)), suggestQty: 1, unit: c.packLabel,
    });
  }
  return out.sort((a, b) => b.discountPct - a.discountPct).slice(0, 3);
}

function discoveryWhy(c: Concept, open: boolean) {
  if (c.category === 'produce') return 'פרי/ירק עונתי במחיר טוב — לא חייבים הרבה';
  if (c.category === 'cleaning') return 'מוצר ניקיון שנשמר לאורך זמן, במחיר שווה לסטוק';
  if (c.meat) return 'נתח במחיר נמוך במיוחד, ואתם פתוחים לגיוון בבשר';
  return open ? 'אתם פתוחים לגיוון בקטגוריה הזאת' : 'מחיר חריג לטובה';
}

function item(n: HouseholdNeed, c: Concept, qty: number, status: BasketItem['status'], reason: string, source: BasketItem['source'], choice: ReturnType<typeof chooseProduct>): BasketItem {
  const it: BasketItem = { needId: n.id, label: c.label, emoji: c.emoji, quantity: qty, unit: c.packLabel, status, reason, source, accepted: true };
  if (choice) {
    it.product = toResolved(choice.product);
    if (choice.substituted && choice.usualName) {
      it.usualProductName = choice.usualName;
      it.reason += ` · החלפתי מ־${choice.usualName}${choice.note ? ` (${choice.note})` : ''}`;
    }
    if (c.brands.length && !brandOf(choice.product, c) && n.flexibility === 'exact_product') it.reason += ' · לא בטוח שזה המותג';
    if (choice.uncertain) { it.uncertain = true; it.reason += ' · לא בטוח שזה המוצר הנכון — בחרו מוצר'; }
  }
  return it;
}

export function toResolved(p: ProductSearchResult) {
  return {
    providerId: p.providerId, productId: p.productId, name: p.name, brand: p.brand, price: effPrice(p), regularPrice: p.price,
    unitPriceText: p.unitPriceText, promoText: p.promoText, live: p.source === 'live',
  };
}

/** They just told us there's lots — don't push more of it even if it's on sale. */
function recentlyReportedPlenty(n: HouseholdNeed) {
  return !!n.stockAsOf && daysBetween(n.stockAsOf) < 5 && (n.currentStockEstimate ?? 0) >= n.typical14DayQty;
}

const sk = (n: HouseholdNeed, reason: string): SkippedItem => ({ needId: n.id, label: n.label, emoji: n.emoji, reason });
const pct = (d: number) => `${Math.round(d * 100)}%`;
export const fmt = (x: number) => (x >= 10 ? Math.round(x).toString() : (Math.round(x * 10) / 10).toString());

/** Plain-language explanation of why an item is (or isn't) in the basket. Uses real state only. */
export function explainItem(needId: string, basket: Basket | null): string {
  const n = store.need(needId);
  const c = getConcept(needId);
  if (!n) return `אין לי עדיין מידע על ${c.label}.`;
  const est = estimateStock(n);
  const rate = n.typical14DayQty / 14;
  const horizon = basket?.horizonDays ?? 14;
  const lines: string[] = [];
  const it = basket?.items.find((i) => i.needId === needId);
  const skippedIt = basket?.skipped.find((s) => s.needId === needId);
  lines.push(`${c.emoji} ${c.label}: אתם צורכים בערך ${fmt(n.typical14DayQty)} ${c.stockUnit} לשבועיים${n.qtySource === 'learned' ? ' (למדתי מהקניות שלכם)' : n.qtySource === 'default' ? ' (הערכה ראשונית לפי גודל הבית)' : ''}.`);
  lines.push(est.known
    ? `לפי ההערכה נשארו ~${fmt(est.qty)} ${c.stockUnit} (ביטחון ${est.confidence > 0.6 ? 'גבוה' : est.confidence > 0.3 ? 'בינוני' : 'נמוך'}).`
    : 'אין לי מידע על המלאי בבית, אז הנחתי שנשאר מעט.');
  if (it) {
    const units = it.quantity * c.packSize;
    lines.push(`ל־${horizon} ימים צריך ~${fmt(rate * horizon)} ${c.stockUnit}, אז הכנסתי ${it.quantity} × ${it.unit}${c.packSize !== 1 ? ` (${fmt(units)} ${c.stockUnit})` : ''}.`);
    if (it.condition) lines.push(it.condition.met ? `ביקשתם רק אם המחיר טוב — ${it.condition.note}.` : `ביקשתם רק אם המחיר טוב, ולכן הוא לא נספר בסל כרגע: ${it.condition.note}.`);
    if (it.status === 'opportunity') lines.push('הוספתי מעבר לצורך כי יש מחיר טוב ומדובר במוצר שנשמר.');
    if (it.status === 'discovery') lines.push('זו רק הצעה — לא אכניס בלי אישור.');
    if (it.product) lines.push(`בחרתי ב: ${it.product.name} — ₪${it.product.price}${it.product.promoText ? ` (${it.product.promoText})` : ''}.`);
    if (it.usualProductName) lines.push(`זו החלפה של ${it.usualProductName}, כי אתם גמישים במותג ויצא משתלם יותר.`);
  } else if (skippedIt) {
    lines.push(`לא הכנסתי: ${skippedIt.reason}.`);
  }
  lines.push(flexText(n));
  return lines.join('\n');
}

export function flexText(n: HouseholdNeed): string {
  switch (n.flexibility) {
    case 'exact_product': return n.preferredBrands.length ? `אצלכם זה רק ${n.preferredBrands.join('/')} — לא מחליף.` : 'אצלכם זה מוצר קבוע — לא מחליף.';
    case 'brand_flexible': return n.preferredBrands.length ? `מעדיפים ${n.preferredBrands.join('/')}, אבל אחליף אם משהו אחר זול משמעותית.` : 'יש מותג מועדף, אבל אפשר להחליף כשמשתלם.';
    case 'category_flexible': return 'המותג לא חשוב לכם — אני הולך לפי מחיר.';
    case 'exploratory': return 'אתם פתוחים לגיוון — מדי פעם אציע משהו חדש.';
  }
}
