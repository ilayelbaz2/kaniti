// Pure tests for the Household Insights module — no db, no clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONCEPTS, customConcept, type Concept } from '../server/catalog.ts';
import {
  answer, buildInsights, categoryMix, consumption, depletion, groupOf, recommendNextShop, rhythm, savings, spending, weekdayPattern,
  type InsightQuestion, type InsightsInput,
} from '../server/insights.ts';
import type { Deal, HouseholdNeed, LearningEvent, PriceSnapshot, Purchase, PurchaseItem } from '../shared/types.ts';

const NOW = new Date('2026-10-07T09:00:00Z');
const byId = new Map(CONCEPTS.map((c) => [c.id, c]));
const concept = (id: string): Concept => byId.get(id) ?? customConcept(id, id);

const input = (over: Partial<InsightsInput> = {}): InsightsInput => ({
  now: NOW, purchases: [], needs: [], events: [], snapshots: [], deals: [], delivery: [], concept, shopEveryDays: 7, ...over,
});

let pid = 0;
const item = (needId: string, quantity: number, price?: number, extra: Partial<PurchaseItem> = {}): PurchaseItem => ({
  needId, label: concept(needId).label, emoji: '', quantity, unit: concept(needId).packLabel, price, status: 'need', ...extra,
});
const purchase = (date: string, total: number, items: PurchaseItem[] = [], extra: Partial<Purchase> = {}): Purchase => ({
  id: `p${++pid}`, createdAt: `${date}T10:00:00Z`, storeName: 'שופרסל', providerId: 'shufersal', total, items, dealsUsed: 0, substitutions: 0, ...extra,
});
const need = (id: string, extra: Partial<HouseholdNeed> = {}): HouseholdNeed => ({
  id, label: concept(id).label, emoji: '', active: true, flexibility: 'brand_flexible', preferredBrands: [], forbiddenBrands: [], hardConstraints: [],
  typical14DayQty: concept(id).base14 || 1, qtySource: 'default', stockConfidence: 0, dealSensitivity: 'medium', wasteRisk: concept(id).wasteRisk,
  removedCount: 0, dismissedDeals: 0, flexConfidence: 0.5, ...extra,
});
const deal = (needId: string, discountPct: number, promoEndsAt?: string): Deal => ({
  id: `d-${needId}`, kind: 'now', needId, label: concept(needId).label, emoji: '', discountPct, why: '', suggestQty: 2, unit: concept(needId).packLabel,
  product: { providerId: 'shufersal', productId: 'x', name: concept(needId).label, price: 20, available: true, source: 'live', fetchedAt: NOW.toISOString(), promoEndsAt },
});
const kind = (xs: { kind: string }[], k: string) => xs.find((x) => x.kind === k) as any;

test('groupOf maps categories', () => {
  assert.equal(groupOf(concept('CHICKEN_BREAST')), 'בשר/דגים');
  assert.equal(groupOf(concept('MILK')), 'מקרר');
  assert.equal(groupOf(concept('TUNA')), 'מזווה');
  assert.equal(groupOf(concept('KIDS_DAIRY')), 'ילד');
  assert.equal(groupOf(customConcept('CUSTOM_1', 'משהו')), 'אחר');
});

test('1: no history — nothing invented', () => {
  const i = input();
  const s = spending(i);
  assert.equal(kind(s, 'month_spend').confidence, 'observed');
  assert.match(kind(s, 'month_spend').text, /החודש עוד לא נרשמו קניות/);
  assert.equal(kind(s, 'last_shop').confidence, 'insufficient');
  assert.equal(kind(s, 'avg_shop').confidence, 'insufficient');
  assert.equal(kind(s, 'monthly_avg').confidence, 'insufficient');
  assert.equal(categoryMix(i).insight.confidence, 'insufficient');
  assert.equal(kind(rhythm(i), 'interval').confidence, 'insufficient');
  assert.equal(kind(rhythm(i), 'since_last'), undefined);
  assert.equal(depletion(i).confidence, 'insufficient');
  assert.equal(recommendNextShop(i).confidence, 'insufficient');
  assert.equal(weekdayPattern(i).confidence, 'insufficient');
  const sv = savings(i);
  assert.deepEqual([sv.saved, sv.estimated, sv.potential], [0, 0, 0]);
  assert.equal(sv.insights[0].confidence, 'insufficient');
  assert.deepEqual(consumption(i), []);
});

