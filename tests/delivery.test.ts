// Exact-address delivery verification: the status comes only from what the supermarket page shows.
process.env.KANITI_DB = ':memory:';
process.env.KANITI_LOGIN_WAIT_MS = '20000';
process.env.KANITI_QUIET_MS = '0';
process.env.KANITI_POLL_MS = '20';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BasketQuote, Household } from '../shared/types.ts';
import type { DeliveryRead } from '../server/cart/delivery.ts';
const { parseDeliveryText, assessDelivery, safeAddress, verifiedDelivery, recordDelivery } = await import('../server/cart/delivery.ts');
const { _runForTest, resume, currentJob } = await import('../server/cart/prepare.ts');
const { store } = await import('../server/db.ts');
const { rankQuotes } = await import('../server/engine/compare.ts');

const HOME = { city: 'רמת גן', street: 'ביאליק 12' };
const household = (homeAddress = HOME): Household => ({
  id: 'h', adults: 2, children: [{ age: 2 }], kosher: true, allergies: ['חלב'], dietNotes: [], homeAddress, driveSavingsThresholdNis: 60,
  onlineProviders: ['tivtaam'], physicalStores: [], flexibilityStyle: 'balanced', shopEveryDays: 14,
});
store.saveHousehold(household());

// What a supermarket cart page looks like (visible text) in each situation.
const PAGE = {
  confirmed: 'העגלה שלי\nכתובת למשלוח: ביאליק 12, רמת גן\nדמי משלוח: ₪29.90\nמינימום הזמנה ₪250\nבחרו מועד משלוח\nיום ה׳ 09/10 10:00-12:00\nיום ה׳ 09/10 12:00-14:00',
  noFee: 'כתובת למשלוח: ביאליק 12, רמת גן\nמועדי משלוח\nיום ו׳ 10/10 08:00-10:00',
  unavailable: 'כתובת למשלוח: ביאליק 12, רמת גן\nמצטערים, הכתובת אינה באזור החלוקה שלנו',
  chooseAddress: 'לאן לשלוח?\nבחרו כתובת למשלוח מהכתובות השמורות',
  cityOnly: 'משלוח ל: רמת גן\nיום ה׳ 09/10 10:00-12:00',
  otherAddress: 'כתובת למשלוח: הרצל 5, תל אביב\nיום ה׳ 09/10 10:00-12:00',
  noSlots: 'כתובת למשלוח: ביאליק 12, רמת גן\nדמי משלוח: ₪29.90',
};
const assess = (text: string, opts = {}) => assessDelivery('tivtaam', parseDeliveryText(text), HOME, opts);

test('confirmed: the site shows the household address and offers delivery slots for it', () => {
  const d = assess(PAGE.confirmed, { cartTotal: 300 });
  assert.equal(d.deliveryStatus, 'confirmed');
  assert.equal(d.confirmedAddressText, 'ביאליק 12, רמת גן');
  assert.equal(d.deliveryFee, 29.9);
  assert.equal(d.minimumOrder, 250);
  assert.equal(d.deliveryWindows?.length, 2);
  assert.equal(d.source, 'provider_page');
  assert.equal(d.restrictionMessage, undefined);
});

test('unavailable: the site refuses delivery to the selected address', () => {
  const d = assess(PAGE.unavailable);
  assert.equal(d.deliveryStatus, 'unavailable');
  assert.match(d.restrictionMessage!, /אינה באזור החלוקה/);
});

test('user action required: no address chosen, a city only, or a different address', () => {
  assert.equal(assess(PAGE.chooseAddress).deliveryStatus, 'user_action_required');
  const city = assess(PAGE.cityOnly);
  assert.equal(city.deliveryStatus, 'user_action_required', 'a city is never an exact address');
  const other = assess(PAGE.otherAddress);
  assert.equal(other.deliveryStatus, 'user_action_required');
  assert.match(other.restrictionMessage!, /כתובת אחרת/);
  assert.equal(other.confirmedAddressText, undefined);
});

test('never confirmed without the site accepting delivery, or without a street in the profile', () => {
  assert.equal(assess(PAGE.noSlots).deliveryStatus, 'unknown', 'an address with a fee but no slots/acceptance is not proof');
  assert.equal(assessDelivery('tivtaam', parseDeliveryText(PAGE.confirmed), { city: 'רמת גן' }).deliveryStatus, 'unknown');
  assert.equal(assessDelivery('tivtaam', { pageOk: false }, HOME).deliveryStatus, 'unknown');
});

test('missing delivery fee: still confirmed, but the fee stays unknown (never invented)', () => {
  const d = assess(PAGE.noFee);
  assert.equal(d.deliveryStatus, 'confirmed');
  assert.equal(d.deliveryFee, undefined);
});

