// Household Insights — pure analytics over the household's own history.
// No db, no clock, no network: everything comes from InsightsInput (including `now`).
// Every number carries a confidence: 'observed' (measured from records), 'estimated'
// (a model/assumption is involved) or 'insufficient' (not enough data — we say so).
import type { Deal, HouseholdNeed, LearningEvent, PriceSnapshot, ProviderDelivery, Purchase } from '../shared/types.ts';
import type { Concept } from './catalog.ts';

export type Confidence = 'observed' | 'estimated' | 'insufficient';
export type Insight = {
  id: string;
  kind: string;
  text: string;
  confidence: Confidence;
  basis?: string;
  value?: number;
  needId?: string;
  date?: string; // YYYY-MM-DD (Asia/Jerusalem)
  weekday?: number; // 0=Sunday — set by weekdayPattern when a cheap weekday is claimed
};
export type Group = 'בשר/דגים' | 'מקרר' | 'פירות/ירקות' | 'מזווה' | 'שתייה' | 'חטיפים' | 'בית/ניקיון' | 'ילד' | 'אחר';
export type CategoryRow = { group: Group; amount: number; share: number };
export type InsightsInput = {
  now: Date;
  purchases: Purchase[];
  needs: HouseholdNeed[];
  events: LearningEvent[];
  snapshots: PriceSnapshot[];
  deals: Deal[];
  delivery: ProviderDelivery[];
  concept: (id: string) => Concept;
  shopEveryDays: number;
};
export type InsightsReport = {
  spending: Insight[];
  categories: { rows: CategoryRow[]; insight: Insight };
  rhythm: Insight[];
  consumption: Insight[];
  savings: { insights: Insight[]; saved: number; estimated: number; potential: number };
  nextShop: Insight;
  weekday: Insight;
};
export type InsightQuestion = 'spend_month' | 'top_category' | 'savings' | 'when_shop' | 'fastest' | 'overbuy' | 'cheap_day' | 'lasts';

// ---------- date helpers (Asia/Jerusalem buckets) ----------

const TZ = 'Asia/Jerusalem';
const DAY_MS = 86_400_000;
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

function localDate(x: string | Date): string {
  if (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x)) return x;
  const d = typeof x === 'string' ? new Date(x) : x;
  if (Number.isNaN(d.getTime())) return '';
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function dayNum(ld: string): number {
  const [y, m, d] = ld.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
}
function fromDayNum(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}
function addDays(ld: string, n: number): string {
  return fromDayNum(dayNum(ld) + n);
}
function daysBetweenLocal(a: string, b: string): number {
  return dayNum(b) - dayNum(a);
}
function weekdayOf(ld: string): number {
  return new Date(dayNum(ld) * DAY_MS).getUTCDay();
}
function monthKey(ld: string): string {
  return ld.slice(0, 7);
}
function prevMonth(mk: string): string {
  const [y, m] = mk.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}
function nextMonth(mk: string): string {
  const [y, m] = mk.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}
function ddmm(ld: string): string {
  return `${ld.slice(8, 10)}/${ld.slice(5, 7)}`;
}

const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const DAY_LETTERS = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
const dayName = (ld: string) => `יום ${DAY_NAMES[weekdayOf(ld)]}`;

// ---------- small helpers ----------

const nis = (n: number) => `₪${Math.round(n)}`;
const round2 = (n: number) => Math.round(n * 100) / 100;
const round1 = (n: number) => Math.round(n * 10) / 10;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function safeConcept(i: InsightsInput, id: string): Concept | undefined {
  try {
    return i.concept(id);
  } catch {
    return undefined;
  }
}
function needLabel(i: InsightsInput, needId: string): string {
  return i.needs.find((n) => n.id === needId)?.label ?? safeConcept(i, needId)?.label ?? needId;
}
const ins = (kind: string, text: string, confidence: Confidence, extra: Partial<Insight> = {}): Insight => ({
  id: extra.needId ? `${kind}:${extra.needId}` : kind,
  kind,
  text,
  confidence,
  ...extra,
});
const sortedPurchases = (i: InsightsInput) =>
  [...i.purchases].filter((p) => localDate(p.createdAt)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));

/** Distinct shopping days (several purchases on one local date count as one shop). */
function shopDays(i: InsightsInput): string[] {
  return [...new Set(sortedPurchases(i).map((p) => localDate(p.createdAt)))].sort();
}
function meanInterval(i: InsightsInput): number | undefined {
  const d = shopDays(i);
  if (d.length < 2) return undefined;
  return daysBetweenLocal(d[0], d[d.length - 1]) / (d.length - 1);
}

// ---------- groups ----------

