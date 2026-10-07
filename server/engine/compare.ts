// One-store basket comparison across delivery chains and physical branches. Deterministic.
import type { Basket, BasketQuote, Comparison, QuoteLine } from '../../shared/types.ts';
import { store } from '../db.ts';
import { nowIso } from '../clock.ts';
import { ensureNeed, getConcept } from '../state.ts';
import { cachedSearch, householdProviders } from '../providers/index.ts';
import type { GroceryProvider } from '../providers/types.ts';
import { chooseProduct, effPrice } from './match.ts';
import { cartSupported } from '../cart/drivers.ts';
import { basketKey } from '../service.ts';

const r2 = (n: number) => Math.round(n * 100) / 100;

export async function quoteOne(p: GroceryProvider, basket: Basket): Promise<BasketQuote> {
  const items = basket.items.filter((i) => i.accepted && i.condition?.met !== false);
  const base: BasketQuote = {
    providerId: p.id, providerName: p.name, kind: p.kind, ok: false, lines: [], subtotal: 0, deliveryFee: 0, total: 0,
    completeness: 0, unavailableCount: 0, substitutionsCount: 0, source: p.kind === 'physical' ? 'branch_data' : 'live', fetchedAt: nowIso(),
  };
  try {
    const lines: QuoteLine[] = [];
    const sources = new Set<string>();
    let errors = 0;
    for (const it of items) {
      const c = getConcept(it.needId);
      const need = store.need(it.needId) ?? ensureNeed(it.needId);
      let rows;
      try { rows = await cachedSearch(p, c.query, it.needId); } catch (e) {
        errors++;
        if (errors >= 2 && !lines.some((l) => !l.missing)) throw e;
        lines.push({ needId: it.needId, label: it.label, quantity: it.quantity, lineTotal: 0, missing: true });
        continue;
      }
      // A product the user picked by hand at this provider wins over automatic matching.
      const picked = it.lockedByUser && it.product?.providerId === p.id ? rows.find((r) => r.productId === it.product!.productId) : undefined;
      const choice = picked ? { product: picked, substituted: false } : chooseProduct(c, need, rows);
      if (!choice) { lines.push({ needId: it.needId, label: it.label, quantity: it.quantity, lineTotal: 0, missing: true }); continue; }
      const prod = choice.product;
      if ('uncertain' in choice && choice.uncertain) {
        // Never count a suspicious match as found (and never put it in a cart automatically).
        lines.push({ needId: it.needId, label: it.label, quantity: it.quantity, product: prod, lineTotal: 0, missing: true, uncertain: true });
        continue;
      }
      sources.add(prod.source);
      // multi-buy promos only apply if we buy enough
      const unit = prod.promoMinQty && it.quantity < prod.promoMinQty ? prod.price : effPrice(prod);
      lines.push({ needId: it.needId, label: it.label, quantity: it.quantity, product: prod, lineTotal: r2(unit * it.quantity), substituted: choice.substituted });
    }
    const subtotal = r2(lines.reduce((s, l) => s + l.lineTotal, 0));
    const fee = p.kind === 'online' ? (p.freeDeliveryFrom && subtotal >= p.freeDeliveryFrom ? 0 : p.deliveryFee) : 0;
    const found = lines.filter((l) => !l.missing).length;
    return {
      ...base, ok: found > 0, lines, subtotal, deliveryFee: fee, total: r2(subtotal + fee),
      minOrderIssue: p.minOrder && subtotal < p.minOrder ? `מינימום הזמנה ₪${p.minOrder}` : undefined,
      completeness: items.length ? found / items.length : 0,
      unavailableCount: lines.filter((l) => l.missing && !l.uncertain).length,
      uncertainCount: lines.filter((l) => l.uncertain).length,
      cartSupported: p.kind === 'online' && cartSupported(p.id),
      deliveryStatus: p.kind === 'online' ? (store.household()?.deliveryStatus?.[p.id] ?? 'unknown') : undefined,
      substitutionsCount: lines.filter((l) => l.substituted).length,
      source: sources.has('demo') ? 'demo' : p.kind === 'physical' ? 'branch_data' : sources.size === 1 && sources.has('live') ? 'live' : 'estimate',
      error: found === 0 ? 'לא נמצאו מוצרים' : undefined,
    };
  } catch (e) {
    return { ...base, ok: false, error: (e as Error).message };
  }
}