test('minimum-order restriction is reported against the real cart total', () => {
  const d = assess(PAGE.confirmed, { cartTotal: 120 });
  assert.equal(d.deliveryStatus, 'confirmed');
  assert.match(d.restrictionMessage!, /מינימום הזמנה ₪250.*חסרים ₪130/);
});

test('display-safe address: no names, phone numbers or apartment details', () => {
  assert.equal(safeAddress({ addressText: 'ישראל ישראלי, ביאליק 12 דירה 4, רמת גן, 052-1234567' }, HOME), 'ביאליק 12, רמת גן');
  assert.equal(safeAddress({ address: { street: 'ביאליק', number: '12', city: 'רמת גן' } }), 'ביאליק 12, רמת גן');
  assert.equal(assess('כתובת למשלוח: רח\' ביאליק 12, ר"ג\nיום א 10:00-12:00').deliveryStatus, 'confirmed', 'abbreviations still match');
});

// ---------- inside the cart flow ----------

const quote = (): BasketQuote => ({
  providerId: 'tivtaam', providerName: 'טיב טעם אונליין', kind: 'online', ok: true, subtotal: 52, deliveryFee: 29.9, total: 81.9,
  completeness: 1, unavailableCount: 0, substitutionsCount: 0, source: 'live', fetchedAt: '',
  lines: [
    { needId: 'EGGS', label: 'ביצים', quantity: 2, lineTotal: 28, product: { providerId: 'tivtaam', productId: '11', name: 'ביצים L 12', price: 14, available: true, source: 'live', fetchedAt: '' } },
    { needId: 'MILK', label: 'חלב', quantity: 4, lineTotal: 24, product: { providerId: 'tivtaam', productId: '22', name: 'חלב 3%', price: 6, available: true, source: 'live', fetchedAt: '' } },
  ],
});
const fakePage = () => ({ url: () => 'https://shop.example/cart', goto: async () => {}, bringToFront: async () => {} });
const deps = (interactive = true) => ({ pageFor: async () => fakePage() as never, isBlockedByVerification: async () => false, interactive: () => interactive });

/** A fake supermarket whose delivery reads follow a script (one entry per read; the last one repeats). */
function fakeDriver(reads: (DeliveryRead | Error)[], loggedInAfter = 0) {
  let n = 0, checks = 0;
  const added: string[] = [];
  return {
    added,
    driver: {
      providerId: 'tivtaam', homeUrl: 'https://shop.example/', loginUrl: 'https://shop.example/login', cartUrl: 'https://shop.example/cart', allowAnonymous: false,
      isLoggedIn: async () => ++checks > loggedInAfter,
      addItems: async (_p: unknown, lines: { productId: string }[]) => { added.push(...lines.map((l) => l.productId)); return { added: lines.map((l) => l.productId), failed: [] }; },
      readCartLines: async () => ({ lines: added.map((productId) => ({ productId, quantity: productId === '11' ? 2 : 4 })), total: 300, source: 'server' as const }),
      readDelivery: async () => { const r = reads[Math.min(n++, reads.length - 1)]; if (r instanceof Error) throw r; return r; },
    },
  };
}
const R = (k: keyof typeof PAGE) => parseDeliveryText(PAGE[k]);

test('cart handoff: confirmed address, real fee replaces the list fee, cart tied to the address', async () => {
  const f = fakeDriver([R('confirmed')]);
  const job = await _runForTest(quote(), f.driver as never, deps());
  assert.equal(job.status, 'ready');
  assert.equal(job.delivery!.deliveryStatus, 'confirmed');
  assert.equal(job.delivery!.confirmedAddressText, 'ביאליק 12, רמת גן');
  assert.equal(job.deliveryFee, 29.9);
  assert.equal(job.deliveryFeeEstimated, false);
  assert.equal(job.delivery!.cartTotal, 300);
  assert.equal(job.delivery!.basketCompleteness, 1);
  assert.equal(job.deliveryWindow, 'יום ה׳ 09/10 10:00-12:00');
  assert.equal(job.paymentBoundary, 'stopped_before_checkout');
  assert.equal(verifiedDelivery('tivtaam', HOME)!.deliveryStatus, 'confirmed', 'stored for the Compare screen');
});

test('cart handoff: missing fee on the page → list fee kept and labelled as an estimate', async () => {
  const f = fakeDriver([R('noFee')]);
  const job = await _runForTest(quote(), f.driver as never, deps());
  assert.equal(job.delivery!.deliveryStatus, 'confirmed');
  assert.equal(job.deliveryFee, 29.9);
  assert.equal(job.deliveryFeeEstimated, true);
});