export function groupOf(c: Concept): Group {
  if (c.id.startsWith('CUSTOM_')) return 'אחר';
  switch (c.category) {
    case 'meat':
    case 'fish':
      return 'בשר/דגים';
    case 'dairy':
    case 'eggs':
    case 'frozen':
      return 'מקרר';
    case 'produce':
      return 'פירות/ירקות';
    case 'pantry':
    case 'bakery':
      return 'מזווה';
    case 'drinks':
      return 'שתייה';
    case 'snacks':
      return 'חטיפים';
    case 'cleaning':
    case 'paper':
      return 'בית/ניקיון';
    case 'kids':
      return 'ילד';
    default:
      return 'אחר';
  }
}
function groupOfId(i: InsightsInput, needId: string): Group {
  if (needId.startsWith('CUSTOM_')) return 'אחר';
  const c = safeConcept(i, needId);
  return c ? groupOf(c) : 'אחר';
}

// ---------- spending ----------

export function spending(i: InsightsInput): Insight[] {
  const ps = sortedPurchases(i);
  const today = localDate(i.now);
  const curMonth = monthKey(today);
  const out: Insight[] = [];

  const monthSum = ps.filter((p) => monthKey(localDate(p.createdAt)) === curMonth).reduce((s, p) => s + p.total, 0);
  out.push(
    monthSum > 0
      ? ins('month_spend', `החודש הוצאתם עד עכשיו ${nis(monthSum)} על קניות`, 'observed', { value: round2(monthSum) })
      : ins('month_spend', 'החודש עוד לא נרשמו קניות', 'observed', { value: 0 }),
  );

  const last = ps[ps.length - 1];
  out.push(
    last
      ? ins('last_shop', `הקנייה האחרונה (${ddmm(localDate(last.createdAt))}) עלתה ${nis(last.total)}`, 'observed', { value: round2(last.total), date: localDate(last.createdAt) })
      : ins('last_shop', 'עדיין לא נרשמו קניות', 'insufficient'),
  );

  out.push(
    ps.length >= 2
      ? ins('avg_shop', `קנייה ממוצעת אצלכם עולה ${nis(mean(ps.map((p) => p.total)))} (לפי ${ps.length} קניות)`, 'observed', { value: round2(mean(ps.map((p) => p.total))) })
      : ins('avg_shop', 'צריך לפחות 2 קניות כדי לחשב ממוצע', 'insufficient'),
  );

  // Complete calendar months strictly after the first purchase's month and before the current month.
  const months: string[] = [];
  if (ps.length) {
    for (let m = nextMonth(monthKey(localDate(ps[0].createdAt))); m < curMonth; m = nextMonth(m)) months.push(m);
  }
  const sumOf = (m: string) => ps.filter((p) => monthKey(localDate(p.createdAt)) === m).reduce((s, p) => s + p.total, 0);
  const lastMonth = prevMonth(curMonth);
  if (months.includes(lastMonth)) {
    out.push(ins('last_month', `בחודש שעבר ${nis(sumOf(lastMonth))}`, 'observed', { value: round2(sumOf(lastMonth)) }));
  } else if (months.length === 1) {
    out.push(ins('last_month', `בחודש המלא היחיד שיש (${months[0].slice(5)}/${months[0].slice(0, 4)}) ${nis(sumOf(months[0]))}`, 'observed', { value: round2(sumOf(months[0])) }));
  }
  if (months.length >= 2) {
    const avg = mean(months.map(sumOf));
    out.push(ins('monthly_avg', `בחודש ממוצע אתם מוציאים ${nis(avg)} (לפי ${months.length} חודשים מלאים)`, 'observed', { value: round2(avg) }));
  } else {
    out.push(ins('monthly_avg', 'צריך לפחות 2 חודשים מלאים של קניות כדי לחשב ממוצע חודשי', 'insufficient'));
  }
  return out;
}

// ---------- category mix ----------

const isDeliveryLine = (needId: string, label?: string) => /deliver/i.test(needId) || (label ?? '').includes('משלוח');

