// Lightweight price history for the household's own needs: one price per (day, chain, need), recorded whenever
// Kaniti checks prices anyway (basket build, comparison). Used only to learn whether some weekday is cheaper.
import type { BasketQuote, PriceSnapshot, ProductSearchResult } from '../shared/types.ts';
import { store } from './db.ts';
import { now } from './clock.ts';

const TZ = 'Asia/Jerusalem';

export function localDate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
export function weekdayOf(d: Date): number {
  const w = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(d);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(w);
}
/** ISO week key (Monday-start), e.g. 2026-W41, from the local calendar date. */
export function isoWeekKey(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d.getTime() - firstThu.getTime()) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function stamp(at: Date) {
  const localDateStr = localDate(at);
  return { localDate: localDateStr, weekday: weekdayOf(at), weekKey: isoWeekKey(localDateStr) };
}

/** From a basket comparison: the chosen product per need at each chain (+ that chain's delivery fee). */
export function recordQuoteSnapshots(quotes: BasketQuote[], at: Date = now()) {
  const s = stamp(at);
  const rows: PriceSnapshot[] = [];
  for (const q of quotes) {
    if (!q.ok) continue;
    for (const l of q.lines) {
      if (l.missing || !l.product || l.quantity <= 0) continue;
      rows.push({ ...s, providerId: q.providerId, needId: l.needId, unitPrice: Math.round((l.lineTotal / l.quantity) * 100) / 100, regularPrice: l.product.price,
        deliveryFee: q.kind === 'online' ? q.deliveryFee : undefined, deliveryFeeKnown: q.kind === 'online' && q.deliveryFeeEstimated === false, source: l.product.source });
    }
  }
  if (rows.length) store.addSnapshots(rows);
}

/** From a price scan: the product that would be chosen per need at each chain. */
export function recordScanSnapshots(chosen: { providerId: string; needId: string; product: ProductSearchResult }[], at: Date = now()) {
  const s = stamp(at);
  const rows: PriceSnapshot[] = chosen.map((c) => ({ ...s, providerId: c.providerId, needId: c.needId, unitPrice: c.product.promoPrice ?? c.product.price, regularPrice: c.product.price, deliveryFeeKnown: false, source: c.product.source }));
  if (rows.length) store.addSnapshots(rows);
}
