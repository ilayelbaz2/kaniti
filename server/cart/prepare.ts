// Prepares the real online cart at the chosen supermarket and stops at the cart page.
// The user logs in / passes verification / chooses the address themselves in the supermarket window; checkout and
// payment stay entirely on the supermarket's side. Kaniti never submits an order.
//
// While the user is acting in that window, Kaniti never navigates or reloads it — it only reads (in-page fetches /
// app state) and only when the page has been quiet for a few seconds. A cart is "ready" only after the site's own
// cart has been read back and every planned line was found in it.
import type { BasketQuote, CartJob, CartJobLine, CartJobStatus, ProviderDelivery } from '../../shared/types.ts';
import type { Page } from 'playwright-core';
import { kvGet, kvSet, store } from '../db.ts';
import { nowIso, uid } from '../clock.ts';
import { DEMO } from '../providers/index.ts';
import { cartDriver, type CartDriver, type CartLineIn, type CartReadback } from './drivers.ts';
import { addressKey, assessDelivery, recordDelivery, stillValid, type AssessOpts } from './delivery.ts';

let current: CartJob | null = kvGet<CartJob>('cartJob');
let poke: (() => void) | null = null;
const LOGIN_WAIT_MS = Number(process.env.KANITI_LOGIN_WAIT_MS ?? 10 * 60 * 1000);
/** How long the supermarket page must stay still (same URL, no open dialog) before Kaniti reads it. */
const QUIET_MS = Number(process.env.KANITI_QUIET_MS ?? 6000);
const POLL_MS = Number(process.env.KANITI_POLL_MS ?? 3000);

/** The job as the UI should see it — a delivery result checked against an address that has since changed is not trusted. */
export const currentJob = () => (current?.delivery ? { ...current, delivery: stillValid(current.delivery, store.household()?.homeAddress) } : current);

function save(job: CartJob, patch: Partial<CartJob> & { status?: CartJobStatus }) {
  Object.assign(job, patch, { updatedAt: nowIso() });
  kvSet('cartJob', job);
}

// ---------- the user's buttons ----------

export type ResumeKind = 'continue' | 'skip_login' | 'skip_address';
const flags: Record<ResumeKind, boolean> = { continue: false, skip_login: false, skip_address: false };
/** "התחברתי / בחרתי כתובת — המשך" (continue), "המשך בלי להתחבר" (skip_login), "המשך בלי לאמת כתובת" (skip_address).
 *  `true` (old API) = skip whatever is being waited for now. */
export function resume(kind: ResumeKind | boolean = 'continue') {
  const k: ResumeKind = kind === true ? (current?.status === 'address_required' ? 'skip_address' : 'skip_login') : kind === false ? 'continue' : kind;
  flags[k] = true;
  poke?.();
}
const take = (k: ResumeKind) => { const v = flags[k]; flags[k] = false; return v; };
const sleep = (ms: number) => new Promise<void>((r) => { poke = r; setTimeout(r, ms); });

// ---------- waiting for the user without disturbing them ----------

/** URLs where the user is in the middle of something (login, registration, OTP, address, checkout). */
const BUSY_URL = /login|register|signup|sign-up|otp|verify|address|checkout|loginOrRegister/i;
const MODAL_OPEN = `function () {
  var els = document.querySelectorAll('[role=dialog], .modal.show, .modal.in, .v-modal, .el-dialog__wrapper, dialog[open]');
  for (var i = 0; i < els.length; i++) { var r = els[i].getBoundingClientRect(); if (r.width > 40 && r.height > 40 && getComputedStyle(els[i]).visibility !== 'hidden') return true; }
  return false;
}`;
async function userBusy(page: Page): Promise<{ url: string; busy: boolean }> {
  const url = page.url();
  const modal = await Promise.resolve().then(() => page.evaluate(`(${MODAL_OPEN})()`) as Promise<boolean>).catch(() => false);
  return { url, busy: BUSY_URL.test(url) || modal };
}