export function categoryMix(i: InsightsInput, windowDays = 90): { rows: CategoryRow[]; insight: Insight } {
  const from = i.now.getTime() - windowDays * DAY_MS;
  const ps = i.purchases.filter((p) => {
    const t = new Date(p.createdAt).getTime();
    return t >= from && t <= i.now.getTime() + DAY_MS;
  });
  const sums = new Map<Group, number>();
  let lines = 0;
  let priced = 0;
  for (const p of ps) {
    for (const it of p.items) {
      if (isDeliveryLine(it.needId, it.label)) continue;
      lines++;
      if (typeof it.price !== 'number' || !Number.isFinite(it.price)) continue;
      priced++;
      const g = groupOfId(i, it.needId);
      sums.set(g, (sums.get(g) ?? 0) + it.price * (it.quantity || 0));
    }
  }
  const total = [...sums.values()].reduce((a, b) => a + b, 0);
  const rows: CategoryRow[] = [...sums.entries()]
    .filter(([, a]) => a > 0)
    .map(([group, amount]) => ({ group, amount: round2(amount), share: total > 0 ? amount / total : 0 }))
    .sort((a, b) => b.amount - a.amount);
  if (!ps.length || !rows.length) {
    return { rows, insight: ins('top_category', `עדיין אין מספיק קניות עם מחירים ב־${windowDays} הימים האחרונים כדי לפלח לפי קטגוריות`, 'insufficient') };
  }
  const coverage = lines ? priced / lines : 0;
  const top = rows[0];
  const note = coverage < 1 ? ` · ל־${priced} מתוך ${lines} פריטים יש מחיר` : '';
  return {
    rows,
    insight: ins(
      'top_category',
      `הכי הרבה כסף הולך על ${top.group} — ${Math.round(top.share * 100)}% (${nis(top.amount)}) מהקניות ב־${windowDays} הימים האחרונים, לא כולל משלוח`,
      coverage >= 0.8 ? 'observed' : 'estimated',
      { value: round2(top.share), basis: `סכום מחיר×כמות לפי קבוצה${note}` },
    ),
  };
}

// ---------- rhythm ----------

export function rhythm(i: InsightsInput): Insight[] {
  const days = shopDays(i);
  const today = localDate(i.now);
  const out: Insight[] = [];
  if (days.length >= 3) {
    const m = meanInterval(i)!;
    out.push(ins('interval', `אתם קונים בממוצע כל ${Math.round(m)} ימים`, 'observed', { value: round1(m), basis: `${days.length} קניות` }));
  } else if (days.length === 2) {
    const g = daysBetweenLocal(days[0], days[1]);
    out.push(ins('interval', `בין שתי הקניות עברו ${g} ימים`, 'estimated', { value: g, basis: 'רק שתי קניות — עדיין לא קצב' }));
  } else {
    out.push(ins('interval', 'עדיין אין מספיק קניות כדי לדעת כל כמה זמן אתם קונים', 'insufficient'));
  }
  if (days.length >= 1) {
    const last = days[days.length - 1];
    const ago = Math.max(0, daysBetweenLocal(last, today));
    const when = ago === 0 ? 'היום' : ago === 1 ? 'אתמול' : `לפני ${ago} ימים`;
    out.push(ins('since_last', `הקנייה האחרונה הייתה ${when}`, 'observed', { value: ago, date: last }));
  }
  return out;
}

// ---------- stock & depletion ----------

type StockNow = { qty: number; confidence: number; known: boolean };
function stockNow(n: HouseholdNeed, now: Date): StockNow {
  if (!n.stockAsOf || typeof n.currentStockEstimate !== 'number') return { qty: 0, confidence: 0, known: false };
  const t = new Date(n.stockAsOf).getTime();
  if (Number.isNaN(t)) return { qty: 0, confidence: 0, known: false };
  const days = Math.max(0, (now.getTime() - t) / DAY_MS);
  const rate = (n.typical14DayQty || 0) / 14;
  const qty = Math.max(0, n.currentStockEstimate - rate * days);
  const confidence = (n.stockConfidence ?? 0) * Math.pow(0.5, days / 14);
  return { qty, confidence, known: true };
}

export function depletion(i: InsightsInput): { date?: string; drivers: string[]; confidence: Confidence; basis: 'stock' | 'rhythm' } {
  const today = localDate(i.now);
  const active = i.needs.filter((n) => n.active && n.typical14DayQty > 0);
  const known = active
    .map((n) => ({ n, s: stockNow(n, i.now) }))
    .filter((x) => x.s.known && x.s.confidence >= 0.3);

  if (active.length && known.length / active.length >= 0.5) {
    const zeros = known
      .map(({ n, s }) => {
        const daysLeft = s.qty / (n.typical14DayQty / 14);
        return { n, at: localDate(new Date(i.now.getTime() + daysLeft * DAY_MS)), daysLeft };
      })
      .sort((a, b) => a.daysLeft - b.daysLeft);
    const highWaste = zeros.find((z) => z.n.wasteRisk === 'high');
    const kth = zeros[Math.min(3, zeros.length) - 1];
    const pick = highWaste && highWaste.daysLeft <= kth.daysLeft ? highWaste : kth;
    let date = addDays(pick.at, -1);
    if (date < today) date = today;
    const drivers = (pick === highWaste ? [highWaste] : zeros.slice(0, Math.min(3, zeros.length))).map((z) => z.n.label);
    return { date, drivers, confidence: 'estimated', basis: 'stock' };
  }

  const days = shopDays(i);
  if (!days.length) return { drivers: [], confidence: 'insufficient', basis: 'rhythm' };
  const every = meanInterval(i) ?? i.shopEveryDays;
  let date = addDays(days[days.length - 1], Math.round(every || 7));
  if (date < today) date = today;
  return { date, drivers: [], confidence: 'estimated', basis: 'rhythm' };
}

