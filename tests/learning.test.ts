// Unit tests: inventory math, temporary vs permanent intent, learning rules, provider ranking.
process.env.KANITI_DB = ':memory:';
process.env.KANITI_DEMO = '1';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Basket, BasketQuote } from '../shared/types.ts';
const { store } = await import('../server/db.ts');
const { advanceDays } = await import('../server/clock.ts');
const S = await import('../server/state.ts');
const { parseMessage } = await import('../server/chat/parser.ts');
const { executeActions } = await import('../server/chat/execute.ts');
const svc = await import('../server/service.ts');
const { rankQuotes } = await import('../server/engine/compare.ts');

beforeEach(() => {
  store.reset();
  S.completeOnboarding({
    adults: 2, children: [{ age: 2 }], kosher: true, dairyAllergy: true, dairyAllergyWho: 'kids', vegetarian: false,
    address: { city: 'רמת גן' }, onlineProviders: ['shufersal', 'tivtaam'], physicalStores: [],
    flex: { COLA_ZERO: 'strict', LAUNDRY_SOFTENER: 'deal', CREAM_CHEESE: 'any' },
    staples: ['EGGS', 'TUNA', 'CREAM_CHEESE', 'KIDS_DAIRY', 'COLA_ZERO', 'LAUNDRY_SOFTENER', 'CHOCO_SPREAD', 'CHICKEN_BREAST'], customStaples: [], threshold: 60,
  });
});
const say = (t: string) => executeActions(parseMessage(t));

test('child dairy allergy: dairy-free desserts replace dairy desserts; adults keep dairy; shared spread must be parve', () => {
  assert.equal(store.need('DAIRY_FREE_DESSERT')!.active, true);
  assert.ok(store.need('DAIRY_FREE_DESSERT')!.hardConstraints.includes('ללא חלב'));
  assert.equal(store.need('KIDS_DAIRY')!.neverSuggest, true);
  assert.equal(store.need('CREAM_CHEESE')!.active, true, 'adults still buy cream cheese');
  assert.deepEqual(store.need('CREAM_CHEESE')!.hardConstraints, []);
  assert.ok(store.need('CHOCO_SPREAD')!.hardConstraints.includes('ללא חלב'));
});

test('inventory math: stock decays with consumption; purchases add', () => {
  S.setStock('EGGS', 30, 0.95);
  const t = store.need('EGGS')!.typical14DayQty;
  advanceDays(7);
  const est = S.estimateStock(store.need('EGGS')!);
  assert.ok(Math.abs(est.qty - (30 - t / 2)) < 0.6, `${est.qty}`);
  assert.ok(est.confidence < 0.95 && est.confidence > 0.5);
});

test('ran out earlier than expected → consumption goes up; lots left → goes down', () => {
  S.setStock('TUNA', 10, 0.95);
  const t0 = store.need('TUNA')!.typical14DayQty;
  advanceDays(2);
  S.setStock('TUNA', 0, 0.95);
  const t1 = store.need('TUNA')!.typical14DayQty;
  assert.ok(t1 > t0, `${t0} → ${t1}`);
  S.setStock('TUNA', 0, 0.95);
  advanceDays(10);
  S.setStock('TUNA', 12, 0.95);
  assert.ok(store.need('TUNA')!.typical14DayQty < t1);
});

test('temporary vs permanent', async () => {
  await say('#build 14 force');
  await say('אל תקנה גבינת שמנת הפעם');
  assert.equal(store.need('CREAM_CHEESE')!.active, true, 'temporary skip keeps the habit');
  assert.ok(store.basket()!.tempSkips.includes('CREAM_CHEESE'));
  await say('לא אכפת לי איזה מרכך');
  assert.equal(store.need('LAUNDRY_SOFTENER')!.flexibility, 'category_flexible', 'permanent');
  await say('הפעם אני רוצה סלמון');
  assert.ok(store.basket()!.items.some((i) => i.needId === 'SALMON'));
  assert.equal(store.need('SALMON')!.active, false, '"this time" does not make salmon a staple');
});

test('"אל תציע את המותג הזה" applies to the item just discussed', async () => {
  await say('#build 14 force');
  const it = store.basket()!.items.find((i) => i.needId === 'LAUNDRY_SOFTENER');
  await say('למה בחרת במרכך?');
  await say('אל תציע את המותג הזה');
  const n = store.need('LAUNDRY_SOFTENER')!;
  if (it?.product) assert.ok(n.forbiddenBrands.length > 0 || n.lastProductName !== it.product.name);
});