export async function compareBasket(basket: Basket): Promise<Comparison> {
  const h = store.household();
  const providers = householdProviders(h, { physical: true });
  const quotes = await Promise.all(providers.map((p) => quoteOne(p, basket).catch((e) => ({ ...emptyQuote(p), error: String(e) }))));
  // Items with a hard constraint (e.g. the child's dairy-free desserts) must be available for a store to rank first.
  const hardNeeds = basket.items.filter((i) => { const n = store.need(i.needId); return !!n?.hardConstraints.length || !!getConcept(i.needId).dairyFree; }).map((i) => i.needId);
  const { ordered, recommendation } = rankQuotes(quotes, basket, h?.driveSavingsThresholdNis ?? 60, hardNeeds);
  const comparison: Comparison = {
    createdAt: nowIso(), basketKey: basketKey(basket), itemsCount: basket.items.filter((i) => i.accepted).length,
    quotes: ordered, recommendation,
  };
  store.saveComparison(comparison);
  return comparison;
}

/**
 * Pure ranking: 1) hard constraints satisfied 2) completeness (missing items valued at what other stores charge,
 * so a gap never looks like a saving) 3) final total incl. delivery. Physical branches compete via the drive threshold.
 */
export function rankQuotes(quotes: BasketQuote[], basket: Basket, threshold: number, hardNeeds: string[] = []) {
  // A missing item costs what other stores charge for it, plus a premium for having to get it elsewhere.
  const adj = (q: BasketQuote) => q.total + q.lines.filter((l) => l.missing).reduce((s, l) => s + 1.25 * (medianLine(quotes, l.needId) || fallbackValue(basket, l.needId, l.quantity)) + 10, 0);
  const hardMissing = (q: BasketQuote) => q.lines.filter((l) => l.missing && hardNeeds.includes(l.needId)).length;
  const ok = quotes.filter((q) => q.ok);
  const online = ok.filter((q) => q.kind === 'online').sort((a, b) => hardMissing(a) - hardMissing(b) || adj(a) - adj(b) || b.completeness - a.completeness);
  const physical = ok.filter((q) => q.kind === 'physical').sort((a, b) => hardMissing(a) - hardMissing(b) || adj(a) - adj(b));
  const failed = quotes.filter((q) => !q.ok);

  let recommendation: Comparison['recommendation'] = { text: 'לא הצלחתי לקבל מחירים מאף רשת כרגע.', kind: 'none' };
  const bo = online[0], bp = physical[0];
  if (bo) {
    const next = online[1];
    const gap = next ? Math.round(adj(next) - adj(bo)) : 0;
    let text = `הייתי מזמין מ${bo.providerName}.`;
    if (next) {
      const rawGap = Math.round(next.total - bo.total);
      text += hardMissing(next) > hardMissing(bo)
        ? ` ב${next.providerName} חסר מוצר שחייב להיות (${next.lines.filter((l) => l.missing && hardNeeds.includes(l.needId)).map((l) => l.label).join(', ')}).`
        : bo.completeness > next.completeness + 0.01
          ? (rawGap >= 0 ? ` היא מלאה יותר (${pct(bo)} מול ${pct(next)}) וזולה ב־₪${rawGap} מ${next.providerName}.` : ` ב${next.providerName} הסכום נמוך יותר, אבל חסרים שם עוד פריטים — כשמשלימים אותם, ${bo.providerName} יוצאת זולה ב־₪${Math.max(0, gap)}.`)
          : ` זולה ב־₪${gap} מ${next.providerName}.`;
    }
    if (bo.completeness < 0.999) text += ` חסרים בה ${bo.lines.filter((l) => l.missing).length} פריטים.`;
    recommendation = { text, winnerId: bo.providerId, kind: 'online' };
    if (bp && hardMissing(bp) <= hardMissing(bo)) {
      const saving = Math.round(adj(bo) - adj(bp));
      if (saving >= threshold) recommendation = { text: `ב${bp.providerName} תחסוך בערך ₪${saving}. זה מעל רף ה־₪${threshold} שהגדרת — הפעם הנסיעה כנראה שווה את זה.`, winnerId: bp.providerId, kind: 'physical' };
      else if (saving > 0) recommendation.text += ` הסניף זול ב־₪${saving} בלבד — מתחת לרף ה־₪${threshold}, הייתי נשאר עם משלוח.`;
    }
  } else if (bp) {
    recommendation = { text: `אין כרגע מחיר אונליין. לפי קובץ המחירים של הסניף, ${bp.providerName} יוצא ~₪${Math.round(bp.total)}.`, winnerId: bp.providerId, kind: 'physical' };
  }
  // If a cheaper branch was ranked lower because it lacks a must-have item, say so.
  const cheapestBranch = [...physical].sort((a, b) => a.total - b.total)[0];
  if (cheapestBranch && bp && cheapestBranch !== bp && hardMissing(cheapestBranch) > 0) {
    recommendation.text += ` (${cheapestBranch.providerName} זול יותר, אבל חסר שם ${cheapestBranch.lines.filter((l) => l.missing && hardNeeds.includes(l.needId)).map((l) => l.label).join(', ')} — וזה חובה אצלכם.)`;
  }
  if (failed.length && (bo || bp)) recommendation.text += ` (${failed.map((f) => f.providerName).join(', ')} לא החזירו מחיר — המשכתי בלעדיהם.)`;
  return { ordered: [...online, ...physical, ...failed], recommendation };
}