// ---------- consumption ----------

type FeedbackKind = 'ran_out' | 'too_much';
function eventKind(e: LearningEvent): FeedbackKind | undefined {
  const v = e.value as unknown;
  const obj = v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
  if (e.type === 'quantity_feedback') {
    const f = typeof v === 'string' ? v : obj?.feedback ?? obj?.value;
    if (f === 'ran_out') return 'ran_out';
    if (f === 'too_much') return 'too_much';
  }
  if (e.type === 'quantity_changed') {
    const r = obj?.reason;
    if (r === 'ran_out_early') return 'ran_out';
    if (r === 'left_over') return 'too_much';
  }
  if (e.type === 'stock_report') {
    const q = typeof v === 'number' ? v : obj?.qty;
    if (typeof q === 'number' && q <= 0) return 'ran_out';
  }
  return undefined;
}

function needPurchases(i: InsightsInput, needId: string) {
  return sortedPurchases(i)
    .map((p) => {
      const items = p.items.filter((it) => it.needId === needId && (it.quantity || 0) > 0);
      return { p, date: localDate(p.createdAt), qty: items.reduce((s, it) => s + it.quantity, 0), items };
    })
    .filter((x) => x.qty > 0);
}

function approxDuration(days: number): string {
  if (days >= 6 && days <= 8) return 'כשבוע';
  if (days >= 12 && days <= 16) return 'כשבועיים';
  if (days >= 19 && days <= 23) return 'כשלושה שבועות';
  if (days >= 26 && days <= 35) return 'כחודש';
  if (days >= 50 && days <= 70) return 'כחודשיים';
  return `כ־${Math.round(days)} ימים`;
}

type Lasts = { daysPerPack?: number; purchases: number; confidence: Confidence; insight: Insight };
function lastsFor(i: InsightsInput, needId: string): Lasts {
  const label = needLabel(i, needId);
  const c = safeConcept(i, needId);
  const today = localDate(i.now);
  const buys = needPurchases(i, needId).filter((b) => daysBetweenLocal(b.date, today) <= 365);
  if (buys.length < 3) {
    return { purchases: buys.length, confidence: 'insufficient', insight: ins('lasts', `עדיין אין מספיק קניות של ${label} כדי לדעת כמה זמן זה מחזיק`, 'insufficient', { needId }) };
  }
  const span = daysBetweenLocal(buys[0].date, buys[buys.length - 1].date);
  const packs = buys.slice(0, -1).reduce((s, b) => s + b.qty, 0);
  if (span <= 0 || packs <= 0) {
    return { purchases: buys.length, confidence: 'insufficient', insight: ins('lasts', `עדיין אין מספיק קניות של ${label} כדי לדעת כמה זמן זה מחזיק`, 'insufficient', { needId }) };
  }
  const dpp = span / packs;
  const confidence: Confidence = buys.length >= 4 ? 'observed' : 'estimated';
  const unit = c?.packLabel ? `ל${c.packLabel}` : 'ליחידה';
  return {
    daysPerPack: round1(dpp),
    purchases: buys.length,
    confidence,
    insight: ins('lasts', `${label} מחזיק אצלכם בממוצע ${approxDuration(dpp)} (${Math.round(dpp)} ימים ${unit})`, confidence, {
      needId,
      value: round1(dpp),
      basis: `${buys.length} קניות`,
    }),
  };
}

