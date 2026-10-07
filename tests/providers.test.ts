process.env.KANITI_DB = ':memory:';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { parseShufersal } = await import('../server/providers/shufersal.ts');
const { parseRamiLevy } = await import('../server/providers/ramilevy.ts');
const { parseZuz } = await import('../server/providers/zuz.ts');
const { scanPrices } = await import('../server/providers/index.ts');
const { demoProvider } = await import('../server/providers/demo.ts');
const { parseSize } = await import('../server/engine/match.ts');

// Shapes below are copied from the public API documentation of the open-source scrapers (2026).
test('Shufersal JSON → products, multi-buy promo per unit, labelled live', () => {
  const r = parseShufersal({ results: [
    { code: 'P_22', name: 'חלב תנובה מלא 3% שומן', price: { value: 6.9 }, categoryPrice: { value: 6.9 }, brand: { name: 'תנובה' }, unitDescription: '1 ליטר', sellingMethod: { code: 'BY_PACKAGE' } },
    { code: 'P_9', name: 'טונה בשמן', price: { value: 14 }, promotionMsg: "2 יח' ב- 22 ₪" },
  ] as never });
  assert.equal(r.length, 2);
  assert.equal(r[0].source, 'live');
  assert.equal(r[1].promoPrice, 11);
  assert.equal(r[1].promoMinQty, 2);
});

test('Rami Levy catalog → sale price, ignores club-only sales', () => {
  const r = parseRamiLevy({ data: [
    { id: 9360, name: 'קוטג תנובה גביע 250 גרם %5', price: { price: 5.9 }, gs: { BrandName: 'תנובה' }, sale: [], available_in: [331] },
    { id: 1, name: 'מרכך כביסה', price: { price: 20 }, sale: [{ scm: 15, name: '15 ש"ח', is_club: 0 }], available_in: [331] },
    { id: 2, name: 'וניש', price: { price: 30 }, sale: [{ scm: 20, is_club: 1 }], available_in: [331] },
  ] }, 331);
  assert.equal(r[0].brand, 'תנובה');
  assert.equal(r[1].promoPrice, 15);
  assert.equal(r[2].promoPrice, undefined);
});

test('ZuZ (Victory/Yenot Bitan/...) → sale + multi-buy specials', () => {
  const r = parseZuz('victory', { products: [
    { id: 20164375, localName: 'חלב תנובה 3% שומן 1 ליטר', brand: { names: { 1: 'תנובה' } }, branch: { regularPrice: 6.9, salePrice: null, isOutOfStock: false, specials: [] } },
    { id: 5, localName: 'במבה 80 גרם', branch: { regularPrice: 5, specials: [{ names: { 1: { name: '3 ב-12' } }, firstLevel: { type: 2, firstPurchaseTotal: 3, firstGift: { total: 12 } } }] } },
  ] });
  assert.equal(r[0].price, 6.9);
  assert.equal(r[1].promoPrice, 4);
  assert.equal(r[1].promoText, '3 ב-12');
});

test('ZuZ: full long name beats the 20-char localName; size, weight and brand', () => {
  const r = parseZuz('tivtaam', { products: [
    { id: 1, localName: 'פסטה מריה  פסטה ביצי', names: { 1: { short: 'פסטה ביצים', long: 'פסטה מריה פסטה ביצים טליאטלה 500 גרם' } }, brand: { names: { 1: 'פסטה מריה' } }, weight: 500, unitOfMeasure: { names: { 1: 'גרם' } }, branch: { regularPrice: 12.9 } },
    { id: 2, localName: 'חזה עוף טרי', isWeighable: true, brand: { names: { 1: 'כללי' } }, branch: { regularPrice: 39.9 } },
    { id: 3, localName: 'מים מינרליים', weight: 1.5, unitOfMeasure: { names: { 1: 'ליטר' } }, branch: { regularPrice: 3,
      specials: [{ names: { 1: { name: '6 ב-15' } }, endDate: '2026-10-12T20:59:59.000Z', firstLevel: { type: 2, firstPurchaseTotal: 6, firstGift: { total: 15 } } }] } },
  ] });
  assert.equal(r[0].name, 'פסטה מריה פסטה ביצים טליאטלה 500 גרם');
  assert.equal(r[0].brand, 'פסטה מריה');
  assert.equal(r[0].sizeText, '500 גרם');
  assert.equal(r[0].byWeight, undefined);
  assert.equal(r[1].byWeight, true);
  assert.equal(r[1].sizeText, 'לק"ג');
  assert.equal(r[1].brand, undefined, 'placeholder brand dropped');
  assert.equal(r[2].sizeText, '1.5 ליטר');
  assert.equal(r[2].promoPrice, 2.5);
  assert.equal(r[2].promoMinQty, 6);
  assert.equal(r[2].promoEndsAt, '2026-10-12', 'UTC end time → Israel date');
});

