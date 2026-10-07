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
  const promos = parsePromoFull(fx('ramilevy-promofull.xml.gz'), undefined, '2026-10-07'); // fixture promos run to 2026-12-31
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
  assert.deepEqual(m.get('111'), { price: 10, minQty: 2, text: 'טונה 2 ב-20', endsAt: '2031-01-01' });
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

test('feed file names: both shapes', async () => {
  const { storeOfFile } = await import('../server/providers/transparency.ts');
  assert.equal(storeOfFile('PriceFull7290058140886-001-001-20261006-001006.gz'), '1');
  assert.equal(storeOfFile('PriceFull7290058140886-001-055-20261006-001006.gz'), '55');
  assert.equal(storeOfFile('PriceFull7290785400000-104-202610060630.gz'), '104');
});

test('real PriceFull: pack size from Quantity+UnitQty, placeholder brands dropped', () => {
  const items = parsePriceFull(fx('superpharm-pricefull.xml.gz'));
  const by = (code: string) => items.find((i) => i.code === code)!;
  assert.equal(by('7290012938740').sizeText, '75 מ״ל'); // סנסודין … 75 מל, UnitQty מ"ל
  assert.equal(by('7290012938740').maker, 'גורי');
  assert.equal(by('7290000178707').maker, undefined, "ManufacturerName 'General' is not a brand");
  assert.equal(by('7290000178707').sizeText, undefined, 'Quantity 0 → no size (UnitOfMeasure 100.00 is junk)');
  assert.ok(items.filter((i) => i.sizeText).length > 100);
  assert.ok(!items.some((i) => i.maker && /^general$/i.test(i.maker)));
});

test('PriceFull: weighted items, unit spellings, branch search result carries identity', async () => {
  const { branchResult, applyPromos } = await import('../server/providers/transparency.ts');
  const xml = `<root><Items>
    <Item><ItemCode>1</ItemCode><ItemName>עגבניות</ItemName><ManufacturerName>לא ידוע</ManufacturerName><UnitQty>קילוגרמים</UnitQty><Quantity>1.00</Quantity><bIsWeighted>1</bIsWeighted><ItemPrice>7.90</ItemPrice></Item>
    <Item><ItemCode>2</ItemCode><ItemName>פסטה פנה</ItemName><ManufacturerName>אסם</ManufacturerName><UnitQty>גרמים</UnitQty><Quantity>500.00</Quantity><UnitOfMeasure>100 גרם</UnitOfMeasure><bIsWeighted>0</bIsWeighted><ItemPrice>6.90</ItemPrice></Item>
    <Item><ItemCode>3</ItemCode><ItemName>חלב</ItemName><ManufacturerName>תנובה</ManufacturerName><UnitQty>Unknown</UnitQty><Quantity>1.00</Quantity><UnitOfMeasure>ליטר</UnitOfMeasure><ItemPrice>6.50</ItemPrice></Item>
    <Item><ItemCode>4</ItemCode><ItemName>ביצים</ItemName><UnitQty>יחידה</UnitQty><Quantity>12</Quantity><ItemPrice>13.90</ItemPrice></Item>
  </Items></root>`;
  const items = parsePriceFull(xml);
  assert.deepEqual(items.map((i) => [i.sizeText, i.byWeight, i.maker]), [
    [undefined, true, undefined], ['500 גרם', undefined, 'אסם'], ['1 ליטר', undefined, 'תנובה'], ['12 יח׳', undefined, undefined],
  ]);
  applyPromos(items, new Map([['2', { price: 5, minQty: 2, text: '2 ב-10', endsAt: '2026-10-20' }]]));
  const r = items.map((it) => branchResult('branch:x:1', it, '2026-10-07T00:00:00Z'));
  assert.equal(r[0].byWeight, true);
  assert.deepEqual([r[1].brand, r[1].sizeText, r[1].promoPrice, r[1].promoMinQty, r[1].promoEndsAt], ['אסם', '500 גרם', 5, 2, '2026-10-20']);
  assert.equal(branchResult('b', { code: '9', name: 'x', maker: 'General', price: 3 }, '').brand, undefined, 'old cached rows are cleaned too');
});