export function consumption(i: InsightsInput, needId?: string): Insight[] {
  const today = localDate(i.now);
  const since = addDays(today, -120);
  const ids = needId
    ? [needId]
    : [...new Set([...i.needs.filter((n) => n.active).map((n) => n.id), ...i.purchases.flatMap((p) => p.items.map((it) => it.needId))])];

  const counts = new Map<string, { ran_out: number; too_much: number }>();
  const bump = (id: string, k: FeedbackKind) => {
    const c = counts.get(id) ?? { ran_out: 0, too_much: 0 };
    c[k]++;
    counts.set(id, c);
  };
  for (const e of i.events) {
    if (!e.needId || localDate(e.createdAt) < since) continue;
    const k = eventKind(e);
    if (k) bump(e.needId, k);
  }
  for (const p of i.purchases) {
    if (!p.feedback || localDate(p.createdAt) < since) continue;
    for (const [id, f] of Object.entries(p.feedback)) if (f === 'ran_out' || f === 'too_much') bump(id, f);
  }

  const faster: Insight[] = [];
  const tooMuch: Insight[] = [];
  const skip: Insight[] = [];
  const lasts: Insight[] = [];
  const lastsAll: Lasts[] = [];
  for (const id of ids) {
    const n = i.needs.find((x) => x.id === id);
    const label = needLabel(i, id);
    const c = counts.get(id) ?? { ran_out: 0, too_much: 0 };
    if (c.ran_out >= 2) {
      faster.push(ins('runs_faster', `${label} נגמרים אצלכם מהר יותר ממה שהערכתי`, 'observed', { needId: id, value: c.ran_out, basis: `${c.ran_out} פעמים שנגמר מוקדם ב־120 הימים האחרונים` }));
    }
    const removed = n?.removedCount ?? 0;
    if (c.too_much >= 2 || removed >= 2) {
      tooMuch.push(
        ins('too_much', `נראה שאתם קונים יותר מדי ${label}`, 'observed', {
          needId: id,
          value: Math.max(c.too_much, removed),
          basis: c.too_much >= 2 ? `${c.too_much} פעמים נשאר יותר מדי` : `הסרתם מהסל ${removed} פעמים`,
        }),
      );
    }
    if (n && n.typical14DayQty > 0) {
      const buys = needPurchases(i, id);
      const lastBuy = buys[buys.length - 1];
      const cpt = safeConcept(i, id);
      const packSize = cpt?.packSize || 1;
      if (lastBuy) {
        const big = lastBuy.items.some((it) => it.status === 'opportunity') || lastBuy.qty >= 1.5 * (n.typical14DayQty / packSize);
        const s = stockNow(n, i.now);
        if (big && s.known && s.qty >= n.typical14DayQty && s.confidence >= 0.4) {
          skip.push(ins('can_skip', `קניתם ${label} בכמות גדולה בפעם הקודמת ולכן כנראה אפשר לדלג הפעם`, 'estimated', { needId: id, value: round1(s.qty), date: lastBuy.date }));
        }
      }
    }
    const l = lastsFor(i, id);
    if (l.confidence !== 'insufficient') {
      lasts.push(l.insight);
      lastsAll.push(l);
    } else if (needId) {
      lasts.push(l.insight);
    }
  }

  if (needId) return [...faster, ...tooMuch, ...skip, ...lasts];

  const out = [...faster, ...tooMuch, ...skip, ...lasts.sort((a, b) => (a.confidence === b.confidence ? 0 : a.confidence === 'observed' ? -1 : 1))];
  const fast = fastestOf(i, lastsAll);
  if (fast.confidence !== 'insufficient') out.push(fast);
  return out.slice(0, 6);
}

function fastestOf(i: InsightsInput, all: Lasts[]): Insight {
  const obs = all.filter((l) => l.confidence === 'observed' && l.daysPerPack !== undefined).sort((a, b) => a.daysPerPack! - b.daysPerPack!);
  const f = obs[0];
  if (!f) return ins('fastest', 'עדיין אין מספיק קניות חוזרות כדי לדעת מה נגמר אצלכם הכי מהר', 'insufficient');
  const needId = f.insight.needId!;
  return ins('fastest', `הכי מהר נגמר אצלכם ${needLabel(i, needId)} — בערך כל ${Math.round(f.daysPerPack!)} ימים ליחידה`, 'observed', { needId, value: f.daysPerPack });
}

// ---------- savings ----------

