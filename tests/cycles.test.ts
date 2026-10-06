// End-to-end (in-process) check of two shopping cycles with demo prices:
// onboarding → chat → basket → compare → confirm → time passes → second basket differs because of learning.
process.env.KANITI_DB = ':memory:';
process.env.KANITI_DEMO = '1';
process.env.KANITI_CACHE = '/tmp/kaniti-test-cache';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { store } = await import('../server/db.ts');
const { advanceDays } = await import('../server/clock.ts');
const { completeOnboarding } = await import('../server/state.ts');
const { parseMessage } = await import('../server/chat/parser.ts');
const { executeActions, executeCommand } = await import('../server/chat/execute.ts');
const svc = await import('../server/service.ts');
const { compareBasket } = await import('../server/engine/compare.ts');

const say = async (t: string) => (t.startsWith('#') ? (await executeCommand(t.slice(1).split(' ')[0], t.split(' ').slice(1))) ?? executeActions(parseMessage(t)) : executeActions(parseMessage(t)));
const item = (id: string) => store.basket()!.items.find((i) => i.needId === id);

test('two shopping cycles', async () => {
  completeOnboarding({
    adults: 2, children: [{ age: 6 }], kosher: true, dairyAllergy: false, vegetarian: false,
    address: { city: 'רמת גן' }, onlineProviders: ['shufersal', 'ramilevy', 'victory'],
    physicalStores: [{ chainId: 'osherad', storeId: '1', name: 'אושר עד' }],
    flex: { COLA_ZERO: 'strict', LAUNDRY_SOFTENER: 'deal', CREAM_CHEESE: 'any' },
    staples: ['EGGS', 'BREAD', 'TUNA', 'CREAM_CHEESE', 'COLA_ZERO', 'PASTA', 'BAMBA', 'LAUNDRY_SOFTENER', 'MILK'],
    customStaples: [], threshold: 60,
  });

  // Chat statements become structured state.
  await say('יש לנו 10 ביצים');
  assert.equal(store.need('EGGS')!.currentStockEstimate, 10);
  await say('לא אכפת לי איזה מרכך');
  assert.equal(store.need('LAUNDRY_SOFTENER')!.flexibility, 'category_flexible');
  await say('רק קוקה קולה זירו');
  assert.equal(store.need('COLA_ZERO')!.flexibility, 'exact_product');
  assert.deepEqual(store.need('COLA_ZERO')!.preferredBrands, ['קוקה קולה']);

  // Build with stock info in the same message; skip the check-in.
  await say('יש עדיין הרבה פסטה ואין טונה');
  await say('#build 14 force');
  const b1 = store.basket()!;
  assert.ok(b1.items.length > 4, 'basket has items');
  assert.ok(item('TUNA'), 'tuna is needed (ran out)');
  assert.ok(!item('PASTA') || item('PASTA')!.status !== 'need', 'pasta not needed (lots at home)');
  const cola = item('COLA_ZERO');
  if (cola?.product) assert.match(cola.product.name, /קוקה קולה/, 'strict product stays strict');
  assert.ok(b1.items.filter((i) => i.status === 'discovery').length <= 3, 'discovery is restrained');

  // Temporary skip vs permanent preference.
  await say('אל תקנה גבינת שמנת הפעם');
  assert.ok(!item('CREAM_CHEESE'));
  assert.equal(store.need('CREAM_CHEESE')!.active, true, 'still a household staple');

  // Conditional add.
  await say('תוסיף גם פרגיות אם המחיר טוב');
  assert.ok(item('CHICKEN_THIGHS')?.condition, 'conditional item recorded');

  // Basket edit emits learning: user bumps eggs.
  const eggsBefore = store.need('EGGS')!.typical14DayQty;
  svc.setQuantity('EGGS', (item('EGGS')?.quantity ?? 1) + 2);
  assert.ok(store.need('EGGS')!.typical14DayQty > eggsBefore, 'egg consumption learned upward');
  assert.ok(store.events('EGGS').some((e) => e.type === 'quantity_changed'));

  // Compare: provider isolation — all demo providers answer, ranking produced.
  const cmp = await compareBasket(store.basket()!);
  assert.ok(cmp.quotes.filter((q) => q.ok).length >= 2);
  assert.ok(cmp.recommendation.winnerId);
  assert.ok(cmp.quotes.every((q) => q.source === 'demo' || !q.ok), 'demo results never labelled live');

  // Confirm purchase; they skip bamba entirely.
  const winner = cmp.quotes.find((q) => q.providerId === cmp.recommendation.winnerId)!;
  const bought = winner.lines.filter((l) => !l.missing && l.needId !== 'BAMBA').map((l) => ({ needId: l.needId, quantity: l.quantity, productName: l.product?.name, price: l.lineTotal / l.quantity }));
  const bambaTypical = store.need('BAMBA')!.typical14DayQty;
  svc.confirmPurchase({ storeName: winner.providerName, providerId: winner.providerId, total: winner.total, items: bought });
  assert.equal(store.purchases().length, 1);
  assert.ok(store.need('TUNA')!.currentStockEstimate! > 0, 'stock updated from purchase');

  // Second cycle: a week later, they bought tuna in bulk → no tuna need; bamba removal reduced expectations.
  advanceDays(7);
  await say('לא אכפת לי מאיזה מותג של טונה'); // preference learned mid-cycle
  await say('#build 14 force');
  const b2 = store.basket()!;
  assert.notEqual(b2.id, b1.id);
  assert.ok(!item('TUNA') || item('TUNA')!.quantity < (b1.items.find((i) => i.needId === 'TUNA')?.quantity ?? 0), 'tuna stocked from last time');
  assert.ok(!b2.items.some((i) => i.needId === 'CREAM_CHEESE' && i.reason.includes('דלג')), 'temporary skip did not carry over');
  assert.ok(store.need('BAMBA')!.removedCount >= 1);
  assert.equal(store.need('TUNA')!.flexibility, 'category_flexible');
  assert.ok(store.need('BAMBA')!.typical14DayQty <= bambaTypical);
  const diff = b2.items.map((i) => `${i.needId}:${i.quantity}`).join(',') !== b1.items.map((i) => `${i.needId}:${i.quantity}`).join(',');
  assert.ok(diff, 'second basket differs');
});