type WaitEnd = 'probe' | 'continue' | 'skip' | 'timeout';
/** Polls `probe` only while the page is quiet. Never navigates. The user's buttons end the wait immediately. */
async function waitForUser(page: Page, probe: () => Promise<boolean>, skipKind: ResumeKind | null): Promise<WaitEnd> {
  const until = Date.now() + LOGIN_WAIT_MS;
  let lastUrl = page.url(), changedAt = Date.now();
  while (Date.now() < until) {
    // A skip pressed for a different step (e.g. "continue without the address" while still logging in) doesn't carry over.
    for (const k of ['skip_login', 'skip_address'] as const) if (k !== skipKind) flags[k] = false;
    if (take('continue')) return 'continue';
    if (skipKind && take(skipKind)) return 'skip';
    const { url, busy } = await userBusy(page);
    if (url !== lastUrl) { lastUrl = url; changedAt = Date.now(); }
    if (!busy && Date.now() - changedAt >= QUIET_MS && (await probe().catch(() => false))) return 'probe';
    await sleep(POLL_MS);
    poke = null;
  }
  return 'timeout';
}

async function waitFor(check: () => Promise<boolean>, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check().catch(() => false)) return true;
    await sleep(POLL_MS);
    poke = null;
  }
  return false;
}

// ---------- job ----------

export type PrepareInput = { quote: BasketQuote; demo?: boolean; verifyOnly?: boolean };

export function startCartJob({ quote, verifyOnly }: PrepareInput, autorun = true): CartJob {
  const driver = cartDriver(quote.providerId);
  const lines: CartJobLine[] = quote.lines.map((l) => ({
    needId: l.needId, label: l.label, productId: l.product?.productId, productName: l.product?.name, brand: l.product?.brand, sizeText: l.product?.sizeText,
    quantity: l.quantity, price: l.product ? +(l.lineTotal / Math.max(1, l.quantity)).toFixed(2) : undefined,
    byWeight: l.product?.byWeight || /לק"?ג|לקג/.test(l.product?.sizeText ?? '') || /לק"?ג/.test(l.product?.name ?? ''),
    state: l.missing || l.uncertain || !l.product ? 'skipped' : 'pending',
    reason: l.uncertain ? 'לא בטוח שזה המוצר הנכון — בחרו בעצמכם' : l.missing || !l.product ? 'לא נמצא ברשת הזאת' : undefined,
  }));
  for (const k of Object.keys(flags) as ResumeKind[]) flags[k] = false;
  const job: CartJob = {
    id: uid('cart_'), providerId: quote.providerId, providerName: quote.providerName,
    status: driver ? 'starting' : 'unsupported',
    message: driver ? `פותח את ${quote.providerName}…` : `הכנת עגלה לא נתמכת ב${quote.providerName} — אפשר להזמין לפי הרשימה.`,
    startedAt: nowIso(), updatedAt: nowIso(), lines, substitutions: quote.substitutionsCount,
    plannedTotal: quote.total, deliveryFee: quote.deliveryFee, deliveryFeeEstimated: quote.deliveryFeeEstimated ?? true, loginRequired: false,
    paymentBoundary: 'stopped_before_checkout', demo: DEMO || undefined, verifyOnly: verifyOnly || undefined,
  };
  if (verifyOnly && driver) job.message = `פותח את ${quote.providerName} כדי לבדוק משלוח לכתובת שלכם…`;
  current = job;
  kvSet('cartJob', job);
  if (driver && autorun) void (DEMO ? runDemo(job) : run(job, driver)).catch((e) => save(job, { status: 'failed', userAction: undefined, message: `משהו השתבש בהכנת העגלה: ${(e as Error).message}` }));
  return job;
}

type BrowserDeps = Pick<typeof import('./browser.ts'), 'pageFor' | 'isBlockedByVerification' | 'interactive'>;

