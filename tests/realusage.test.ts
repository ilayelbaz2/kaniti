// Regressions for what real usage exposed: product identity, Deals volume/honesty, manual add, staples, savings data.
process.env.KANITI_DB = ':memory:';
process.env.KANITI_DEMO = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProductSearchResult } from '../shared/types.ts';
const { productTitle, productLine, productSize, identityGaps, cleanBrand } = await import('../shared/product.ts');
const { completeOnboarding } = await import('../server/state.ts');
const svc = await import('../server/service.ts');
const { store, kvSet } = await import('../server/db.ts');
const { dealSections } = await import('../server/engine/deals.ts');
const { compareBasket } = await import('../server/engine/compare.ts');

// ---------- product identity ----------
test('identity: brand + name + size, without repeating what the name already says', () => {
  assert.equal(productLine({ name: 'מרכך כביסה מרוכז כחול', brand: 'לנור', sizeText: '819 מ״ל' }), 'לנור מרכך כביסה מרוכז כחול · 819 מ״ל');
  assert.equal(productTitle({ name: 'לנור מרכך כביסה כחול', brand: 'לנור' }), 'לנור מרכך כביסה כחול');
  assert.equal(productTitle({ name: 'טונה בשמן', brand: 'General' }), 'טונה בשמן', 'placeholder brands are dropped');
  assert.equal(cleanBrand('כללי'), undefined);
  assert.equal(productSize({ name: 'פסטה פנה 500 גרם', sizeText: '500 גרם' }), undefined, 'size already in the name');
  assert.match(productLine({ name: 'פרגיות עוף', brand: 'עוף טוב', byWeight: true, price: 39.9 }), /עוף טוב פרגיות עוף · נמכר לפי משקל/);
  assert.deepEqual(identityGaps({ name: 'מרכך כביסה כחול מרוכז' }), { ambiguous: true, missing: ['brand', 'size'] });
  assert.equal(identityGaps({ name: 'מרכך כביסה כחול', sizeText: '1 ליטר' }).ambiguous, false);
});

// ---------- household with demo prices ----------
completeOnboarding({ adults: 2, children: [{ age: 2 }], kosher: true, dairyAllergy: true, dairyAllergyWho: 'kids', vegetarian: false, address: { city: 'רמת גן', street: 'ביאליק 12' },
  onlineProviders: ['shufersal', 'ramilevy', 'tivtaam', 'victory'], physicalStores: [], flex: { COLA_ZERO: 'strict', LAUNDRY_SOFTENER: 'deal', CREAM_CHEESE: 'any' },
  staples: [], customStaples: [{ label: 'חרדל', level: 'sometimes' }], threshold: 60,
  stapleLevels: { EGGS: 'always', BREAD: 'always', TUNA: 'always', CREAM_CHEESE: 'always', YELLOW_CHEESE: 'always', COLA_ZERO: 'always', SODA: 'sometimes', PASTA: 'always', BAMBA: 'always',
    CHICKEN_BREAST: 'always', SALMON: 'sometimes', LAUNDRY_SOFTENER: 'always', VANISH: 'always', TOMATOES: 'always', CUCUMBERS: 'always', ONIONS: 'no' } });

test('staples: always / sometimes / not-us / custom are stored separately from buying frequency', () => {
  assert.equal(store.need('EGGS')!.staple, 'always');
  assert.equal(store.need('SODA')!.staple, 'sometimes');
  assert.equal(store.need('ONIONS')!.neverSuggest, true);
  assert.equal(store.need('ONIONS')!.active, false);
  const mustard = store.needs().find((n) => n.label === 'חרדל')!;
  assert.equal(mustard.staple, 'sometimes');
  assert.ok(store.need('VANISH')!.typical14DayQty < 1, 'Vanish is a staple, but its usage stays low (not bought every 14 days)');
});

test('deals: many relevant offers across chains, each need once, every card identifies the product', async () => {
  await svc.buildBasket(14);
  const r = await svc.getDeals();
  assert.ok(r.deals.length >= 8, `expected a browseable set, got ${r.deals.length}`);
  assert.ok(new Set(r.deals.map((d) => d.product.providerId)).size >= 2, 'not limited to one reference chain');
  assert.equal(new Set(r.deals.map((d) => d.needId)).size, r.deals.length, 'each need appears once');
  for (const d of r.deals) {
    assert.ok(!identityGaps(d.product).ambiguous, `identity for ${d.product.name}`);
    assert.ok(d.providerName && d.why);
    if (d.kind === 'anyway') assert.ok(!/מבצע/.test(d.why), '"anyway" never claims a promotion');
  }
  assert.ok(r.deals.filter((d) => d.kind === 'discovery').length <= 4, 'discovery stays restrained');
});

test('deals: no padding — prices without any real discount give zero deals and an honest note', () => {
  const plain = (providerId: string, needId: string, price: number): ProductSearchResult => ({ providerId, productId: `${providerId}-${needId}`, name: `${needId} מותג 500 גרם`, brand: 'מותג', sizeText: '500 גרם', price, available: true, source: 'live', fetchedAt: '' });
  const book = { perProvider: new Map([['a', new Map([['TUNA', [plain('a', 'TUNA', 10)]]])], ['b', new Map([['TUNA', [plain('b', 'TUNA', 10)]]])]]) };
  const r = dealSections(book, { a: 'A', b: 'B' });
  assert.equal(r.deals.length, 0);
  assert.match(r.note!, /לא אמציא מבצעים/);
});