export function savings(i: InsightsInput): InsightsReport['savings'] {
  let storeSaved = 0;
  let storeEst = 0;
  let promoSaved = 0;
  let subEst = 0;
  for (const p of i.purchases) {
    if (p.priceSource === 'demo') continue;
    const a = p.atPurchase;
    if (a?.fresh && a.nextBest && a.chosenTotal > 0) {
      const nb = a.nextBest;
      const completeOk = a.chosenCompleteness >= 0.95 && nb.completeness >= 0.95 && Math.abs(a.chosenCompleteness - nb.completeness) <= 0.05;
      const totalOk = Math.abs(p.total - a.chosenTotal) <= 0.15 * a.chosenTotal;
      const gap = nb.total - a.chosenTotal;
      if (completeOk && totalOk && gap > 0) {
        if (p.priceSource === 'live' && !p.deliveryFeeEstimated) storeSaved += gap;
        else storeEst += gap;
      }
    }
    for (const it of p.items) {
      const q = it.quantity || 0;
      if (typeof it.price !== 'number') continue;
      if (typeof it.regularPrice === 'number' && it.regularPrice > it.price && (!it.promoMinQty || q >= it.promoMinQty)) {
        promoSaved += (it.regularPrice - it.price) * q;
      }
      if (typeof it.usualPrice === 'number' && it.usualPrice > it.price) subEst += (it.usualPrice - it.price) * q;
    }
  }
  const potential = Math.round(
    i.deals.filter((d) => d.kind !== 'discovery' && d.kind !== 'anyway').reduce((s, d) => s + (d.savingNis ?? dealFraction(d) * (d.product?.price || 0) * (d.suggestQty || 0)), 0),
  );

  const saved = round2(storeSaved + promoSaved);
  const estimated = round2(storeEst + subEst);
  const insights: Insight[] = [];
  if (storeSaved > 0) insights.push(ins('saved_store', `חסכתם ${nis(storeSaved)} (נמדד מול ההצעה הבאה בתור)`, 'observed', { value: round2(storeSaved), basis: 'השוואה טרייה בזמן הקנייה, מחירים חיים ודמי משלוח ידועים' }));
  if (promoSaved > 0) insights.push(ins('saved_promo', `חסכתם ${nis(promoSaved)} במבצעים (מחיר רגיל מול מה ששילמתם)`, 'observed', { value: round2(promoSaved) }));
  if (estimated > 0) {
    const parts = [storeEst > 0 ? 'בחירת חנות' : '', subEst > 0 ? 'מוצר חלופי זול יותר' : ''].filter(Boolean).join(' ו');
    insights.push(ins('saved_estimated', `חיסכון משוער ${nis(estimated)} (${parts})`, 'estimated', { value: estimated }));
  }
  if (!insights.length) insights.push(ins('saved_none', 'עדיין אין חיסכון שאפשר למדוד — צריך קנייה שנעשתה אחרי השוואה', 'insufficient'));
  if (potential > 0) insights.push(ins('potential', `אפשר לחסוך עכשיו ~${nis(potential)} במבצעים`, 'estimated', { value: potential }));
  return { insights, saved, estimated, potential };
}

// ---------- weekday pattern ----------

const WEEKS_WORD: Record<number, string> = { 4: 'בארבעת', 5: 'בחמשת', 6: 'בששת', 7: 'בשבעת', 8: 'בשמונת', 9: 'בתשעת', 10: 'בעשרת' };
const PRICE_NOTE = 'המחירים נרשמים רק כשקניתי בודקת מחירים';