test('cart handoff: unavailable address → nothing is added to the cart', async () => {
  const f = fakeDriver([R('unavailable')]);
  const job = await _runForTest(quote(), f.driver as never, deps());
  assert.equal(job.status, 'failed');
  assert.equal(job.delivery!.deliveryStatus, 'unavailable');
  assert.equal(f.added.length, 0);
});

test('cart handoff: waits for the user to choose the address in the supermarket window, then continues by itself', async () => {
  let chosen = false;
  const f = fakeDriver([R('chooseAddress')]);
  const driver = { ...f.driver, readDelivery: async () => (chosen ? R('confirmed') : R('chooseAddress')) };
  const p = _runForTest(quote(), driver as never, deps());
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(currentJob()!.status, 'address_required');
  assert.equal(currentJob()!.userAction, 'address');
  assert.equal(f.added.length, 0, 'nothing added while waiting');
  chosen = true; // the user picks the address on the site — no button press needed
  const job = await p;
  assert.equal(job.delivery!.deliveryStatus, 'confirmed');
  assert.deepEqual(f.added, ['11', '22']);
});

test('cart handoff: no screen to choose an address → cart is prepared but delivery is NOT confirmed', async () => {
  const f = fakeDriver([R('chooseAddress')]);
  const job = await _runForTest(quote(), f.driver as never, deps(false));
  assert.equal(job.delivery!.deliveryStatus, 'user_action_required');
  assert.ok(['ready', 'partial'].includes(job.status));
});

test('stale cart address: the address on the site changes while preparing → not confirmed', async () => {
  const f = fakeDriver([R('confirmed'), R('otherAddress')]);
  const job = await _runForTest(quote(), f.driver as never, deps(false));
  assert.equal(job.delivery!.deliveryStatus, 'user_action_required');
});

test('stale cart address: the household address changed after the cart was prepared', async () => {
  const f = fakeDriver([R('confirmed')]);
  await _runForTest(quote(), f.driver as never, deps());
  assert.equal(currentJob()!.delivery!.deliveryStatus, 'confirmed');
  store.saveHousehold(household({ city: 'גבעתיים', street: 'כצנלסון 40' }));
  try {
    assert.equal(currentJob()!.delivery!.deliveryStatus, 'user_action_required');
    assert.equal(verifiedDelivery('tivtaam', store.household()!.homeAddress), undefined, 'old result is not reused for the new address');
  } finally { store.saveHousehold(household()); }
});

test('provider page changing after login: a page we cannot read is "unknown", never confirmed', async () => {
  // Before login the page is the anonymous one; after login the layout is not what the driver expects.
  const f = fakeDriver([R('chooseAddress'), { pageOk: false }], 1);
  const p = _runForTest(quote(), f.driver as never, deps());
  await new Promise((r) => setTimeout(r, 50));
  resume();
  const job = await p;
  assert.equal(job.delivery!.deliveryStatus, 'unknown');
  const g = fakeDriver([new Error('selector not found')]);
  const job2 = await _runForTest(quote(), g.driver as never, deps(false));
  assert.equal(job2.delivery!.deliveryStatus, 'unknown');
  assert.equal(job2.deliveryFeeEstimated, true);
});

test('verify only: reads delivery without adding anything to the cart', async () => {
  const f = fakeDriver([R('confirmed')]);
  const job = await _runForTest({ ...quote(), lines: [] }, f.driver as never, deps(), true);
  assert.equal(job.status, 'ready');
  assert.equal(job.delivery!.deliveryStatus, 'confirmed');
  assert.equal(f.added.length, 0);
});

test('ranking: a chain whose site refused the address is never recommended', () => {
  const q = (id: string, total: number, deliveryStatus: 'confirmed' | 'unavailable'): BasketQuote => ({ ...quote(), providerId: id, providerName: id, total, deliveryStatus });
  const { recommendation } = rankQuotes([q('cheap', 100, 'unavailable'), q('ok', 150, 'confirmed')], { items: [] } as never, 60);
  assert.equal(recommendation.winnerId, 'ok');
  recordDelivery({ providerId: 'x', deliveryStatus: 'confirmed', source: 'provider_page', checkedAt: new Date(Date.now() - 20 * 86400000).toISOString(), addressKey: 'רמת גן|ביאליק 12' });
  assert.equal(verifiedDelivery('x', HOME), undefined, 'results older than two weeks are not trusted');
});

