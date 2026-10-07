// Deals for this household, from every chain's prices (not one reference chain), in four honest sections.
// Nothing is padded: a section is empty unless something really qualifies, and the screen says why.
import type { Deal, HouseholdNeed, ProductSearchResult } from '../../shared/types.ts';
import type { Concept } from '../catalog.ts';
import { store } from '../db.ts';
import { daysBetween, now } from '../clock.ts';
import { allConcepts, dealSensitivityFor, estimateStock, getConcept } from '../state.ts';
import { effPrice, headMatch, parseSize, relevant } from './match.ts';
import { identityGaps } from '../../shared/product.ts';

export type FullBook = { perProvider: Map<string, Map<string, ProductSearchResult[]>> };
export type DealsResult = { deals: Deal[]; checkedNeeds: number; providers: number; note?: string };

const CAP_PER_SECTION = 8;
const CAP_TOTAL = 20;
const ceilPacks = (units: number, packSize: number) => Math.max(1, Math.ceil(units / packSize - 0.15));

/** Price per 100 g/ml (or per kg when sold by weight) — only for comparing like with like. */
export function unitPrice(p: ProductSearchResult): { v: number; per: '100g' | '100ml' | 'kg'; text: string } | null {
  if (p.byWeight) return { v: effPrice(p), per: 'kg', text: `₪${effPrice(p)} לק״ג` };
  const size = parseSize(`${p.name} ${p.sizeText ?? ''}`);
  if (!size || size.amount <= 0) return null;
  const v = Math.round((effPrice(p) / size.amount) * 100 * 100) / 100;
  return { v, per: size.unit === 'g' ? '100g' : '100ml', text: `₪${v} ל־100 ${size.unit === 'g' ? 'גרם' : 'מ״ל'}` };
}

const median = (xs: number[]) => { const v = [...xs].sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : 0; };

type Scored = { p: ProductSearchResult; vsShelf: number; vsHistory: number; vsMarket: number; disc: number; basis: string };

/** How good this price is: vs its own shelf price, vs what we saw for it in 60 days, vs the same need at other chains. */
function score(p: ProductSearchResult, marketUnit: Map<string, number>): Scored {
  const eff = effPrice(p);
  const vsShelf = p.promoPrice && p.price > 0 ? Math.max(0, 1 - p.promoPrice / p.price) : 0;
  const since = new Date(now().getTime() - 60 * 86400000).toISOString();
  const normal = store.normalPrice(p.providerId, p.productId, since);
  const vsHistory = normal && normal > eff ? 1 - eff / normal : 0;
  const u = unitPrice(p);
  const m = u ? marketUnit.get(u.per) : undefined;
  const vsMarket = u && m && m > u.v ? 1 - u.v / m : 0;
  const disc = Math.max(vsShelf, vsHistory, vsMarket);
  const basis = disc === vsShelf && vsShelf > 0 ? 'מהמחיר הרגיל שלו' : disc === vsHistory && vsHistory > 0 ? 'ממה שראיתי בחודשיים האחרונים' : 'מהמחיר הרגיל ברשתות';
  return { p, vsShelf, vsHistory, vsMarket, disc, basis };
}

/** Products that are clearly this need, at any chain, honouring a strict household. */
function candidates(c: Concept, n: HouseholdNeed | null, book: FullBook): ProductSearchResult[] {
  const out: ProductSearchResult[] = [];
  for (const byNeed of book.perProvider.values()) {
    for (const p of byNeed.get(c.id) ?? []) {
      if (!relevant(c, n, p) || !headMatch(c, p) || identityGaps(p).ambiguous) continue;
      if (n?.flexibility === 'exact_product') {
        const usual = n.lastProductName && p.name.replace(/\s+/g, ' ').trim() === n.lastProductName.replace(/\s+/g, ' ').trim();
        const brand = n.preferredBrands.some((b) => `${p.name} ${p.brand ?? ''}`.includes(b));
        if (!usual && !brand) continue;
      }
      out.push(p);
    }
  }
  return out;
}

