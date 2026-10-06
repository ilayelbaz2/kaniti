process.env.KANITI_DB = ':memory:';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const { decodeXml, parsePriceFull, parsePromoFull, parseStores, searchBranch } = await import('../server/providers/transparency.ts');
const fx = (f: string) => decodeXml(fs.readFileSync(new URL('./fixtures/' + f, import.meta.url)));

test('parses real Shufersal Stores file (SAP ABAP dialect)', () => {
  const stores = parseStores(fx('shufersal-stores.xml.gz'));
  assert.ok(stores.length > 100, `got ${stores.length}`);
  const s = stores.find((x) => x.storeId === '1')!;
  assert.equal(s.city, 'תל אביב');
});

test('parses real PriceFull files', () => {
  for (const f of ['superpharm-pricefull.xml.gz']) {
    const items = parsePriceFull(fx(f));
    assert.ok(items.length > 50, `${f}: ${items.length}`);
    assert.ok(items.every((i) => i.price > 0 && i.name && i.code));
  }
});

test('parses real Rami Levy PromoFull, skipping club-only deals', () => {
  const promos = parsePromoFull(fx('ramilevy-promofull.xml.gz'));
  assert.ok(promos.size > 100, `got ${promos.size}`);
  for (const p of promos.values()) assert.ok(p.price > 0 && p.minQty >= 1);
});

test('searchBranch matches Hebrew tokens', () => {
  const items = [{ code: '1', name: 'טונה בשמן סטארקיסט 4*160', price: 30 }, { code: '2', name: 'חלב 3%', price: 6 }];
  assert.equal(searchBranch(items, 'טונה בשמן')[0].code, '1');
});

test('Shufersal PromoFull dialect: price on PromotionItem inside Groups', () => {
  const xml = `<Root><ChainID>7290027600007</ChainID><Promotions>
    <Promotion><PromotionID>1</PromotionID><PromotionDescription>טונה 2 ב-20</PromotionDescription><PromotionEndDateTime>2031-01-01T02:59:00.000</PromotionEndDateTime><ClubID>0 - כלל הלקוחות</ClubID>
      <Groups><Group><GroupID>1</GroupID><PromotionItems><PromotionItem><ItemCode>111</ItemCode><MinQty>2.00</MinQty><DiscountedPrice>20.00</DiscountedPrice><DiscountedPricePerMida>0.00</DiscountedPricePerMida></PromotionItem></PromotionItems></Group></Groups></Promotion>
    <Promotion><PromotionID>2</PromotionID><PromotionDescription>מתנה</PromotionDescription><ClubID>0 - כלל הלקוחות</ClubID>
      <Groups><Group><PromotionItems><PromotionItem><ItemCode>222</ItemCode><MinQty>1.00</MinQty><DiscountedPrice>0.00</DiscountedPrice></PromotionItem></PromotionItems></Group></Groups></Promotion>
    <Promotion><PromotionID>3</PromotionID><ClubID>3 - מועדון</ClubID>
      <Groups><Group><PromotionItems><PromotionItem><ItemCode>333</ItemCode><MinQty>1</MinQty><DiscountedPrice>5</DiscountedPrice></PromotionItem></PromotionItems></Group></Groups></Promotion>
  </Promotions></Root>`;
  const m = parsePromoFull(xml);
  assert.deepEqual(m.get('111'), { price: 10, minQty: 2, text: 'טונה 2 ב-20' });
  assert.equal(m.has('222'), false, 'zero-price gifts ignored');
  assert.equal(m.has('333'), false, 'club-only ignored');
});

test('store city codes and names', async () => {
  const { storeInCity } = await import('../server/providers/cities.ts');
  assert.ok(storeInCity({ city: '8600', name: 'שלי רמת גן- ביאליק' }, 'רמת גן'));
  assert.ok(storeInCity({ city: '0', name: 'קולינריק רמת גן' }, 'רמת גן'));
  assert.ok(!storeInCity({ city: '3000', name: 'תלפיות' }, 'רמת גן'));
  assert.ok(storeInCity({ city: '5000', name: 'רמת החייל' }, 'תל אביב-יפו'));
});