test('2: one shop', () => {
  const i = input({ purchases: [purchase('2026-10-02', 380.4)] });
  const s = spending(i);
  assert.equal(kind(s, 'month_spend').value, 380.4);
  assert.match(kind(s, 'month_spend').text, /₪380/);
  assert.equal(kind(s, 'last_shop').confidence, 'observed');
  assert.match(kind(s, 'avg_shop').text, /צריך לפחות 2 קניות כדי לחשב ממוצע/);
  assert.equal(kind(rhythm(i), 'interval').confidence, 'insufficient');
  assert.equal(kind(rhythm(i), 'since_last').text, 'הקנייה האחרונה הייתה לפני 5 ימים');
});

test('3: multiple shops — rhythm and monthly spending', () => {
  const ps = [purchase('2026-08-03', 300), purchase('2026-08-17', 320), purchase('2026-09-01', 280), purchase('2026-09-15', 350), purchase('2026-10-02', 380)];
  const i = input({ purchases: ps });
  const iv = kind(rhythm(i), 'interval');
  assert.equal(iv.confidence, 'observed');
  assert.equal(iv.value, 15);
  const s = spending(i);
  assert.equal(kind(s, 'month_spend').value, 380);
  assert.equal(kind(s, 'last_month').value, 630);
  assert.match(kind(s, 'last_month').text, /בחודש שעבר ₪630/);
  assert.equal(kind(s, 'monthly_avg').confidence, 'insufficient');
  assert.equal(kind(s, 'avg_shop').value, 326);

  const s2 = spending(input({ purchases: [purchase('2026-07-05', 310), ...ps] }));
  assert.equal(kind(s2, 'monthly_avg').confidence, 'observed');
  assert.equal(kind(s2, 'monthly_avg').value, 625);

  // Two shops → single gap, estimated
  const two = rhythm(input({ purchases: ps.slice(0, 2) }));
  assert.equal(kind(two, 'interval').confidence, 'observed', 'a measured gap is a fact, labelled as not yet a rhythm');
  assert.match(kind(two, 'interval').text, /בין שתי הקניות עברו 14 ימים/);
});

test('4: category aggregation', () => {
  const p = purchase('2026-09-20', 400, [
    item('CHICKEN_BREAST', 1, 39.9), item('SALMON', 2, 45), item('MILK', 4, 6.5), item('EGGS', 2, 11.9), item('BAMBA', 2, 9.9),
    item('KIDS_DAIRY', 1, 14), item('LAUNDRY_SOFTENER', 1, 18.8), item('CUSTOM_x', 1, undefined, { label: 'משהו' }),
  ], { deliveryFee: 29.9 });
  const old = purchase('2026-05-01', 999, [item('COLA_ZERO', 10, 50)]);
  const { rows, insight } = categoryMix(input({ purchases: [p, old] }));
  const amt = Object.fromEntries(rows.map((r) => [r.group, r.amount]));
  assert.deepEqual(amt, { 'בשר/דגים': 129.9, 'מקרר': 49.8, 'חטיפים': 19.8, 'בית/ניקיון': 18.8, 'ילד': 14 });
  assert.equal(rows[0].group, 'בשר/דגים');
  assert.equal(insight.confidence, 'observed'); // 7/8 priced
  assert.match(insight.text, /בשר\/דגים/);
  assert.match(insight.text, /לא כולל משלוח/);
  assert.ok(Math.abs(rows.reduce((s, r) => s + r.share, 0) - 1) < 1e-9);

  // Fewer than 80% priced → estimated
  const q = purchase('2026-09-20', 50, [item('MILK', 1, 6.5), item('EGGS', 1), item('BAMBA', 1)]);
  assert.equal(categoryMix(input({ purchases: [q] })).insight.confidence, 'estimated');
});

