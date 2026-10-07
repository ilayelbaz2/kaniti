// Real-usage cart-handoff regressions, run against the REAL Shufersal / Rami Levy drivers with a fake page:
// no navigation while the user acts, continuing after the address is chosen, and no "ready" without proof.
process.env.KANITI_DB = ':memory:';
process.env.KANITI_LOGIN_WAIT_MS = '20000';
process.env.KANITI_QUIET_MS = '0';
process.env.KANITI_POLL_MS = '20';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BasketQuote, Household } from '../shared/types.ts';
const { _runForTest, resume, currentJob, applyReadback, showCart, startCartJob } = await import('../server/cart/prepare.ts');
const { cartDriver, ramiCartLines, ramiDelivery, parseShufersalCart, htmlToText } = await import('../server/cart/drivers.ts');
const { store } = await import('../server/db.ts');

const HOME = { city: 'רמת גן', street: 'ביאליק 12' };
store.saveHousehold({ id: 'h', adults: 2, children: [{ age: 2 }], kosher: true, allergies: [], dietNotes: [], homeAddress: HOME, driveSavingsThresholdNis: 60,
  onlineProviders: ['shufersal', 'ramilevy'], physicalStores: [], flexibilityStyle: 'balanced', shopEveryDays: 14 } satisfies Household);

const quote = (providerId: string, ids = ['P_111', 'P_222']): BasketQuote => ({
  providerId, providerName: providerId, kind: 'online', ok: true, subtotal: 50, deliveryFee: 30, total: 80, completeness: 1, unavailableCount: 0, substitutionsCount: 0, source: 'live', fetchedAt: '',
  lines: ids.map((id, i) => ({ needId: `N${i}`, label: `item${i}`, quantity: 2, lineTotal: 20, product: { providerId, productId: id, name: `מוצר ${i}`, brand: 'מותג', sizeText: '500 גרם', price: 10, available: true, source: 'live' as const, fetchedAt: '' } })),
});
const deps = (page: unknown) => ({ pageFor: async () => page as never, isBlockedByVerification: async () => false, interactive: () => true });
const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));

/** A fake Shufersal page. Navigation is recorded; in-page scripts are answered by what they ask for. */
function shufersalPage(state: { url: string; loggedIn: boolean; cartHtml: string; inCart: string[] }) {
  const nav: string[] = [];
  return {
    nav,
    page: {
      url: () => state.url,
      goto: async (u: string) => { nav.push(u); },
      reload: async () => { nav.push('reload'); },
      bringToFront: async () => {},
      evaluate: async (src: string) => {
        if (src.includes('role=dialog')) return false;
        if (src.includes('/online/he/my-account')) return state.loggedIn;
        if (src.includes('/online/he/cart/add')) { const lines = JSON.parse(src.slice(src.lastIndexOf(')(') + 2, -1)); state.inCart.push(...lines.map((l: { productId: string }) => l.productId)); return { added: lines.map((l: { productId: string }) => l.productId), failed: [] }; }
        if (src.includes("Accept: 'text/html'")) return `${state.cartHtml}<div>סל הקניות</div>${state.inCart.map((c) => `<div data-code="${c}">x</div>`).join('')}<div>לתשלום: ₪123.40</div>`;
        return null;
      },
    },
  };
}
const ADDRESS_OK = '<div>כתובת למשלוח: ביאליק 12, רמת גן</div><div>דמי משלוח: ₪29.90</div><div>יום ה׳ 09/10 10:00-12:00</div>';

test('Shufersal: address flow stays stable while waiting — no navigation or reload until the user is done', async () => {
  const st = { url: 'https://www.shufersal.co.il/online/he/my-account/addresses', loggedIn: true, cartHtml: '<div>בחרו כתובת למשלוח</div>', inCart: [] as string[] };
  const { page, nav } = shufersalPage(st);
  const p = _runForTest(quote('shufersal'), cartDriver('shufersal')!, deps(page));
  await tick(300);
  assert.equal(currentJob()!.status, 'address_required');
  assert.deepEqual(nav, [], 'the page the user is working in was never navigated or reloaded');
  st.url = 'https://www.shufersal.co.il/online/he/A';
  st.cartHtml = ADDRESS_OK; // the user saved the address
  const job = await p;
  assert.equal(job.delivery!.deliveryStatus, 'confirmed');
  assert.equal(job.status, 'ready');
  assert.deepEqual(nav, [], 'still no navigation — the cart is read with in-page requests');
});