export function weekdayPattern(i: InsightsInput): Insight {
  const today = localDate(i.now);
  const since = addDays(today, -120);
  const snaps = i.snapshots.filter((s) => (s.source === 'live' || s.source === 'branch_data') && s.localDate >= since && s.localDate <= today && s.unitPrice > 0);

  const byPN = new Map<string, number[]>();
  for (const s of snaps) {
    const k = `${s.providerId}|${s.needId}`;
    byPN.set(k, [...(byPN.get(k) ?? []), s.unitPrice]);
  }
  const med = new Map([...byPN].map(([k, v]) => [k, median(v)]));

  const byPD = new Map<string, { date: string; weekKey: string; rs: Map<string, number[]> }>();
  for (const s of snaps) {
    const k = `${s.providerId}|${s.localDate}`;
    const e = byPD.get(k) ?? { date: s.localDate, weekKey: s.weekKey, rs: new Map() };
    e.rs.set(s.needId, [...(e.rs.get(s.needId) ?? []), s.unitPrice / med.get(`${s.providerId}|${s.needId}`)!]);
    byPD.set(k, e);
  }
  type Day = { date: string; weekKey: string; wd: number; idx: number };
  const days: Day[] = [...byPD.values()]
    .filter((e) => e.rs.size >= 5)
    .map((e) => ({ date: e.date, weekKey: e.weekKey, wd: weekdayOf(e.date), idx: median([...e.rs.values()].map((v) => mean(v))) }));

  const weeks = new Set(days.map((d) => d.weekKey));
  const datesPerWd = (wd: number) => new Set(days.filter((d) => d.wd === wd).map((d) => d.date)).size;
  const richWds = [0, 1, 2, 3, 4, 5, 6].filter((wd) => datesPerWd(wd) >= 2);

  if (weeks.size < 4 || richWds.length < 3) {
    const why = weeks.size < 4 ? `יש מחירים מ־${weeks.size} שבועות, צריך לפחות 4` : 'צריך מחירים מלפחות שלושה ימים שונים בשבוע, כל אחד לפחות פעמיים';
    return ins('cheap_day', `עדיין אין מספיק היסטוריה כדי לדעת אם יש יום קבוע זול יותר (${why}). ${PRICE_NOTE}.`, 'insufficient', { value: weeks.size });
  }

  let best: { wd: number; diff: number } | undefined;
  for (const wd of richWds) {
    const others = richWds.filter((w) => w !== wd);
    if (others.length < 2) continue;
    const mine = days.filter((d) => d.wd === wd).map((d) => d.idx);
    const rest = days.filter((d) => d.wd !== wd).map((d) => d.idx);
    const diff = median(mine) - median(rest);
    if (diff > -0.03) continue;
    let both = 0;
    let lower = 0;
    for (const wk of weeks) {
      const a = days.filter((d) => d.weekKey === wk && d.wd === wd).map((d) => d.idx);
      const b = days.filter((d) => d.weekKey === wk && d.wd !== wd).map((d) => d.idx);
      if (!a.length || !b.length) continue;
      both++;
      if (median(a) < median(b)) lower++;
    }
    if (both === 0 || lower / both < 2 / 3) continue;
    if (!best || diff < best.diff) best = { wd, diff };
  }
  if (!best) {
    return ins('cheap_day', `לא ראיתי הבדל עקבי בין ימים (לפי ${weeks.size} שבועות של מחירים). ${PRICE_NOTE}.`, 'observed', { value: weeks.size });
  }
  const pct = Math.round(-best.diff * 100);
  const wWord = WEEKS_WORD[weeks.size] ?? `ב־${weeks.size}`;
  return ins('cheap_day', `${wWord} השבועות האחרונים סל דומה היה זול יותר ביום ${DAY_LETTERS[best.wd]} (בכ־${pct}%). ${PRICE_NOTE}.`, 'estimated', {
    value: pct,
    weekday: best.wd,
    basis: `${days.length} ימי מחירים`,
  });
}

// ---------- next shop ----------

export function recommendNextShop(i: InsightsInput): Insight {
  const today = localDate(i.now);
  if (!i.needs.some((n) => n.active)) {
    return ins('next_shop', 'עדיין אין רשימת מוצרים קבועים, אז אין לי על מה לבסס המלצה מתי לקנות', 'insufficient');
  }
  const dep = depletion(i);
  if (!dep.date) {
    return ins('next_shop', 'עדיין אין מספיק מידע על המלאי או על קצב הקניות כדי להמליץ על יום לקנייה הבאה', 'insufficient');
  }
  const base = dep.date;
  const parts: string[] = [];
  let rec = base;

  const relevant = i.deals.filter((d) => dealFraction(d) >= 0.15 && safeConcept(i, d.needId)?.shelfStable);
  const withEnd = relevant.map((d) => ({ d, end: d.product?.promoEndsAt ? localDate(d.product.promoEndsAt) : '' }));
  const catchable = withEnd.filter((x) => x.end && x.end < base && x.end >= today && x.end >= addDays(base, -3));
  const unknownEnd = withEnd.filter((x) => !x.end);

  const intro =
    dep.basis === 'stock'
      ? `המלאי כנראה יספיק עד ${dayName(base)} (${ddmm(base)})`
      : `לפי הקצב שלכם, הקנייה הבאה צפויה בסביבות ${dayName(base)} (${ddmm(base)})`;

  if (catchable.length) {
    rec = catchable.map((x) => x.end).sort()[0];
    const n = catchable.length;
    const dealsWord = n === 1 ? `מבצע טוב על ${catchable[0].d.label} מסתיים` : `${n} מבצעים טובים מסתיימים`;
    const before = addDays(rec, -1);
    const shopWhen = before >= today ? `${dayName(before)} או ${DAY_NAMES[weekdayOf(rec)]}` : rec === today ? 'היום' : dayName(rec);
    parts.push(`${intro}, אבל ${dealsWord} ב${dayName(rec)} (${ddmm(rec)}). הייתי עושה את הקנייה ב${shopWhen}.`);
  } else if (rec === today) {
    parts.push(`${intro}. כדאי לעשות את הקנייה כבר היום.`);
  } else {
    parts.push(`${intro}. הייתי עושה את הקנייה עד ${dayName(rec)} (${ddmm(rec)}).`);
  }
  if (dep.basis === 'stock' && dep.drivers.length) {
    parts.push(`${dep.drivers.length === 1 ? 'הראשון להיגמר כנראה' : 'הראשונים להיגמר כנראה'}: ${dep.drivers.join(', ')}.`);
  }
  if (unknownEnd.length) {
    parts.push(`יש מבצע טוב על ${unknownEnd.map((x) => x.d.label).join(', ')}, אבל לא ידוע עד מתי המבצע.`);
  }

  const wk = weekdayPattern(i);
  if (wk.confidence === 'estimated' && wk.weekday !== undefined) {
    for (let d = addDays(rec, -2); d <= rec; d = addDays(d, 1)) {
      if (d >= today && weekdayOf(d) === wk.weekday) {
        parts.push(`בדרך כלל יום ${DAY_LETTERS[wk.weekday]} יוצא קצת יותר זול, אז אפשר לכוון ל־${ddmm(d)}.`);
        break;
      }
    }
  }

  const fresh = i.delivery.filter((d) => {
    const age = i.now.getTime() - new Date(d.checkedAt).getTime();
    return !!d.deliveryWindows?.length && age >= -DAY_MS && age < DAY_MS;
  });
  for (const d of fresh) {
    const name = i.purchases.find((p) => p.providerId === d.providerId)?.storeName ?? d.providerId;
    parts.push(`חלונות משלוח פנויים ב${name}: ${d.deliveryWindows!.slice(0, 3).join(', ')}.`);
  }

  return ins('next_shop', parts.join(' '), 'estimated', {
    date: rec,
    value: daysBetweenLocal(today, rec),
    basis: dep.basis === 'stock' ? 'הערכת מלאי' : 'קצב הקניות',
  });
}

