// One-store basket comparison across delivery chains and physical branches. Deterministic.
import type { Basket, BasketQuote, Comparison, QuoteLine } from '../../shared/types.ts';
import { store } from '../db.ts';
import { nowIso } from '../clock.ts';
import { ensureNeed, getConcept } from '../state.ts';
import { cachedSearch, householdProviders } from '../providers/index.ts';
import type { GroceryProvider } from '../providers/types.ts';
import { chooseProduct, effPrice } from './match.ts';

const r2 = (n: number) => Math.round(n * 100) / 100;

async function quoteOne(p: GroceryProvider, basket: Basket): Promise<BasketQuote> {
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
      const choice = chooseProduct(c, need, rows);
      if (!choice) { lines.push({ needId: it.needId, label: it.label, quantity: it.quantity, lineTotal: 0, missing: true }); continue; }
      const prod = choice.product;
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
      unavailableCount: lines.filter((l) => l.missing).length,
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
  // Missing items are valued at what other stores charge, so a cheap-but-incomplete basket doesn't "win".
  const adj = (q: BasketQuote) => q.total + q.lines.filter((l) => l.missing).reduce((s, l) => s + medianLine(quotes, l.needId), 0);
  const ok = quotes.filter((q) => q.ok);
  const online = ok.filter((q) => q.kind === 'online').sort((a, b) => adj(a) - adj(b) || b.completeness - a.completeness);
  const physical = ok.filter((q) => q.kind === 'physical').sort((a, b) => adj(a) - adj(b));
  const failed = quotes.filter((q) => !q.ok);
  const threshold = h?.driveSavingsThresholdNis ?? 60;

  let recommendation: Comparison['recommendation'] = { text: 'לא הצלחתי לקבל מחירים מאף רשת כרגע.', kind: 'none' };
  const bo = online[0], bp = physical[0];
  if (bo) {
    const next = online[1];
    const gap = next ? Math.round(adj(next) - adj(bo)) : 0;
    let text = `הייתי מזמין מ${bo.providerName}.`;
    if (next) text += bo.completeness > next.completeness + 0.01 ? ` היא מלאה יותר וזולה ב־₪${Math.max(0, gap)} מהאפשרות הבאה.` : ` זולה ב־₪${gap} מ${next.providerName}.`;
    if (bo.completeness < 0.999) text += ` חסרים בה ${bo.unavailableCount} פריטים.`;
    recommendation = { text, winnerId: bo.providerId, kind: 'online' };
    if (bp) {
      const saving = Math.round(adj(bo) - adj(bp));
      if (saving >= threshold) recommendation = { text: `ב${bp.providerName} תחסוך בערך ₪${saving}. זה מעל רף ה־₪${threshold} שהגדרת — הפעם הנסיעה כנראה שווה את זה.`, winnerId: bp.providerId, kind: 'physical' };
      else if (saving > 0) recommendation.text += ` הסניף זול ב־₪${saving} בלבד — הייתי נשאר עם משלוח.`;
    }
  } else if (bp) {
    recommendation = { text: `אין כרגע מחיר אונליין. לפי נתוני הסניף, ${bp.providerName} יוצא ~₪${Math.round(bp.total)}.`, winnerId: bp.providerId, kind: 'physical' };
  }
  if (failed.length && (bo || bp)) recommendation.text += ` (${failed.map((f) => f.providerName).join(', ')} לא החזירו מחיר — המשכתי בלעדיהם.)`;

  const comparison: Comparison = {
    createdAt: nowIso(), itemsCount: basket.items.filter((i) => i.accepted).length,
    quotes: [...online, ...physical, ...failed], recommendation,
  };
  store.saveComparison(comparison);
  return comparison;
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