test('Shufersal: registration logs the user in before the address step — Kaniti does not pull them home', async () => {
  const st = { url: 'https://www.shufersal.co.il/online/he/register', loggedIn: false, cartHtml: ADDRESS_OK, inCart: [] as string[] };
  const { page, nav } = shufersalPage(st);
  const p = _runForTest(quote('shufersal'), cartDriver('shufersal')!, deps(page));
  await tick(100);
  assert.equal(currentJob()!.status, 'login_required');
  st.loggedIn = true; // registered + logged in, but still on the registration/address pages
  await tick(200);
  assert.equal(currentJob()!.status, 'login_required', 'still waiting: the user is mid-registration');
  assert.ok(!nav.some((u) => u.endsWith('/online/he/A')), 'never sent back to the home page');
  st.url = 'https://www.shufersal.co.il/online/he/A';
  const job = await p;
  assert.equal(job.status, 'ready');
  assert.ok(!nav.some((u) => u.endsWith('/online/he/A')));
});

/** A fake Rami Levy page: Vuex state + /api/v2/cart answered from in-memory state. */
function ramiPage(state: { address: { street: string; number?: string; city: string } | null; items: { id: string; quantity: number; is_delivery?: boolean; price?: number }[]; readable: boolean }) {
  const nav: string[] = [];
  return {
    nav,
    page: {
      url: () => 'https://www.rami-levy.co.il/he',
      goto: async (u: string) => { nav.push(u); }, reload: async () => { nav.push('reload'); }, bringToFront: async () => {},
      evaluate: async (src: string) => {
        if (src.includes('role=dialog')) return false;
        if (src.includes('return !!(st && st.authuser')) return true;
        if (src.includes('walk(')) return { address: state.address, candidates: state.address ? 1 : 0, cart: { items: state.items }, slot: null, loggedIn: true };
        if (src.includes('arg.mode')) {
          const arg = JSON.parse(src.slice(src.lastIndexOf(')(') + 2, -1));
          if (!state.readable) return arg.mode === 'read' ? null : { error: 'cannot_read_cart' };
          if (arg.mode === 'read') return { items: state.items };
          for (const l of arg.lines) state.items.push({ id: l.productId, quantity: Number(l.quantity) });
          return { items: state.items };
        }
        return null;
      },
    },
  };
}

test('Rami Levy: after the address is chosen on the site, preparation continues by itself (no button needed)', async () => {
  const st = { address: null as null | { street: string; number?: string; city: string }, items: [] as { id: string; quantity: number; is_delivery?: boolean; price?: number }[], readable: true };
  const { page } = ramiPage(st);
  const p = _runForTest(quote('ramilevy', ['501', '502']), cartDriver('ramilevy')!, deps(page));
  await tick(100);
  assert.equal(currentJob()!.status, 'address_required');
  st.address = { street: 'ביאליק', number: '12', city: 'רמת גן' };
  st.items.push({ id: 'DEL', quantity: 1, is_delivery: true, price: 29.9 });
  const job = await p;
  assert.equal(job.delivery!.deliveryStatus, 'confirmed');
  assert.equal(job.deliveryFee, 29.9);
  assert.equal(job.status, 'ready');
  assert.equal(job.lines.filter((l) => l.state === 'added').length, 2);
});

test('Rami Levy: "בחרתי כתובת — המשך" always moves on, even when the site state cannot be verified', async () => {
  const st = { address: null, items: [] as { id: string; quantity: number }[], readable: true };
  const { page } = ramiPage(st);
  const seen: string[] = [];
  const p = _runForTest(quote('ramilevy', ['601']), cartDriver('ramilevy')!, deps(page));
  await tick(100);
  assert.equal(currentJob()!.status, 'address_required');
  resume('continue');
  const t = setInterval(() => seen.push(currentJob()!.status), 5);
  const job = await p;
  clearInterval(t);
  assert.equal(job.status, 'ready', 'items were added and verified');
  assert.notEqual(job.delivery!.deliveryStatus, 'confirmed', 'but delivery is not claimed as confirmed');
  assert.match(job.delivery!.restrictionMessage!, /לא הצלחתי לאמת את הכתובת/);
  assert.ok(!seen.slice(seen.indexOf('adding')).includes('address_required'), 'never asked to choose the address again');
});

