// Cart-handoff state machine against a fake supermarket (no network, no real browser).
process.env.KANITI_DB = ':memory:';
process.env.KANITI_LOGIN_WAIT_MS = '20000';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BasketQuote } from '../shared/types.ts';
const { _runForTest, resume } = await import('../server/cart/prepare.ts');

const quote = (providerId = 'tivtaam'): BasketQuote => ({
  providerId, providerName: 'טיב טעם אונליין', kind: 'online', ok: true, subtotal: 60, deliveryFee: 29.9, total: 89.9,
  completeness: 0.75, unavailableCount: 1, substitutionsCount: 1, source: 'live', fetchedAt: '',
  lines: [
    { needId: 'EGGS', label: 'ביצים', quantity: 2, lineTotal: 28, product: { providerId, productId: '11', name: 'ביצים L 12', price: 14, available: true, source: 'live', fetchedAt: '' } },
    { needId: 'MILK', label: 'חלב', quantity: 4, lineTotal: 24, product: { providerId, productId: '22', name: 'חלב 3%', price: 6, available: true, source: 'live', fetchedAt: '' } },
    { needId: 'TUNA', label: 'טונה', quantity: 1, lineTotal: 0, missing: true },
    { needId: 'CREAM_CHEESE', label: 'גבינת שמנת', quantity: 1, lineTotal: 0, missing: true, uncertain: true, product: { providerId, productId: '33', name: 'שמנת להקצפה', price: 8, available: true, source: 'live', fetchedAt: '' } },
  ],
});

function fakePage() {
  let url = 'https://shop.example/';
  return { url: () => url, goto: async (u: string) => { url = u; }, bringToFront: async () => {} };
}

function fakeDriver(opts: { loggedInAfter?: number; fail?: string[] } = {}) {
  let checks = 0;
  const calls: { added: unknown[] } = { added: [] };
  return {
    calls,
    driver: {
      providerId: 'tivtaam', homeUrl: 'https://shop.example/', loginUrl: 'https://shop.example/login', cartUrl: 'https://shop.example/cart', allowAnonymous: false,
      isLoggedIn: async () => ++checks > (opts.loggedInAfter ?? 0),
      addItems: async (_p: unknown, lines: { productId: string }[]) => {
        calls.added.push(...lines);
        return { added: lines.filter((l) => !opts.fail?.includes(l.productId)).map((l) => l.productId), failed: lines.filter((l) => opts.fail?.includes(l.productId)).map((l) => ({ productId: l.productId, reason: 'אזל' })) };
      },
      readCart: async () => ({ itemCount: 2, total: 81.9 }),
    },
  };
}

const deps = (blocked = false, interactive = true) => {
  let b = blocked;
  return { pageFor: async () => fakePage() as never, isBlockedByVerification: async () => { const r = b; b = false; return r; }, interactive: () => interactive };
};

test('logged-in: only safe lines are added; missing/uncertain are reported, never guessed', async () => {
  const f = fakeDriver();
  const job = await _runForTest(quote(), f.driver as never, deps());
  assert.deepEqual(f.calls.added.map((l) => (l as { productId: string }).productId), ['11', '22']);
  assert.equal(job.status, 'partial', 'skipped lines mean the cart is not complete');
  assert.equal(job.lines.find((l) => l.needId === 'CREAM_CHEESE')!.state, 'skipped');
  assert.equal(job.cartTotal, 81.9);
  assert.equal(job.cartUrl, 'https://shop.example/cart');
  assert.equal(job.paymentBoundary, 'stopped_before_checkout');
});

test('login required: waits for the user, then continues', async () => {
  const f = fakeDriver({ loggedInAfter: 2 });
  const p = _runForTest(quote(), f.driver as never, deps());
  await new Promise((r) => setTimeout(r, 50));
  const { currentJob } = await import('../server/cart/prepare.ts');
  assert.equal(currentJob()!.status, 'login_required');
  resume();
  const job = await p;
  assert.equal(job.loginRequired, true);
  assert.ok(['ready', 'partial'].includes(job.status));
});

test('no screen + login needed → fails honestly instead of guessing', async () => {
  const f = fakeDriver({ loggedInAfter: 99 });
  const job = await _runForTest(quote(), f.driver as never, deps(false, false));
  assert.equal(job.status, 'failed');
  assert.equal(f.calls.added.length, 0);
});

test('verification (CAPTCHA) is left to the user, then continues', async () => {
  const f = fakeDriver();
  const job = await _runForTest(quote(), f.driver as never, deps(true, true));
  assert.ok(['ready', 'partial'].includes(job.status));
});

test('items the site rejects are listed as failed', async () => {
  const f = fakeDriver({ fail: ['22'] });
  const job = await _runForTest(quote(), f.driver as never, deps());
  assert.equal(job.lines.find((l) => l.productId === '22')!.state, 'failed');
  assert.equal(job.status, 'partial');
});

test('unsupported provider → no automation, clear message', async () => {
  const { startCartJob } = await import('../server/cart/prepare.ts');
  const job = startCartJob({ quote: quote('nosuchchain') });
  assert.equal(job.status, 'unsupported');
});

test('optional login (ZuZ): user can continue without logging in → anonymous cart, labelled', async () => {
  const f = fakeDriver({ loggedInAfter: 999 });
  const d = { ...f.driver, allowAnonymous: true };
  const p = _runForTest(quote(), d as never, deps());
  await new Promise((r) => setTimeout(r, 50));
  const { currentJob } = await import('../server/cart/prepare.ts');
  assert.equal(currentJob()!.userAction, 'login_optional');
  resume(true);
  const job = await p;
  assert.equal(job.anonymous, true);
  assert.ok(['ready', 'partial'].includes(job.status));
});
