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