test('skip_address does not skip login, and the old boolean resume skips only the current wait', async () => {
  const st = { url: 'https://www.shufersal.co.il/online/he/login', loggedIn: false, cartHtml: '<div>בחרו כתובת למשלוח</div>', inCart: [] as string[] };
  const { page } = shufersalPage(st);
  const p = _runForTest(quote('shufersal'), cartDriver('shufersal')!, deps(page));
  await tick(100);
  resume('skip_address');
  await tick(100);
  assert.equal(currentJob()!.status, 'login_required', 'still waiting for login');
  st.loggedIn = true; st.url = 'https://www.shufersal.co.il/online/he/A';
  await tick(150);
  assert.equal(currentJob()!.status, 'address_required');
  resume(true);
  const job = await p;
  assert.equal(job.status, 'ready');
  assert.match(job.delivery!.restrictionMessage!, /המשכתי בלי לאמת/);
});

test('Rami Levy: an unreadable existing cart is never overwritten', async () => {
  const st = { address: { street: 'ביאליק', number: '12', city: 'רמת גן' }, items: [{ id: 'DEL', quantity: 1, is_delivery: true, price: 29.9 }], readable: false };
  const { page } = ramiPage(st);
  const job = await _runForTest(quote('ramilevy', ['701']), cartDriver('ramilevy')!, deps(page));
  assert.equal(job.status, 'failed');
  assert.match(job.lines[0].reason!, /לא שיניתי/);
});

test('a redirect alone is never success: claimed-added items missing from the site cart fail; unreadable cart is not "ready"', () => {
  const mk = () => ({ lines: [{ needId: 'A', label: 'א', productId: '1', quantity: 1, state: 'pending' }, { needId: 'B', label: 'ב', productId: '2', quantity: 2, state: 'pending' }] as import('../shared/types.ts').CartJobLine[] });
  const empty = mk();
  applyReadback(empty, { added: ['1', '2'], failed: [] }, { lines: [], source: 'server' });
  assert.deepEqual(empty.lines.map((l) => l.state), ['failed', 'failed']);
  const unknown = mk();
  applyReadback(unknown, { added: ['1', '2'], failed: [] }, null);
  assert.deepEqual(unknown.lines.map((l) => l.state), ['unverified', 'unverified']);
  const short = mk();
  applyReadback(short, { added: ['1', '2'], failed: [] }, { lines: [{ productId: '1', quantity: 1 }, { productId: '2', quantity: 1 }], source: 'server' });
  assert.match(short.lines[1].reason!, /בעגלה 1 במקום 2/);
});

test('Rami Levy cart/delivery parsing: the delivery line is a fee, not a product; empty answer is not success', () => {
  const r = ramiCartLines({ items: [{ id: 5, quantity: '2.00' }, { id: 9, quantity: 1, is_delivery: true, price: 29.9 }], price: 40 })!;
  assert.deepEqual(r.lines, [{ productId: '5', quantity: 2 }]);
  assert.equal(r.deliveryFee, 29.9);
  assert.equal(ramiCartLines({}), null);
  const d = ramiDelivery({ address: { street: 'ביאליק 12', city: 'רמת גן' }, cart: { items: [{ id: 1, is_delivery: true, price: 29.9 }] }, slot: null });
  assert.equal(d.available, true);
  assert.equal(d.address!.number, '12');
  assert.equal(ramiDelivery({ address: null, cart: null, slot: null }).addressSelected, undefined);
});