async function run(job: CartJob, driver: CartDriver, deps?: BrowserDeps) {
  const { pageFor, isBlockedByVerification, interactive } = deps ?? (await import('./browser.ts'));
  const page = await pageFor(driver.homeUrl);

  // 1. Bot check — the user completes it; we only look, never act on it.
  if (await isBlockedByVerification(page)) {
    if (!interactive()) return save(job, { status: 'failed', message: `${job.providerName} מבקשת אימות אנושי, ואין כאן מסך לפתוח בו את האתר. הפעילו את קניתי במחשב הביתי.` });
    save(job, { status: 'verification_required', userAction: 'verification', message: `${job.providerName} מבקשת אימות (CAPTCHA). השלימו אותו בחלון שנפתח — אני ממשיך אחרי זה.` });
    if (!(await waitFor(async () => take('continue') || !(await isBlockedByVerification(page)), LOGIN_WAIT_MS))) {
      return save(job, { status: 'failed', userAction: undefined, message: 'האימות לא הושלם. אפשר לנסות שוב.' });
    }
  }

  // 2. Login — logged-in carts sync to the account (and the phone app); anonymous ZuZ carts live only in this window.
  let loggedIn = await driver.isLoggedIn(page);
  if (!loggedIn && (!driver.allowAnonymous || interactive())) {
    if (!interactive()) return save(job, { status: 'failed', loginRequired: true, message: `צריך להתחבר ל${job.providerName}, ואין כאן מסך. הפעילו את קניתי במחשב הביתי.` });
    if (!BUSY_URL.test(page.url())) await page.goto(driver.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    const askLogin = (extra = '') => save(job, {
      status: 'login_required', loginRequired: true, userAction: driver.allowAnonymous ? 'login_optional' : 'login',
      message: `התחברו לחשבון שלכם ב${job.providerName} בחלון שנפתח (כולל קוד SMS אם נשלח). ${extra}אני ממשיך לבד ברגע שתסיימו.`,
    });
    askLogin();
    for (;;) {
      const end = await waitForUser(page, () => driver.isLoggedIn(page), driver.allowAnonymous ? 'skip_login' : null);
      loggedIn = await driver.isLoggedIn(page);
      if (loggedIn || end === 'skip') break;
      if (end === 'timeout') {
        if (driver.allowAnonymous) break;
        return save(job, { status: 'failed', userAction: undefined, message: 'לא זיהיתי התחברות. אפשר לנסות שוב.' });
      }
      askLogin('עדיין לא זיהיתי התחברות — סיימו באתר ולחצו שוב. '); // "התחברתי" pressed too early: keep waiting, nothing reloaded
    }
    // No navigation here: registration flows log the user in before their address step.
  }

  // 3. Delivery address — read from the site itself. The user picks / confirms it in the supermarket window.
  const home = store.household()?.homeAddress;
  const check = async (opts: AssessOpts = {}) =>
    assessDelivery(job.providerId, await Promise.resolve().then(() => driver.readDelivery(page, home)).catch(() => ({ pageOk: false })), home, opts);
  let delivery = await check();
  let addressNote: string | undefined; // why the address is not verified, kept for the final result
  if (delivery.deliveryStatus === 'user_action_required' && interactive()) {
    save(job, {
      status: 'address_required', userAction: 'address', delivery,
      message: `בחרו או אשרו את כתובת המשלוח שלכם באתר ${job.providerName}, בחלון שנפתח. ${delivery.restrictionMessage ?? ''} אני ממשיך לבד ברגע שהאתר יציג את הכתובת.`.trim(),
    });
    const end = await waitForUser(page, async () => { delivery = await check(); return delivery.deliveryStatus !== 'user_action_required'; }, 'skip_address');
    // "המשך" or a timeout: read once more and go on regardless — never send the user back to choose again.
    if (end === 'continue' || end === 'timeout') delivery = await check();
    if (delivery.deliveryStatus === 'user_action_required' && end !== 'probe') {
      addressNote = `${end === 'skip' ? 'המשכתי בלי לאמת את הכתובת' : 'לא הצלחתי לאמת את הכתובת באתר'} — בדקו אותה בעגלה לפני התשלום.`;
      delivery = { ...delivery, restrictionMessage: addressNote };
    }
  }
  if (delivery.deliveryStatus === 'unavailable') {
    recordDelivery(delivery);
    return save(job, { status: 'failed', userAction: undefined, delivery, message: `${job.providerName}: הרשת לא שולחת כרגע לכתובת הזו. ${delivery.restrictionMessage ?? ''}`.trim() });
  }
  if (job.verifyOnly) {
    recordDelivery(delivery);
    return save(job, { status: 'ready', userAction: undefined, anonymous: !loggedIn, delivery, ...feeFrom(job, delivery), message: deliveryMessage(job.providerName, delivery) });
  }
  const firstAddress = delivery.confirmedAddressText;

  // 4. Add the items, then read the site's cart back: only what is really there counts as added.
  const todo: CartLineIn[] = job.lines.filter((l) => l.state === 'pending' && l.productId)
    .map((l) => ({ productId: l.productId!, quantity: l.quantity, name: l.productName ?? l.label, byWeight: l.byWeight }));
  save(job, { status: 'adding', userAction: undefined, anonymous: !loggedIn, delivery, message: `מוסיף ${todo.length} פריטים לעגלה ב${job.providerName}…` });
  const res = await driver.addItems(page, todo);
  const readback = await Promise.resolve().then(() => driver.readCartLines(page, todo.map((t) => t.productId))).catch(() => null);
  applyReadback(job, res, readback);

  // 5. Delivery again, with the items in: fee / minimum can depend on the cart, and the address must still match.
  const added = job.lines.filter((l) => l.state === 'added').length;
  delivery = await check({ previousAddressText: firstAddress, cartTotal: readback?.total, basketCompleteness: job.lines.length ? added / job.lines.length : 0 });
  if (addressNote && delivery.deliveryStatus !== 'confirmed') delivery = { ...delivery, restrictionMessage: addressNote };
  recordDelivery(delivery);
  save(job, { delivery, ...feeFrom(job, delivery) });
  finish(job, driver.cartUrl, readback, delivery.deliveryWindows?.[0]);
}

/** Decides each line from the driver's claim AND the site's cart. Pure apart from mutating job lines. */
export function applyReadback(job: Pick<CartJob, 'lines'> & Partial<CartJob>, res: { added: string[]; failed: { productId: string; reason: string }[] }, readback: CartReadback | null) {
  const inCart = new Map((readback?.lines ?? []).map((l) => [l.productId, l.quantity]));
  for (const l of job.lines) {
    if (!l.productId || l.state !== 'pending') continue;
    const f = res.failed.find((x) => x.productId === l.productId);
    if (f) { l.state = 'failed'; l.reason = f.reason; continue; }
    if (!res.added.includes(l.productId)) { l.state = 'failed'; l.reason = 'האתר לא אישר את ההוספה'; continue; }
    if (!readback) { l.state = 'unverified'; l.reason = 'נשלח לאתר, אבל לא הצלחתי לוודא שהוא בעגלה'; continue; }
    if (!inCart.has(l.productId)) { l.state = 'failed'; l.reason = 'האתר לא שמר את הפריט בעגלה'; continue; }
    const q = inCart.get(l.productId);
    if (q !== undefined && q + 1e-6 < l.quantity * (l.byWeight ? 0.9 : 1)) { l.state = 'added'; l.reason = `בעגלה ${q} במקום ${l.quantity}`; continue; }
    l.state = 'added';
  }
  job.cartVerified = !!readback;
}

/** The site's own fee replaces the chain's list fee whenever the page showed one. */
function feeFrom(job: CartJob, d: ProviderDelivery): Partial<CartJob> {
  return d.deliveryFee !== undefined ? { deliveryFee: d.deliveryFee, deliveryFeeEstimated: false } : { deliveryFee: job.deliveryFee, deliveryFeeEstimated: true };
}

export const DELIVERY_TEXT: Record<ProviderDelivery['deliveryStatus'], string> = {
  confirmed: 'משלוח לכתובת שלך מאומת',
  unavailable: 'הרשת לא שולחת כרגע לכתובת הזו',
  user_action_required: 'צריך לבחור/לאשר כתובת באתר הסופר',
  unknown: 'לא הצלחתי לאמת משלוח לכתובת',
};

function deliveryMessage(name: string, d: ProviderDelivery) {
  return `${name}: ${DELIVERY_TEXT[d.deliveryStatus]}${d.restrictionMessage ? ` — ${d.restrictionMessage}` : ''}`;
}

function finish(job: CartJob, cartUrl: string, cart: CartReadback | null, deliveryWindow?: string) {
  const added = job.lines.filter((l) => l.state === 'added').length;
  const unverified = job.lines.filter((l) => l.state === 'unverified').length;
  const notAdded = job.lines.filter((l) => l.state === 'failed' || l.state === 'skipped').length;
  // A redirect, or items the site never confirmed, is never "ready".
  const status: CartJobStatus = added === 0 && unverified === 0 ? 'failed' : notAdded || unverified ? 'partial' : 'ready';
  const itemCount = cart?.itemCount ?? cart?.lines.length;
  const extra = itemCount !== undefined ? itemCount - added : 0; // things that were already in the site's cart
  const base = status === 'ready' ? `העגלה מוכנה ב${job.providerName} 🎯 — כל ${added} הפריטים נמצאים בעגלה באתר`
    : status === 'partial' ? (unverified && !added ? `שלחתי ${unverified} פריטים לאתר, אבל לא הצלחתי לוודא שהם בעגלה — בדקו אותה` : `לא הצלחתי להכין את כל העגלה — ${added}/${job.lines.length} פריטים נמצאים בעגלה באתר${unverified ? `, ${unverified} לא אומתו` : ''}`)
      : `לא הצלחתי להכניס פריטים לעגלה ב${job.providerName}.`;
  save(job, {
    status, cartUrl, cartTotal: cart?.total, cartItemCount: itemCount, deliveryWindow, preexistingItems: extra > 0 ? extra : undefined, userAction: undefined,
    message: extra > 0 && added > 0 ? `${base}. שימו לב: בעגלה יש עוד ${extra} פריטים שהיו שם קודם — בדקו לפני התשלום.` : base,
  });
}

/** Brings the automation window to the front on the prepared cart — the cart lives there (and in the account if
 *  logged in). Called by the "show me the cart" button, after the job finished. */
export async function showCart(deps?: Pick<typeof import('./browser.ts'), 'pageFor'>) {
  const job = current;
  if (!job || job.demo) return { ok: false, message: 'אין עגלה מוכנה להציג.' };
  const driver = cartDriver(job.providerId);
  if (!driver) return { ok: false, message: 'אין עגלה מוכנה להציג.' };
  const { pageFor } = deps ?? (await import('./browser.ts'));
  const page = await pageFor(driver.homeUrl);
  await page.goto(driver.cartUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.bringToFront().catch(() => {});
  return { ok: true, message: `העגלה פתוחה בחלון של ${job.providerName} במחשב.` };
}

/** Demo mode (KANITI_DEMO=1): no browser, clearly labelled. Lets the UI flow be exercised offline. */
async function runDemo(job: CartJob) {
  await new Promise((r) => setTimeout(r, 400));
  const demoDelivery: ProviderDelivery = { providerId: job.providerId, deliveryStatus: 'unknown', restrictionMessage: 'מצב דמו — לא נבדק מול אתר הרשת.', source: 'provider_page', checkedAt: nowIso(), addressKey: addressKey(store.household()?.homeAddress) };
  if (job.verifyOnly) return save(job, { status: 'ready', delivery: demoDelivery, deliveryFeeEstimated: true, message: deliveryMessage(job.providerName, demoDelivery) });
  save(job, { status: 'adding', message: `מוסיף ${job.lines.filter((l) => l.state === 'pending').length} פריטים (דמו)…` });
  await new Promise((r) => setTimeout(r, 600));
  const pending = job.lines.filter((l) => l.state === 'pending');
  job.delivery = demoDelivery;
  applyReadback(job, { added: pending.map((l) => l.productId!), failed: [] }, { lines: pending.map((l) => ({ productId: l.productId!, quantity: l.quantity })), source: 'page' });
  const total = job.lines.filter((l) => l.state === 'added').reduce((s, l) => s + (l.price ?? 0) * l.quantity, 0);
  finish(job, '#demo-cart', { lines: pending.map((l) => ({ productId: l.productId!, quantity: l.quantity })), total: Math.round(total * 100) / 100, source: 'page' });
}

export function clearJob() {
  current = null;
  kvSet('cartJob', null);
}

/** What the purchase-confirmation sheet starts from after a cart was prepared. */
export function cartSeed() {
  const j = current;
  if (!j || !['ready', 'partial'].includes(j.status)) return null;
  const basket = store.basket();
  return {
    providerId: j.providerId, providerName: j.providerName, total: j.cartTotal ?? j.plannedTotal,
    items: j.lines.filter((l) => l.state === 'added' || l.state === 'unverified').map((l) => ({ needId: l.needId, quantity: l.quantity, productName: l.productName, price: l.price })),
    basketId: basket?.id,
  };
}

/** Test hook: run a job against a fake driver/browser. */
export async function _runForTest(quote: BasketQuote, driver: CartDriver, deps: BrowserDeps, verifyOnly = false) {
  const job = startCartJob({ quote, verifyOnly }, false);
  await run(job, driver, deps);
  return job;
}