test('deal → basket adds exactly that product from that chain', async () => {
  const { deals } = await svc.getDeals();
  const d = deals.find((x) => x.kind !== 'discovery')!;
  await svc.addItem({ needId: d.needId, quantity: d.suggestQty, product: { providerId: d.product.providerId, productId: d.product.productId } });
  const it = store.basket()!.items.find((i) => i.needId === d.needId)!;
  assert.equal(it.product!.providerId, d.product.providerId);
  assert.equal(it.product!.productId, d.product.productId);
  assert.equal(it.lockedByUser, true);
  assert.equal(it.quantity, d.suggestQty);
});

// ---------- manual add / search ----------
test('search: a known need and a promo badge; exact add is locked; generic add lets Kaniti choose', async () => {
  const r = await svc.searchProducts('מרכך כביסה');
  assert.equal(r.concept?.id, 'LAUNDRY_SOFTENER');
  assert.ok(r.results.length >= 2);
  assert.ok(r.results.every((x) => x.providerName && x.price > 0));
  assert.ok(r.results.some((x) => x.promoPrice || x.promoText), 'promotions are visible in results');
  const pick = r.results[r.results.length - 1];
  await svc.addItem({ needId: 'LAUNDRY_SOFTENER', quantity: 3, product: { providerId: pick.providerId, productId: pick.productId } });
  let it = store.basket()!.items.find((i) => i.needId === 'LAUNDRY_SOFTENER')!;
  assert.equal(it.product!.productId, pick.productId);
  assert.equal(it.quantity, 3);
  await svc.addItem({ needId: 'PASTA', quantity: 2 });
  it = store.basket()!.items.find((i) => i.needId === 'PASTA')!;
  assert.ok(it.product && !it.lockedByUser, 'generic: Kaniti picks');
});

test('search: unknown text with no matches returns nothing (never a random product)', async () => {
  const r = await svc.searchProducts('קסדת אופנוע');
  assert.equal(r.results.length, 0);
  assert.equal(r.concept, undefined);
});

// ---------- purchase records what savings need ----------
test('a purchase after a comparison records the next-best quote, promos used and identity', async () => {
  await svc.buildBasket(14);
  const cmp = await compareBasket(store.basket()!);
  const win = cmp.quotes.find((q) => q.ok && q.kind === 'online')!;
  const items = win.lines.filter((l) => !l.missing).map((l) => ({ needId: l.needId, quantity: l.quantity, productName: l.product?.name, price: l.lineTotal / l.quantity }));
  const p = svc.confirmPurchase({ storeName: win.providerName, providerId: win.providerId, total: win.total, items });
  assert.equal(p.atPurchase?.fresh, true);
  assert.equal(p.atPurchase?.chosenTotal, win.total);
  assert.ok(p.atPurchase?.nextBest, 'next-best chain recorded');
  assert.equal(p.priceSource, 'demo', 'demo prices are labelled so they never count as savings');
  assert.ok(p.items.some((i) => i.brand || i.sizeText));
  assert.ok(store.snapshots('2000-01-01').length > 0, 'price history recorded');
  const ins = svc.insights();
  assert.equal(ins.savings.saved, 0, 'demo purchases never produce "saved"');
  kvSet('lastDeals', null);
});

test('insights: potential saving uses the deal percentage correctly (30 = 30%) and never counts as saved', async () => {
  const { savings } = await import('../server/insights.ts');
  const { getConcept } = await import('../server/state.ts');
  const d = { id: 'x', kind: 'now' as const, needId: 'TUNA', label: 'טונה', emoji: '', discountPct: 30, why: '', suggestQty: 2, unit: '', product: { providerId: 'a', productId: '1', name: 'טונה', price: 10, available: true, source: 'live' as const, fetchedAt: '' } };
  const r = savings({ now: new Date(), purchases: [], needs: [], events: [], snapshots: [], deals: [d], delivery: [], concept: getConcept, shopEveryDays: 14 });
  assert.equal(r.potential, 6);
  assert.equal(r.saved, 0);
});

test('matching: long catalogue names with a brand prefix are still clear matches (live Tiv Taam regressions)', async () => {
  const { chooseProduct } = await import('../server/engine/match.ts');
  const { conceptById } = await import('../server/catalog.ts');
  const { newNeed } = await import('../server/state.ts');
  const pick = (id: string, name: string, brand?: string, sizeText?: string) => {
    const c = conceptById.get(id)!;
    return chooseProduct(c, { ...newNeed(c, 2, 1), flexibility: 'category_flexible' }, [{ providerId: 'tivtaam', productId: '1', name, brand, sizeText, price: 20, available: true, source: 'live', fetchedAt: '' }]);
  };
  assert.ok(!pick('COLA_ZERO', 'קוקה- קולה zero מארז שישייה 1.5 ליטר', 'קוקה קולה')!.uncertain);
  assert.ok(!pick('TUNA', 'וילי פוד רביעית נתחי טונה בשמן צמחי 640 גרם', 'וילי פוד')!.uncertain);
  assert.ok(!pick('EGGS', 'ביצי רמות השבים 12 M')!.uncertain, 'eggs are identifiable without a brand');
  assert.ok(!pick('LETTUCE', 'חסה ערבית')!.uncertain, 'produce is identifiable as is');
  assert.ok(!pick('DISHWASHER_TABS', 'ספארק 30 טבליות למדיח', 'ספארק')!.uncertain);
  assert.ok(pick('LAUNDRY_SOFTENER', 'מרכך כביסה כחול מרוכז')!.uncertain, 'a branded-category product with no brand and no size → the user picks');
});