test('Shufersal cart page parsing reads codes and total; a non-cart page is unreadable', () => {
  const { readback, text } = parseShufersalCart('<h1>סל הקניות</h1><div data-code="P_1"></div><span>לתשלום:</span> <b>&#8362;123.40</b>', ['P_1', 'P_2']);
  assert.deepEqual(readback!.lines.map((l) => l.productId), ['P_1']);
  assert.equal(readback!.total, 123.4);
  assert.match(text, /לתשלום/);
  assert.equal(parseShufersalCart('<html><body>maintenance</body></html>', ['P_1']).readback, null);
  assert.equal(htmlToText('<div>א</div><div>ב</div>'), 'א\nב');
});

test('show cart: brings the automation window to the front on the cart page (one navigation)', async () => {
  const nav: string[] = []; let front = 0;
  startCartJob({ quote: quote('shufersal') }, false);
  const r = await showCart({ pageFor: async () => ({ goto: async (u: string) => { nav.push(u); }, bringToFront: async () => { front++; } }) as never });
  assert.equal(r.ok, true);
  assert.deepEqual(nav, ['https://www.shufersal.co.il/online/he/cart']);
  assert.equal(front, 1);
});

test('one cart job at a time: a second "prepare" while waiting for the user returns the same job, no new navigation', async () => {
  const st = { url: 'https://www.shufersal.co.il/online/he/my-account/addresses', loggedIn: true, cartHtml: '<div>בחרו כתובת למשלוח</div>', inCart: [] as string[] };
  const { page, nav } = shufersalPage(st);
  const p = _runForTest(quote('shufersal'), cartDriver('shufersal')!, deps(page));
  await tick(200);
  const waiting = currentJob()!;
  assert.equal(waiting.status, 'address_required');
  const again = startCartJob({ quote: quote('shufersal', ['P_999']) });
  assert.equal(again.id, waiting.id, 'the running job is returned, not replaced');
  assert.deepEqual(nav, []);
  st.url = 'https://www.shufersal.co.il/online/he/A'; st.cartHtml = ADDRESS_OK;
  await p;
});

test('a quantity shortfall in the site cart is flagged (and a flagged line keeps the job from being "ready")', () => {
  const mk = { lines: [{ needId: 'A', label: 'א', productId: '1', quantity: 3, state: 'pending' }] as import('../shared/types.ts').CartJobLine[] };
  applyReadback(mk, { added: ['1'], failed: [] }, { lines: [{ productId: '1', quantity: 1 }], source: 'server' });
  assert.equal(mk.lines[0].short, true);
});

test('ZuZ cart readback: no server cart → null (unverified), never the page\'s local copy', async () => {
  const page = { evaluate: async (src: string) => (src.includes('serverCartId') ? null : undefined) };
  assert.equal(await cartDriver('tivtaam')!.readCartLines(page as never, ['1']), null);
});

test('ZuZ cart readback uses the site server\'s own answer to its save (captured), never the local copy', async () => {
  let src = '';
  await cartDriver('tivtaam')!.readCartLines({ evaluate: async (x: string) => { src = x; return null; } } as never, ['11']);
  const run = (win: Record<string, unknown>) => new Function('window', 'fetch', 'document', `return ${src}`)(win, async () => ({ ok: false, status: 404 }), { body: {} });
  const angular = (cart: object) => ({ element: () => ({ injector: () => ({ get: (n: string) => (n === 'Cart' ? cart : n === 'Config' ? { branch: { id: 924 }, retailer: { id: 1062 } } : { get: async () => ({ status: 200, data: '<html>' }) }) }) }) });
  const cart = { serverCartId: 5, total: { finalPriceForView: 40 }, lines: { a: { product: { id: 99 }, quantity: 7 } } };
  const ok = await run({ angular: angular(cart), __kanitiCartResps: [{ path: '/v2/retailers/1062/branches/924/carts/5', status: 200, at: 1, body: { cart: { lines: [{ retailerProductId: 11, quantity: 2, type: 1 }] } } }] });
  assert.deepEqual(ok.lines, [{ productId: '11', quantity: 2 }]);
  assert.equal(ok.source, 'server');
  assert.equal(await run({ angular: angular(cart), __kanitiCartResps: [] }), null, 'no server answer → unverified, even though the page has local lines');
});