// ---------- report & chat ----------

export function buildInsights(i: InsightsInput): InsightsReport {
  return {
    spending: spending(i),
    categories: categoryMix(i),
    rhythm: rhythm(i),
    consumption: consumption(i),
    savings: savings(i),
    nextShop: recommendNextShop(i),
    weekday: weekdayPattern(i),
  };
}

function say(x: Insight): string {
  if (x.confidence === 'estimated') return x.text.startsWith('הערכה') ? x.text : `הערכה: ${x.text}`;
  if (x.confidence === 'insufficient') return /אין מספיק|צריך לפחות|עדיין/.test(x.text) ? x.text : `אין לי עדיין מספיק נתונים: ${x.text}`;
  return x.text;
}
const join = (xs: Insight[]) => xs.map(say).join('\n');

export function answer(q: InsightQuestion, r: InsightsReport, i: InsightsInput, needId?: string): string {
  switch (q) {
    case 'spend_month': {
      const pick = ['month_spend', 'last_month', 'monthly_avg'];
      const xs = r.spending.filter((x) => pick.includes(x.kind) && !(x.kind === 'monthly_avg' && x.confidence === 'insufficient' && !i.purchases.length));
      return join(xs);
    }
    case 'top_category': {
      const rows = r.categories.rows.slice(0, 3);
      const tail = rows.length > 1 ? `\nאחריו: ${rows.slice(1).map((x) => `${x.group} ${Math.round(x.share * 100)}%`).join(', ')}` : '';
      return say(r.categories.insight) + tail;
    }
    case 'savings':
      return join(r.savings.insights);
    case 'when_shop':
      return say(r.nextShop);
    case 'fastest': {
      const f = r.consumption.find((x) => x.kind === 'fastest');
      return f ? say(f) : 'עדיין אין מספיק קניות חוזרות כדי לדעת מה נגמר אצלכם הכי מהר';
    }
    case 'overbuy': {
      const xs = r.consumption.filter((x) => x.kind === 'too_much' || x.kind === 'can_skip');
      if (xs.length) return join(xs);
      if (!i.purchases.length && !i.events.length) return 'עדיין אין מספיק נתונים כדי לדעת אם אתם קונים משהו יותר מדי';
      return 'לא ראיתי משהו שאתם קונים יותר מדי';
    }
    case 'cheap_day':
      return say(r.weekday);
    case 'lasts': {
      if (needId) {
        const l = consumption(i, needId).find((x) => x.kind === 'lasts');
        return l ? say(l) : `עדיין אין מספיק קניות של ${needLabel(i, needId)} כדי לדעת כמה זמן זה מחזיק`;
      }
      const xs = r.consumption.filter((x) => x.kind === 'lasts');
      return xs.length ? join(xs.slice(0, 3)) : 'עדיין אין מספיק קניות חוזרות כדי לדעת כמה זמן דברים מחזיקים אצלכם';
    }
  }
}

/** Deal.discountPct is a whole percentage (30 = 30%); tolerate fractions too. */
function dealFraction(d: Deal): number {
  const v = d.discountPct || 0;
  return v > 1 ? v / 100 : v;
}