test('5: savings — store choice, promo, substitution, demo', () => {
  const store = (extra: Partial<Purchase> = {}, total = 380.4, fresh = true) =>
    purchase('2026-10-02', total, [], {
      atPurchase: { fresh, chosenTotal: 380.4, chosenCompleteness: 1, nextBest: { providerId: 'ramilevy', providerName: 'רמי לוי', total: 403.4, completeness: 0.98 } },
      priceSource: 'live', deliveryFeeEstimated: false, ...extra,
    });
  let s = savings(input({ purchases: [store()] }));
  assert.equal(s.saved, 23);
  assert.equal(s.estimated, 0);
  assert.match(s.insights[0].text, /חסכתם ₪23 \(נמדד מול ההצעה הבאה בתור\)/);

  s = savings(input({ purchases: [store({ priceSource: 'estimate' })] }));
  assert.deepEqual([s.saved, s.estimated], [0, 23]);
  assert.match(s.insights.map((x) => x.text).join(' '), /חיסכון משוער ₪23/);

  s = savings(input({ purchases: [store({ deliveryFeeEstimated: true })] }));
  assert.deepEqual([s.saved, s.estimated], [0, 23]);

  s = savings(input({ purchases: [store({}, 380.4, false)] }));
  assert.deepEqual([s.saved, s.estimated], [0, 0]);
  assert.equal(s.insights[0].confidence, 'insufficient');
  assert.match(s.insights[0].text, /עדיין אין חיסכון שאפשר למדוד/);

  s = savings(input({ purchases: [store({}, 450)] }));
  assert.deepEqual([s.saved, s.estimated], [0, 0]);

  // promo
  s = savings(input({ purchases: [purchase('2026-10-02', 50, [item('BAMBA', 2, 9.9, { regularPrice: 14.2 })])] }));
  assert.equal(s.saved, 8.6);
  s = savings(input({ purchases: [purchase('2026-10-02', 50, [item('BAMBA', 2, 9.9, { regularPrice: 14.2, promoMinQty: 3 })])] }));
  assert.equal(s.saved, 0);

  // substitution
  s = savings(input({ purchases: [purchase('2026-10-02', 50, [item('LAUNDRY_SOFTENER', 1, 18.8, { usualPrice: 22, usualProductName: 'בדין' })])] }));
  assert.deepEqual([s.saved, s.estimated], [0, 3.2]);

  // demo → nothing
  s = savings(input({
    purchases: [
      store({ priceSource: 'demo' }),
      purchase('2026-10-02', 50, [item('BAMBA', 2, 9.9, { regularPrice: 14.2 }), item('LAUNDRY_SOFTENER', 1, 18.8, { usualPrice: 22 })], { priceSource: 'demo' }),
    ],
  }));
  assert.deepEqual([s.saved, s.estimated], [0, 0]);

  // a measured store-choice gap already contains this basket's promos and substitutions — never counted twice
  s = savings(input({ purchases: [store({ items: [item('BAMBA', 2, 9.9, { regularPrice: 14.2 }), item('LAUNDRY_SOFTENER', 1, 18.8, { usualPrice: 22 })] })] }));
  assert.deepEqual([s.saved, s.estimated], [23, 0]);
  // demo deals never become "potential"
  s = savings(input({ deals: [{ ...deal('TUNA', 0.3), product: { ...deal('TUNA', 0.3).product, source: 'demo' } }] }));
  assert.equal(s.potential, 0);

  // potential from current deals, never added to saved
  s = savings(input({ deals: [deal('TUNA', 0.3)] }));
  assert.equal(s.potential, 12);
  assert.equal(s.saved, 0);
  assert.match(s.insights.map((x) => x.text).join(' '), /אפשר לחסוך עכשיו ~₪12 במבצעים/);
});