const pct = (q: BasketQuote) => `${Math.round(q.completeness * 100)}%`;

/** When no store has a price for a missing item, still charge something so a gap never looks like a saving. */
function fallbackValue(basket: Basket, needId: string, qty: number): number {
  const it = basket.items.find((i) => i.needId === needId);
  return (it?.product?.price ?? 20) * qty;
}

function medianLine(quotes: BasketQuote[], needId: string): number {
  const v = quotes.flatMap((q) => q.lines.filter((l) => l.needId === needId && !l.missing).map((l) => l.lineTotal)).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : 0;
}

function emptyQuote(p: GroceryProvider): BasketQuote {
  return { providerId: p.id, providerName: p.name, kind: p.kind, ok: false, lines: [], subtotal: 0, deliveryFee: 0, total: 0, completeness: 0, unavailableCount: 0, substitutionsCount: 0, source: 'estimate', fetchedAt: nowIso() };
}

export function explainStoreChoice(): string {
  const c = store.comparison();
  if (!c) return 'עוד לא השוויתי רשתות לסל הזה. רוצה שאשווה?';
  const lines = [c.recommendation.text];
  for (const q of c.quotes.filter((x) => x.ok).slice(0, 4)) {
    lines.push(`• ${q.providerName}: ₪${Math.round(q.total)}${q.deliveryFee ? ` (כולל משלוח ₪${q.deliveryFee})` : ''}, ${Math.round(q.completeness * 100)}% מהסל${q.substitutionsCount ? `, ${q.substitutionsCount} החלפות` : ''}`);
  }
  lines.push('הדירוג: קודם כמה מהסל יש בכל רשת, אחר כך המחיר הסופי כולל משלוח (פריט חסר נספר לפי מה שהוא עולה ברשתות אחרות).');
  return lines.join('\n');
}