test('Shufersal promotion messages → per-unit price', () => {
  const row = (code: string, price: number, promotionMsg: string) => ({ code, name: 'מוצר ' + code, price: { value: price }, promotionMsg });
  const r = parseShufersal({ results: [
    row('a', 10, '1+1'),
    row('b', 12, 'השני ב-50%'),
    row('c', 20, 'השני בחצי מחיר'),
    row('d', 4, '3 ב-10'),
    row('e', 9, '2+1 מתנה'),
    row('f', 10, 'ב-50% הנחה'),
    row('g', 10, '2 ב-50'),
  ] } as never);
  const by = Object.fromEntries(r.map((x) => [x.productId, x]));
  assert.deepEqual([by.a.promoPrice, by.a.promoMinQty], [5, 2]);
  assert.deepEqual([by.b.promoPrice, by.b.promoMinQty], [9, 2]);
  assert.deepEqual([by.c.promoPrice, by.c.promoMinQty], [15, 2]);
  assert.deepEqual([by.d.promoPrice, by.d.promoMinQty], [3.33, 3]);
  assert.deepEqual([by.e.promoPrice, by.e.promoMinQty], [6, 3]);
  assert.equal(by.f.promoPrice, undefined, 'a bare percentage is not a multi-buy');
  assert.equal(by.g.promoPrice, undefined, '2 for 50 without ₪ is not believable for a 10₪ item');
});

test('Shufersal: weighted flag, cleaned brand, promotion end date', () => {
  const r = parseShufersal({ results: [
    { code: 'w', name: 'עגבניות', price: { value: 7.9 }, sellingMethod: { code: 'BY_WEIGHT' }, valueForComparison: 7.9, unitForComparison: 'לק"ג', brand: { name: 'General' }, manufacturer: 'ללא מותג' },
    { code: 'p', name: 'טונה בשמן', price: { value: 14 }, brand: null, manufacturer: 'סטארקיסט', unitDescription: '4*160 גרם', promotionMsg: "2 יח' ב- 22 ₪", potentialPromotions: [{ endDate: '2026-10-15' }] },
  ] } as never);
  assert.equal(r[0].byWeight, true);
  assert.equal(r[0].unitPriceText, '7.9 לק"ג');
  assert.equal(r[0].brand, undefined);
  assert.equal(r[1].brand, 'סטארקיסט');
  assert.equal(r[1].sizeText, '4*160 גרם');
  assert.equal(r[1].byWeight, undefined);
  assert.equal(r[1].promoEndsAt, '2026-10-15');
});

test('Rami Levy: multi-buy sale is a total for cmt units; brand, size, by-kilo', () => {
  const r = parseRamiLevy({ data: [
    { id: 1, name: 'במבה 80 גרם', price: { price: 5.5 }, gs: { BrandName: 'אסם', Net_Content: { text: '80 גרם' } }, sale: [{ scm: 10, cmt: 2, name: '2 ב-10 ש"ח', is_club: 0, to: '2026-10-20' }], available_in: [331] },
    { id: 2, name: 'עגבניות', price: { price: 7.9 }, prop: { by_kilo: 1 }, gs: { BrandName: 'כללי' }, available_in: [331] },
    { id: 3, name: 'קפה', price: { price: 30 }, sale: [{ scm: 50, cmt: 2, is_club: 1 }], available_in: [331] },
  ] as never }, 331);
  assert.equal(r[0].promoPrice, 5);
  assert.equal(r[0].promoMinQty, 2);
  assert.equal(r[0].promoEndsAt, '2026-10-20');
  assert.equal(r[0].brand, 'אסם');
  assert.equal(r[0].sizeText, '80 גרם');
  assert.equal(r[1].byWeight, true);
  assert.equal(r[1].brand, undefined);
  assert.equal(r[2].promoPrice, undefined, 'club-only multi-buy still excluded');
});