test('6: next shop recommendation', () => {
  const needs = [
    need('MILK', { typical14DayQty: 5, currentStockEstimate: 2.5, stockAsOf: '2026-10-05T09:00:00Z', stockConfidence: 0.8, wasteRisk: 'high' }),
    need('EGGS', { typical14DayQty: 31, currentStockEstimate: 20, stockAsOf: '2026-10-05T09:00:00Z', stockConfidence: 0.8, wasteRisk: 'medium' }),
  ];
  const dep = depletion(input({ needs }));
  assert.equal(dep.basis, 'stock');
  assert.equal(dep.date, '2026-10-11');
  assert.deepEqual(dep.drivers, ['חלב']);

  let r = recommendNextShop(input({ needs }));
  assert.equal(r.confidence, 'estimated');
  assert.equal(r.date, '2026-10-11');

  r = recommendNextShop(input({ needs, deals: [deal('TUNA', 0.3, '2026-10-09')] }));
  assert.equal(r.date, '2026-10-09');
  assert.match(r.text, /מסתיים/);

  r = recommendNextShop(input({ needs, deals: [deal('TUNA', 0.3, '2026-10-05')] }));
  assert.equal(r.date, '2026-10-11');

  // not shelf-stable or small discount → ignored
  r = recommendNextShop(input({ needs, deals: [deal('MILK', 0.3, '2026-10-09'), deal('TUNA', 0.1, '2026-10-09')] }));
  assert.equal(r.date, '2026-10-11');

  // unknown end
  r = recommendNextShop(input({ needs, deals: [deal('TUNA', 0.3)] }));
  assert.equal(r.date, '2026-10-11');
  assert.match(r.text, /לא ידוע עד מתי המבצע/);

  // fresh delivery windows only
  r = recommendNextShop(input({ needs, delivery: [{ providerId: 'shufersal', deliveryStatus: 'confirmed', source: 'provider_page', checkedAt: '2026-10-07T06:00:00Z', deliveryWindows: ['ב׳ 10:00-12:00'] }] }));
  assert.match(r.text, /חלונות משלוח/);
  r = recommendNextShop(input({ needs, delivery: [{ providerId: 'shufersal', deliveryStatus: 'confirmed', source: 'provider_page', checkedAt: '2026-10-05T06:00:00Z', deliveryWindows: ['ב׳ 10:00-12:00'] }] }));
  assert.doesNotMatch(r.text, /חלונות משלוח/);

  // >50% unknown → rhythm fallback
  const fallbackNeeds = [needs[0], need('TUNA'), need('BAMBA')];
  const ps = [purchase('2026-09-01', 300), purchase('2026-09-15', 300), purchase('2026-10-01', 300)];
  const d2 = depletion(input({ needs: fallbackNeeds, purchases: ps }));
  assert.equal(d2.basis, 'rhythm');
  assert.equal(d2.confidence, 'estimated');
  assert.equal(d2.date, '2026-10-16');
  const r2 = recommendNextShop(input({ needs: fallbackNeeds, purchases: ps }));
  assert.equal(r2.date, '2026-10-16');
  assert.equal(r2.confidence, 'estimated');
  // no purchases → shopEveryDays doesn't help without a last shop
  assert.equal(depletion(input({ needs: fallbackNeeds })).confidence, 'insufficient');
});