test('real Rami Levy PromoFull: end dates kept, coupons skipped, buy-N-get-free needs shelf prices', () => {
  const xml = fx('ramilevy-promofull.xml.gz');
  const day = '2026-10-07'; // the fixture's promotions run to 2026-12-31
  const plain = parsePromoFull(xml, undefined, day);
  assert.ok([...plain.values()].every((p) => p.endsAt && /^\d{4}-\d{2}-\d{2}$/.test(p.endsAt)));
  assert.ok(![...plain.values()].some((p) => /קופון/.test(p.text)), 'coupon promotions are not for everyone');
  assert.equal(plain.has('6927749870203'), false, "2+1 (RewardType 7) can't be priced without the shelf price");
  // וונסי מוס לחתול 2+1 (RewardType 7, MinQty 3, gift 1) · חטיפי דונאט לכלב השני בחצי (RewardType 9, MinQty 2, 50%)
  // · צלחות רטרו 2+1 הזול מבניהם (RewardType 9, MinQty 3, 100%)
  const codes = [...xml.matchAll(/<ItemCode>(\d+)<\/ItemCode>/g)].map((m) => m[1]);
  const priced = parsePromoFull(xml, new Map(codes.map((c) => [c, 12])), day);
  assert.deepEqual(priced.get('6927749870203'), { price: 8, minQty: 3, text: 'וונסי מוס לחתול 90 גרם 2+1', endsAt: '2026-12-31' });
  const half = [...priced.values()].find((p) => /דונאט.*השני בחצי/.test(p.text))!;
  assert.deepEqual([half.price, half.minQty], [9, 2]);
  const cheapest = [...priced.values()].find((p) => /צלחות רטרו 2\+1/.test(p.text))!;
  assert.deepEqual([cheapest.price, cheapest.minQty], [8, 3]);
  assert.ok(priced.size > plain.size);
});

test('PromoFull: coupon flag, future start and expired promotions are skipped', () => {
  const promo = (id: string, code: string, extra: string) => `<Promotion><PromotionId>${id}</PromotionId><PromotionDescription>מבצע ${id}</PromotionDescription>${extra}<MinQty>1</MinQty><DiscountedPrice>5</DiscountedPrice><PromotionItems><Item><ItemCode>${code}</ItemCode></Item></PromotionItems><Clubs><ClubId>0</ClubId></Clubs></Promotion>`;
  const xml = `<Root><Promotions>
    ${promo('1', 'a', '<PromotionEndDate>2099-01-31</PromotionEndDate><AdditionalRestrictions><AdditionalIsCoupon>1</AdditionalIsCoupon></AdditionalRestrictions>')}
    ${promo('2', 'b', '<PromotionStartDate>2099-01-01</PromotionStartDate><PromotionEndDate>2099-01-31</PromotionEndDate>')}
    ${promo('3', 'c', '<PromotionEndDate>2001-01-31</PromotionEndDate>')}
    ${promo('4', 'd', '<PromotionStartDate>2001-01-01</PromotionStartDate><PromotionEndDate>2099-01-31</PromotionEndDate><AdditionalRestrictions><AdditionalIsCoupon>0</AdditionalIsCoupon></AdditionalRestrictions>')}
  </Promotions></Root>`;
  const m = parsePromoFull(xml);
  assert.deepEqual([...m.keys()], ['d']);
  assert.equal(m.get('d')!.endsAt, '2099-01-31');
});

test('unit and date normalisers', async () => {
  const { normUnit, sizeOf, isoDay } = await import('../server/providers/transparency.ts');
  assert.deepEqual(['גרמים', 'מיליליטר', 'מ"ל', 'ליטר', 'ק"ג', 'קילוגרם', 'יחידה', '100.00', 'Unknown'].map(normUnit), ['גרם', 'מ״ל', 'מ״ל', 'ליטר', 'ק"ג', 'ק"ג', 'יח׳', undefined, undefined]);
  assert.equal(sizeOf('1.50', 'ליטר'), '1.5 ליטר');
  assert.equal(sizeOf('1', 'יחידה'), undefined);
  assert.equal(isoDay('2026-10-12T21:30:00Z'), '2026-10-13');
  assert.equal(isoDay('2031-01-01T02:59:00.000'), '2031-01-01');
  assert.equal(isoDay('31/12/2026'), '2026-12-31');
  assert.equal(isoDay(''), undefined);
});