test('demo products identify themselves: brand or produce, size or by weight, some promo end dates', async () => {
  const { CONCEPTS } = await import('../server/catalog.ts');
  const all = [];
  for (const id of ['d1', 'd2', 'd3', 'd4']) {
    const p = demoProvider(id, id, 30);
    for (const c of CONCEPTS) all.push(...(await p.searchProducts(c.query)));
  }
  assert.ok(all.length > 50);
  for (const x of all) assert.ok(x.byWeight || x.sizeText, `size: ${x.name}`);
  assert.ok(all.filter((x) => x.brand).length > all.length * 0.7, 'most demo products carry a brand');
  assert.equal(all.find((x) => x.name.startsWith('חלב 3% תנובה'))!.brand, 'תנובה');
  assert.equal(all.find((x) => x.name.startsWith('חלב 3% תנובה'))!.sizeText, '1 ליטר');
  assert.ok(all.filter((x) => x.byWeight).every((x) => /לק"ג/.test(x.name)));
  const promos = all.filter((x) => x.promoPrice);
  for (const x of promos.filter((y) => y.promoEndsAt)) assert.match(x.promoEndsAt!, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(promos.some((x) => x.promoEndsAt), 'some demo promos carry an end date');
});

test('a failing provider does not break the scan', async () => {
  const broken = { ...demoProvider('broken', 'רשת שבורה', 30), searchProducts: async () => { throw new Error('HTTP 403'); } };
  const ok = demoProvider('ok', 'רשת תקינה', 30);
  const book = await scanPrices(['EGGS', 'TUNA', 'MILK'], [broken, ok]);
  assert.equal(book.failures.length, 1);
  assert.equal(book.failures[0].providerId, 'broken');
  assert.ok(book.byNeed.get('TUNA')!.length > 0);
});

test('parseSize handles multipacks and kg', () => {
  assert.deepEqual(parseSize('טונה 4*160 גרם'), { amount: 640, unit: 'g' });
  assert.deepEqual(parseSize('קולה 6*1.5 ליטר'), { amount: 9000, unit: 'ml' });
  assert.deepEqual(parseSize('אורז 1 ק"ג'), { amount: 1000, unit: 'g' });
});

test('matching rejects look-alike products from branch files', async () => {
  const { chooseProduct } = await import('../server/engine/match.ts');
  const { conceptById } = await import('../server/catalog.ts');
  const { newNeed } = await import('../server/state.ts');
  const mk = (name: string, price: number) => ({ providerId: 'b', productId: name, name, price, available: true, source: 'branch_data' as const, fetchedAt: '' });
  const pick = (id: string, names: [string, number][]) => chooseProduct(conceptById.get(id)!, { ...newNeed(conceptById.get(id)!, 2, 0), flexibility: 'category_flexible' }, names.map(([n, p]) => mk(n, p)))?.product.name;
  assert.equal(pick('EGGS', [['אטריות ביצים דקות 400', 6], ['ביצים L 12 יח', 13.9]]), 'ביצים L 12 יח');
  assert.equal(pick('TOMATOES', [['מיץ עגבניות עם מלח 1 ל', 7], ['עגבניות שרי', 12], ['עגבניה', 6.9]]), 'עגבניה');
  assert.equal(pick('CUCUMBERS', [['תחליב רחצה מלפפון ולימון', 9], ['מלפפון', 5.9]]), 'מלפפון');
  assert.equal(pick('MILK', [['יוגורט של פעם חלב עיזים', 6], ['חלב 3% קרטון 1 ל', 6.9]]), 'חלב 3% קרטון 1 ל');
  assert.equal(pick('COFFEE', [['עוגיית קרם קפה', 9], ['קפה נמס עלית 200 ג', 29.9]]), 'קפה נמס עלית 200 ג');
});

test('matching: live-catalog look-alikes found in the real run', async () => {
  const { chooseProduct } = await import('../server/engine/match.ts');
  const { conceptById } = await import('../server/catalog.ts');
  const { newNeed } = await import('../server/state.ts');
  const mk = (name: string, price: number) => ({ providerId: 'x', productId: name, name, price, available: true, source: 'live' as const, fetchedAt: '' });
  const pick = (id: string, names: [string, number][], flex: 'category_flexible' | 'exact_product' = 'category_flexible') =>
    chooseProduct(conceptById.get(id)!, { ...newNeed(conceptById.get(id)!, 2, 0), flexibility: flex }, names.map(([n, p]) => mk(n, p)))?.product.name;
  assert.equal(pick('EGGS', [['ביצי קינדר בואנו לחנוכה', 19.5], ['ביצים גדולות L 12 יח', 14.9]]), 'ביצים גדולות L 12 יח');
  assert.equal(pick('COLA_ZERO', [['ספרייט זירו 1.5 ליטר', 7.65], ['קוקה קולה זירו 6*1.5 ליטר', 39.9]]), 'קוקה קולה זירו 6*1.5 ליטר');
  assert.equal(pick('PASTA', [['פסטה ניוקי 500 גר', 7.45], ['פסטה פנה 500 גרם', 6.9]]), 'פסטה פנה 500 גרם');
  assert.equal(pick('TOMATOES', [['עגבניות מקולפות שלמות', 4.97], ['עגבניות', 7.9]]), 'עגבניות');
});