// ---------- weekday snapshots ----------
const WEEK_NEEDS = ['MILK', 'EGGS', 'TUNA', 'BAMBA', 'PASTA', 'COLA_ZERO'];
const BASE: Record<string, number> = { MILK: 6.5, EGGS: 12, TUNA: 20, BAMBA: 10, PASTA: 5, COLA_ZERO: 30 };
function isoWeek(ld: string): string {
  const d = new Date(ld + 'T00:00:00Z');
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const y = d.getUTCFullYear();
  const wk = Math.ceil(((d.getTime() - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
  return `${y}-W${String(wk).padStart(2, '0')}`;
}
function snapDay(ld: string, factor: (needIdx: number) => number, source: PriceSnapshot['source'] = 'live'): PriceSnapshot[] {
  const wd = new Date(ld + 'T00:00:00Z').getUTCDay();
  return WEEK_NEEDS.map((n, k) => ({ localDate: ld, weekday: wd, weekKey: isoWeek(ld), providerId: 'shufersal', needId: n, unitPrice: +(BASE[n] * factor(k)).toFixed(3), deliveryFeeKnown: true, source }));
}
const addD = (ld: string, n: number) => new Date(Date.parse(ld + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
// Sundays of 5 weeks before now: 2026-08-30 … 2026-09-27 (Sun), Tue = +2, Thu = +4
const SUNDAYS = ['2026-08-30', '2026-09-06', '2026-09-13', '2026-09-20', '2026-09-27'];
const PLAN: [number, number[]][] = [[0, [0, 2]], [1, [4, 0]], [2, [2, 4]], [3, [0]], [4, [2, 4]]]; // week → weekday offsets
function fiveWeeks(f: (wd: number, dateIdx: number, needIdx: number) => number, source: PriceSnapshot['source'] = 'live', skipTue = false) {
  const out: PriceSnapshot[] = [];
  let di = 0;
  for (const [w, offs] of PLAN) {
    for (const o of offs) {
      if (skipTue && o === 2 && w !== 0) continue;
      const ld = addD(SUNDAYS[w], o);
      const idx = di++;
      out.push(...snapDay(ld, (k) => f(o, idx, k), source));
    }
  }
  return out;
}

test('7: weekday — insufficient history', () => {
  const three = fiveWeeks(() => 1).filter((s) => s.weekKey >= '2026-W37'); // W37, W38, W40
  const w = weekdayPattern(input({ snapshots: three }));
  assert.equal(w.confidence, 'insufficient');
  assert.match(w.text, /יש מחירים מ־3 שבועות, צריך לפחות 4/);

  const oneTue = fiveWeeks((wd) => (wd === 2 ? 0.95 : 1), 'live', true);
  const w2 = weekdayPattern(input({ snapshots: oneTue }));
  assert.equal(w2.confidence, 'insufficient');
});

test('8: weekday — enough data', () => {
  const tueCheap = fiveWeeks((wd) => (wd === 2 ? 0.95 : 1));
  const w = weekdayPattern(input({ snapshots: tueCheap }));
  assert.equal(w.confidence, 'estimated');
  assert.equal(w.weekday, 2);
  assert.match(w.text, /בחמשת השבועות האחרונים סל דומה היה זול יותר ביום ג׳ \(בכ־5%\)/);
  assert.match(w.text, /רק כשקניתי בודקת מחירים/);

  const noise = fiveWeeks((_wd, di, k) => 1 + (((di * 7 + k * 3) % 3) - 1) * 0.01);
  const w2 = weekdayPattern(input({ snapshots: noise }));
  assert.equal(w2.confidence, 'observed');
  assert.match(w2.text, /לא ראיתי הבדל עקבי בין ימים/);

  const demo = fiveWeeks((wd) => (wd === 2 ? 0.95 : 1), 'demo');
  assert.equal(weekdayPattern(input({ snapshots: demo })).confidence, 'insufficient');

  // Weekday hint lands in next-shop text only when the day falls in [date−2, date]
  const needs = [
    need('MILK', { typical14DayQty: 5, currentStockEstimate: 2.5, stockAsOf: '2026-10-05T09:00:00Z', stockConfidence: 0.8, wasteRisk: 'high' }),
    need('EGGS', { typical14DayQty: 31, currentStockEstimate: 20, stockAsOf: '2026-10-05T09:00:00Z', stockConfidence: 0.8 }),
  ];
  // date 10-11 (Sun): window 10-09..10-11 has no Tuesday
  assert.doesNotMatch(recommendNextShop(input({ needs, snapshots: tueCheap })).text, /ג׳ יוצא/);
  const sun = (wd: number) => (wd === 0 ? 0.95 : 1);
  assert.match(recommendNextShop(input({ needs, snapshots: fiveWeeks(sun) })).text, /יום א׳ יוצא קצת יותר זול.*11\/10/);
});

test('9: consumption', () => {
  const ev = (type: LearningEvent['type'], needId: string, value: unknown, date = '2026-09-20'): LearningEvent => ({ type, needId, value, createdAt: `${date}T10:00:00Z` });
  // ran out twice → runs faster
  let c = consumption(input({ needs: [need('EGGS')], events: [ev('quantity_feedback', 'EGGS', 'ran_out'), ev('quantity_changed', 'EGGS', { reason: 'ran_out_early', newTypical: 30 })] }));
  assert.equal(kind(c, 'runs_faster').confidence, 'observed');
  assert.match(kind(c, 'runs_faster').text, /ביצים נגמרים אצלכם מהר יותר ממה שהערכתי/);
  // only once, or too old → nothing
  c = consumption(input({ needs: [need('EGGS')], events: [ev('quantity_feedback', 'EGGS', 'ran_out'), ev('quantity_feedback', 'EGGS', 'ran_out', '2026-03-01')] }));
  assert.equal(kind(c, 'runs_faster'), undefined);
  // purchase feedback + stock_report qty 0 count too
  c = consumption(input({ needs: [need('EGGS')], purchases: [purchase('2026-09-10', 10, [], { feedback: { EGGS: 'ran_out' } })], events: [ev('stock_report', 'EGGS', { qty: 0, raw: 'נגמר' })] }));
  assert.ok(kind(c, 'runs_faster'));

  // too much
  c = consumption(input({ needs: [need('BAMBA', { removedCount: 2 })] }));
  assert.equal(kind(c, 'too_much').confidence, 'observed');
  c = consumption(input({ needs: [need('BAMBA')], events: [ev('quantity_feedback', 'BAMBA', 'too_much'), ev('quantity_changed', 'BAMBA', { reason: 'left_over' })] }));
  assert.ok(kind(c, 'too_much'));

  // lasts — softener
  const soft = ['2026-07-01', '2026-08-05', '2026-09-08', '2026-10-02'].map((d) => purchase(d, 50, [item('LAUNDRY_SOFTENER', 1, 18.8)]));
  c = consumption(input({ needs: [need('LAUNDRY_SOFTENER')], purchases: soft }));
  const l = kind(c, 'lasts');
  assert.equal(l.confidence, 'observed');
  assert.equal(l.value, 31);
  assert.equal(l.text, 'מרכך כביסה מחזיק אצלכם בממוצע כחודש (31 ימים לבקבוק)');
  assert.equal(kind(c, 'fastest').needId, 'LAUNDRY_SOFTENER');
  // 3 purchases → estimated
  c = consumption(input({ needs: [need('LAUNDRY_SOFTENER')], purchases: soft.slice(1) }), 'LAUNDRY_SOFTENER');
  assert.equal(kind(c, 'lasts').confidence, 'estimated');
  // 2 purchases → insufficient (only reported when asked for that need)
  c = consumption(input({ needs: [need('LAUNDRY_SOFTENER')], purchases: soft.slice(2) }), 'LAUNDRY_SOFTENER');
  assert.equal(kind(c, 'lasts').confidence, 'insufficient');
  assert.match(kind(c, 'lasts').text, /עדיין אין מספיק קניות של מרכך כביסה/);
  assert.equal(kind(consumption(input({ needs: [need('LAUNDRY_SOFTENER')], purchases: soft.slice(2) })), 'lasts'), undefined);

  // can skip — tuna bought big last time
  const tuna = need('TUNA', { typical14DayQty: 8, currentStockEstimate: 12, stockAsOf: '2026-10-07T09:00:00Z', stockConfidence: 0.5 });
  const tunaBuy = purchase('2026-10-02', 60, [item('TUNA', 3, 20, { status: 'opportunity' })]);
  c = consumption(input({ needs: [tuna], purchases: [tunaBuy] }));
  assert.equal(kind(c, 'can_skip').confidence, 'estimated');
  assert.match(kind(c, 'can_skip').text, /קניתם טונה בכמות גדולה בפעם הקודמת ולכן כנראה אפשר לדלג/);
  // low stock → no skip
  c = consumption(input({ needs: [{ ...tuna, currentStockEstimate: 4 }], purchases: [tunaBuy] }));
  assert.equal(kind(c, 'can_skip'), undefined);
});

test('answer() returns Hebrew for every question with empty input', () => {
  const i = input();
  const r = buildInsights(i);
  const qs: InsightQuestion[] = ['spend_month', 'top_category', 'savings', 'when_shop', 'fastest', 'overbuy', 'cheap_day', 'lasts'];
  for (const q of qs) {
    const a = answer(q, r, i);
    assert.ok(a.length > 5, q);
    assert.match(a, /[֐-׿]/, q);
  }
  assert.match(answer('spend_month', r, i), /החודש עוד לא נרשמו קניות/);
  assert.match(answer('savings', r, i), /עדיין אין חיסכון/);
  assert.match(answer('overbuy', r, i), /אין מספיק/);
  assert.match(answer('lasts', r, i, 'MILK'), /עדיין אין מספיק קניות של חלב/);
  assert.match(answer('cheap_day', r, i), /אין מספיק היסטוריה/);
});

test('answer() with data', () => {
  const needs = [
    need('MILK', { typical14DayQty: 5, currentStockEstimate: 2.5, stockAsOf: '2026-10-05T09:00:00Z', stockConfidence: 0.8, wasteRisk: 'high' }),
    need('LAUNDRY_SOFTENER'),
  ];
  const purchases = ['2026-07-01', '2026-08-05', '2026-09-08', '2026-10-02'].map((d) => purchase(d, 100, [item('LAUNDRY_SOFTENER', 1, 18.8), item('CHICKEN_BREAST', 1, 40)]));
  const i = input({ needs, purchases });
  const r = buildInsights(i);
  assert.match(answer('when_shop', r, i), /^הערכה: /);
  assert.match(answer('top_category', r, i), /בשר\/דגים/);
  assert.match(answer('lasts', r, i, 'LAUNDRY_SOFTENER'), /31 ימים לבקבוק/);
  assert.match(answer('fastest', r, i), /הכי מהר/);
  assert.equal(answer('overbuy', r, i), 'לא ראיתי משהו שאתם קונים יותר מדי');
  assert.match(answer('spend_month', r, i), /₪100/);
});

test('answer(): last month and last shop are answered for what was asked', () => {
  const ps = [purchase('2026-09-10', 300), purchase('2026-09-24', 250), purchase('2026-10-02', 380)];
  const i = input({ purchases: ps });
  const r = buildInsights(i);
  assert.match(answer('spend_last_month', r, i), /בחודש שעבר \(09\/2026\) נרשמו 2 קניות — ₪550/);
  assert.match(answer('last_shop', r, i), /₪380/);
  assert.match(answer('spend_last_month', buildInsights(input()), input()), /לא נרשמו/);
});
