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