export function dealSections(book: FullBook, providerNames: Record<string, string>): DealsResult {
  const needs = store.needs();
  const byId = new Map(needs.map((n) => [n.id, n]));
  const recent = (n?: HouseholdNeed) => !!n?.lastPurchasedAt && daysBetween(n.lastPurchasedAt) <= 60;
  const scanned = new Set<string>();
  for (const m of book.perProvider.values()) for (const id of m.keys()) scanned.add(id);
  const openCats = new Set(needs.filter((n) => n.active && (n.flexibility === 'exploratory' || n.flexibility === 'category_flexible')).map((n) => getConcept(n.id).category));
  const used = new Set<string>(); // each need appears once
  const sections: Record<Deal['kind'], Deal[]> = { now: [], stock: [], anyway: [], discovery: [] };

  const make = (kind: Deal['kind'], c: Concept, n: HouseholdNeed | null, s: Scored, why: string, qty: number): Deal => {
    const u = unitPrice(s.p);
    const reg = s.p.promoPrice ? s.p.price : undefined;
    return {
      id: `${c.id}:${s.p.providerId}:${s.p.productId}`, kind, needId: c.id, label: c.label, emoji: c.emoji, product: s.p,
      discountPct: Math.round(s.disc * 100), why, suggestQty: qty, unit: c.packLabel,
      providerName: providerNames[s.p.providerId] ?? s.p.providerId, unitPriceText: s.p.unitPriceText ?? u?.text,
      regularPrice: reg, savingNis: reg ? Math.round((reg - effPrice(s.p)) * qty * 10) / 10 : undefined, promoEndsAt: s.p.promoEndsAt,
    };
  };

  const ranked: { kind: Deal['kind']; deal: Deal; weight: number }[] = [];
  for (const c of allConcepts()) {
    if (!scanned.has(c.id)) continue;
    const n = byId.get(c.id) ?? null;
    if (n?.neverSuggest) continue;
    const cands = candidates(c, n, book);
    if (!cands.length) continue;
    const units = cands.map((p) => unitPrice(p)).filter((x): x is NonNullable<typeof x> => !!x);
    const marketUnit = new Map<string, number>();
    for (const per of ['100g', '100ml', 'kg'] as const) {
      const xs = units.filter((x) => x.per === per).map((x) => x.v);
      if (xs.length >= 3) marketUnit.set(per, median(xs));
    }
    const scored = cands.map((p) => score(p, marketUnit)).sort((a, b) => b.disc - a.disc || effPrice(a.p) - effPrice(b.p));
    const best = scored[0];
    const household = !!n && (n.active || recent(n));
    const sens = n ? dealSensitivityFor(n.dealSensitivity) + Math.min(2, n.dismissedDeals) * 0.05 : 0.25;
    const per14 = n ? ceilPacks(n.typical14DayQty, c.packSize) : 1;
    const minQty = (q: number) => (best.p.promoMinQty && q < best.p.promoMinQty ? best.p.promoMinQty : q);

    if (household && n) {
      const est = estimateStock(n);
      const dueSoon = !est.known || est.qty < n.typical14DayQty;
      if (c.shelfStable && n.wasteRisk === 'low' && best.disc >= Math.max(sens, 0.15) && Math.max(best.vsShelf, best.vsHistory, best.vsMarket) >= 0.15) {
        ranked.push({ kind: 'stock', weight: 0.9, deal: make('stock', c, n, best, `נשמר לאורך זמן ואתם קונים את זה קבוע — ‎−${Math.round(best.disc * 100)}% ${best.basis}`, minQty(Math.min(per14 * 2, Math.max(2, per14)))) });
        continue;
      }
      if (dueSoon && best.disc >= Math.max(0.1, sens - 0.05)) {
        ranked.push({ kind: 'now', weight: 1, deal: make('now', c, n, best, `צריך בקרוב${est.known ? ` (נשאר ~${Math.round(est.qty)} ${c.stockUnit})` : ''}, והמחיר עכשיו ‎−${Math.round(best.disc * 100)}% ${best.basis}`, minQty(per14)) });
        continue;
      }
      // Bought anyway, and the best chain is clearly below the usual price for it right now (not necessarily a promo).
      const cheapNow = scored.find((s) => s.vsMarket >= 0.08 || s.vsHistory >= 0.08);
      if (n.active && cheapNow) {
        ranked.push({ kind: 'anyway', weight: 0.8, deal: make('anyway', c, n, cheapNow, `אתם קונים את זה בכל מקרה — כרגע זול ב־${Math.round(Math.max(cheapNow.vsMarket, cheapNow.vsHistory) * 100)}% ${cheapNow.vsHistory > cheapNow.vsMarket ? 'ממה שראיתי בחודשיים האחרונים' : 'מהמחיר הרגיל ברשתות'}`, minQty(per14)) });
      }
      continue;
    }
    // Discovery: not part of the household yet, a category they're open to, a really strong price.
    if (n && n.dismissedDeals >= 2) continue;
    const openToIt = openCats.has(c.category) || c.category === 'cleaning' || c.category === 'produce';
    if (openToIt && best.disc >= 0.25) {
      ranked.push({ kind: 'discovery', weight: 0.5, deal: make('discovery', c, n, best, discoveryWhy(c, openCats.has(c.category)), minQty(1)) });
    }
  }

  const value = (d: Deal) => (d.savingNis ?? (d.discountPct / 100) * effPrice(d.product) * d.suggestQty);
  ranked.sort((a, b) => b.weight * value(b.deal) - a.weight * value(a.deal) || b.deal.discountPct - a.deal.discountPct);
  const discoveryCats = new Set<string>();
  const dismissed = new Set(store.dismissedDeals());
  let total = 0;
  for (const r of ranked) {
    if (used.has(r.deal.needId) || dismissed.has(r.deal.id) || total >= CAP_TOTAL) continue;
    const cap = r.kind === 'discovery' ? (needs.some((n) => n.flexibility === 'exploratory') ? 6 : 4) : CAP_PER_SECTION;
    if (sections[r.kind].length >= cap) continue;
    if (r.kind === 'discovery') {
      const cat = getConcept(r.deal.needId).category;
      if (discoveryCats.has(cat)) continue;
      discoveryCats.add(cat);
    }
    sections[r.kind].push(r.deal);
    used.add(r.deal.needId);
    total++;
  }
  const deals = [...sections.now, ...sections.stock, ...sections.anyway, ...sections.discovery];
  const checkedNeeds = [...scanned].filter((id) => byId.get(id)?.active).length;
  const note = deals.length === 0
    ? `בדקתי ${checkedNeeds} מוצרים שאתם קונים ב־${book.perProvider.size} רשתות — אין כרגע מחיר שבאמת שווה משהו. לא אמציא מבצעים.`
    : deals.length < 4 ? `בדקתי ${checkedNeeds} מוצרים שאתם קונים ב־${book.perProvider.size} רשתות. רק ${deals.length === 1 ? 'אחד שווה' : `${deals.length} שווים`} משהו כרגע — בשאר המחיר רגיל.` : undefined;
  return { deals, checkedNeeds, providers: book.perProvider.size, note };
}

function discoveryWhy(c: Concept, open: boolean) {
  if (c.category === 'produce') return 'פרי/ירק עונתי במחיר טוב — לא חייבים הרבה';
  if (c.category === 'cleaning') return 'מוצר ניקיון שנשמר לאורך זמן, במחיר שווה לסטוק';
  if (c.meat) return 'נתח במחיר נמוך במיוחד, ואתם פתוחים לגיוון בבשר';
  return open ? 'אתם פתוחים לגיוון בקטגוריה הזאת' : 'מחיר חריג לטובה';
}