// ---------- ZuZ sites: real response shapes from tivtaam.co.il (Oct 2026) ----------
const { fromZuz } = await import('../server/cart/delivery.ts');
type ZuzRaw = import('../server/cart/delivery.ts').ZuzRaw;
const LOOKUP_OK = {
  status: 200, areas: [{ id: 2450, name: 'רמת גן מרכז', branchId: 924, price: 29.9, min: null }],
  components: [{ name: '12', types: ['street_number'] }, { name: 'ביאליק', types: ['route'] }, { name: 'רמת גן', types: ['locality', 'political'] }],
};
const SLOTS = [{ from: '2026-10-10T12:30:00.000Z', to: '2026-10-10T14:30:00.000Z', price: 29.9 }, { from: '2026-10-11T13:00:00.000Z', to: '2026-10-11T15:00:00.000Z', price: 29.9 }];
const zuz = (raw: Partial<ZuzRaw>, opts = {}) => assessDelivery('tivtaam', fromZuz({ query: 'ביאליק 12, רמת גן', minOrder: 300, lookup: LOOKUP_OK, ...raw } as ZuzRaw), HOME, opts);

test('ZuZ: cart area = the area the site resolves for the household address → confirmed with the site fee, slots, minimum', () => {
  const d = zuz({ cartArea: { id: 2450, name: 'רמת גן מרכז', deliveryTypeId: 1, fee: 29.9 }, slots: SLOTS }, { cartTotal: 320 });
  assert.equal(d.deliveryStatus, 'confirmed');
  assert.equal(d.confirmedAddressText, 'ביאליק 12, רמת גן');
  assert.equal(d.deliveryFee, 29.9);
  assert.equal(d.minimumOrder, 300);
  assert.equal(d.deliveryWindows?.length, 2);
  assert.match(d.deliveryWindows![0], /15:30–17:30/, 'slot times shown in Israel time');
});

test('ZuZ: cart set to another area, to pickup, or to no area → user action required (never confirmed)', () => {
  const other = zuz({ cartArea: { id: 10006, name: 'רמת גן', deliveryTypeId: 1, fee: 29.9 }, slots: SLOTS });
  assert.equal(other.deliveryStatus, 'user_action_required');
  assert.match(other.restrictionMessage!, /משויכת לאזור "רמת גן".*"רמת גן מרכז"/);
  assert.equal(zuz({ cartArea: { id: 1079, name: 'איסוף', deliveryTypeId: 2 } }).deliveryStatus, 'user_action_required');
  const none = zuz({ cartArea: null });
  assert.equal(none.deliveryStatus, 'user_action_required');
  assert.match(none.restrictionMessage!, /עוד לא משויכת/);
});

test('ZuZ: the site says the address is outside its delivery areas → unavailable; unknown address → user action', () => {
  const out = zuz({ query: 'ביאליק 12, רמת גן', lookup: { status: 404, error: 'Area not found', areas: [], components: [] }, cartArea: null });
  assert.equal(out.deliveryStatus, 'unavailable');
  assert.equal(out.confirmedAddressText, 'ביאליק 12, רמת גן');
  const bad = zuz({ lookup: { status: 400, error: 'Address not found', areas: [], components: [] } });
  assert.equal(bad.deliveryStatus, 'user_action_required');
});

test('ZuZ: geocoder snapped to a different street → not the household address → user action', () => {
  const lookup = { ...LOOKUP_OK, components: [{ name: '12', types: ['street_number'] }, { name: 'ז׳בוטינסקי', types: ['route'] }, { name: 'רמת גן', types: ['locality'] }] };
  assert.equal(zuz({ lookup, cartArea: { id: 2450, name: 'רמת גן מרכז', deliveryTypeId: 1 }, slots: SLOTS }).deliveryStatus, 'user_action_required');
});

test('ZuZ: no free slots → address accepted (confirmed) but the restriction says so; cart delivery line wins over area price', () => {
  const d = zuz({ cartArea: { id: 2450, name: 'רמת גן מרכז', deliveryTypeId: 1, fee: 29.9 }, slots: [], cartDeliveryCost: 19.9 });
  assert.equal(d.deliveryStatus, 'confirmed');
  assert.match(d.restrictionMessage!, /אין כרגע חלונות משלוח/);
  assert.equal(d.deliveryFee, 19.9);
  assert.equal(d.deliveryWindows, undefined);
});

test('ZuZ: minimum order from the site against the real cart total', () => {
  const d = zuz({ cartArea: { id: 2450, name: 'רמת גן מרכז', deliveryTypeId: 1, fee: 29.9 }, slots: SLOTS }, { cartTotal: 120 });
  assert.match(d.restrictionMessage!, /מינימום הזמנה ₪300/);
});

test('ZuZ: page not readable (structure changed / not loaded) → unknown', () => {
  assert.equal(assessDelivery('tivtaam', fromZuz(null), HOME).deliveryStatus, 'unknown');
});