test('restoring the usual product twice → strict; switching brands 3x → flexible', () => {
  let r = S.learnFromReplacement('COLA_ZERO', 'פפסי מקס', 'קוקה קולה זירו 6*1.5', 'קוקה קולה', true);
  S.updateNeed('COLA_ZERO', { flexibility: 'brand_flexible', flexConfidence: 0.5 });
  r = S.learnFromReplacement('COLA_ZERO', 'פפסי מקס', 'קוקה קולה זירו 6*1.5', 'קוקה קולה', true);
  assert.equal(r.inferred, 'strict');
  assert.equal(store.need('COLA_ZERO')!.flexibility, 'exact_product');
  S.updateNeed('LAUNDRY_SOFTENER', { flexibility: 'brand_flexible', flexConfidence: 0.5 });
  S.learnFromReplacement('LAUNDRY_SOFTENER', 'בדין', 'סנו', 'סנו');
  S.learnFromReplacement('LAUNDRY_SOFTENER', 'סנו', 'מקסימה', 'מקסימה');
  r = S.learnFromReplacement('LAUNDRY_SOFTENER', 'מקסימה', 'בדין', 'בדין');
  assert.equal(r.inferred, 'flexible');
  assert.equal(store.need('LAUNDRY_SOFTENER')!.flexibility, 'category_flexible');
});

test('repeated removals lower expected consumption', () => {
  const t0 = store.need('TUNA')!.typical14DayQty;
  S.learnFromRemoval('TUNA', true);
  S.learnFromRemoval('TUNA', true);
  assert.ok(store.need('TUNA')!.typical14DayQty < t0);
});

// ---------- ranking ----------
const line = (needId: string, total: number, missing = false) => ({ needId, label: needId, quantity: 1, lineTotal: missing ? 0 : total, missing, product: missing ? undefined : { providerId: 'x', productId: needId, name: needId, price: total, available: true, source: 'live' as const, fetchedAt: '' } });
const q = (id: string, kind: 'online' | 'physical', lines: ReturnType<typeof line>[], fee = 30): BasketQuote => {
  const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
  return { providerId: id, providerName: id, kind, ok: true, lines, subtotal, deliveryFee: kind === 'online' ? fee : 0, total: subtotal + (kind === 'online' ? fee : 0), completeness: lines.filter((l) => !l.missing).length / lines.length, unavailableCount: lines.filter((l) => l.missing).length, substitutionsCount: 0, source: 'live', fetchedAt: '' };
};
const basket = { items: [{ needId: 'A', product: { price: 100 } }, { needId: 'B', product: { price: 100 } }, { needId: 'C', product: { price: 50 } }] } as unknown as Basket;

test('ranking: a cheaper basket with missing items does not win by omission', () => {
  const full = q('full', 'online', [line('A', 100), line('B', 100), line('C', 50)]);
  const holey = q('holey', 'online', [line('A', 95), line('B', 0, true), line('C', 45)]);
  const { ordered } = rankQuotes([holey, full], basket, 60);
  assert.equal(ordered[0].providerId, 'full');
});

test('ranking: a store missing a hard-constraint item ranks below', () => {
  const ok = q('ok', 'online', [line('A', 120), line('B', 110), line('C', 60)]);
  const noDairyFree = q('cheap', 'online', [line('A', 50), line('B', 50), line('C', 0, true)]);
  const { ordered } = rankQuotes([noDairyFree, ok], basket, 60, ['C']);
  assert.equal(ordered[0].providerId, 'ok');
});

test('ranking: physical store wins only above the driving threshold', () => {
  const online = q('online', 'online', [line('A', 200), line('B', 200), line('C', 100)], 30); // 530
  const nearSaving = q('branch', 'physical', [line('A', 190), line('B', 190), line('C', 100)]); // 480 → saves 50
  let r = rankQuotes([online, nearSaving], basket, 60);
  assert.equal(r.recommendation.kind, 'online');
  const bigSaving = q('branch', 'physical', [line('A', 170), line('B', 170), line('C', 90)]); // 430 → saves 100
  r = rankQuotes([online, bigSaving], basket, 60);
  assert.equal(r.recommendation.kind, 'physical');
});
