// Prepares the real online cart at the chosen supermarket and stops at the cart page.
// The user logs in / passes verification themselves in the supermarket window; checkout and payment stay
// entirely on the supermarket's side. Kaniti never submits an order.
import type { BasketQuote, CartJob, CartJobLine, CartJobStatus, ProviderDelivery } from '../../shared/types.ts';
import { kvGet, kvSet, store } from '../db.ts';
import { nowIso, uid } from '../clock.ts';
import { DEMO } from '../providers/index.ts';
import { cartDriver, type CartDriver, type CartLineIn } from './drivers.ts';
import { assessDelivery, recordDelivery, stillValid, type AssessOpts } from './delivery.ts';

let current: CartJob | null = kvGet<CartJob>('cartJob');
let poke: (() => void) | null = null;
const LOGIN_WAIT_MS = Number(process.env.KANITI_LOGIN_WAIT_MS ?? 10 * 60 * 1000);

/** The job as the UI should see it — a delivery result checked against an address that has since changed is not trusted. */
export const currentJob = () => (current?.delivery ? { ...current, delivery: stillValid(current.delivery, store.household()?.homeAddress) } : current);

function save(job: CartJob, patch: Partial<CartJob> & { status?: CartJobStatus }) {
  Object.assign(job, patch, { updatedAt: nowIso() });
  kvSet('cartJob', job);
}

let skipLogin = false;
let skipAddress = false;
/** User says "I logged in / I finished the check / I chose the address" — re-check right away instead of waiting for
 *  the next poll. `skip` continues without login (anonymous cart, where allowed) or without a confirmed address. */
export function resume(skip = false) { if (skip) { skipLogin = true; skipAddress = true; } poke?.(); }

async function waitFor(check: () => Promise<boolean>, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check().catch(() => false)) return true;
    await new Promise<void>((r) => { poke = r; setTimeout(r, 3000); });
    poke = null;
  }
  return false;
}

export type PrepareInput = { quote: BasketQuote; demo?: boolean; verifyOnly?: boolean };

export function startCartJob({ quote, verifyOnly }: PrepareInput, autorun = true): CartJob {
  const driver = cartDriver(quote.providerId);
  const lines: CartJobLine[] = quote.lines.map((l) => ({
    needId: l.needId, label: l.label, productId: l.product?.productId, productName: l.product?.name,
    quantity: l.quantity, price: l.product ? +(l.lineTotal / Math.max(1, l.quantity)).toFixed(2) : undefined,
    byWeight: /לק"?ג|לקג/.test(l.product?.sizeText ?? '') || /לק"?ג/.test(l.product?.name ?? ''),
    state: l.missing || l.uncertain || !l.product ? 'skipped' : 'pending',
    reason: l.uncertain ? 'לא בטוח שזה המוצר הנכון — בחרו בעצמכם' : l.missing || !l.product ? 'לא נמצא ברשת הזאת' : undefined,
  }));
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
  if (driver && autorun) void (DEMO ? runDemo(job) : run(job, driver)).catch((e) => save(job, { status: 'failed', message: `משהו השתבש בהכנת העגלה: ${(e as Error).message}` }));
  return job;
}

type BrowserDeps = Pick<typeof import('./browser.ts'), 'pageFor' | 'isBlockedByVerification' | 'interactive'>;

async function run(job: CartJob, driver: CartDriver, deps?: BrowserDeps) {
  const { pageFor, isBlockedByVerification, interactive } = deps ?? (await import('./browser.ts'));
  const page = await pageFor(driver.homeUrl);

  if (await isBlockedByVerification(page)) {
    if (!interactive()) return save(job, { status: 'failed', message: `${job.providerName} מבקשת אימות אנושי, ואין כאן מסך לפתוח בו את האתר. הפעילו את קניתי במחשב הביתי.` });
    save(job, { status: 'verification_required', userAction: 'verification', message: `${job.providerName} מבקשת אימות (CAPTCHA). השלימו אותו בחלון שנפתח — אני ממשיך אחרי זה.` });
    if (!(await waitFor(async () => !(await isBlockedByVerification(page)), LOGIN_WAIT_MS))) {
      return save(job, { status: 'failed', userAction: undefined, message: 'האימות לא הושלם. אפשר לנסות שוב.' });
    }
  }

  let loggedIn = await driver.isLoggedIn(page);
  // Logged-in carts sync to the account (and the phone app). Anonymous carts only live in this browser window.
  if (!loggedIn && (!driver.allowAnonymous || interactive())) {
    if (!interactive()) return save(job, { status: 'failed', loginRequired: true, message: `צריך להתחבר ל${job.providerName}, ואין כאן מסך. הפעילו את קניתי במחשב הביתי.` });
    skipLogin = false;
    await page.goto(driver.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    save(job, {
      status: 'login_required', loginRequired: true, userAction: driver.allowAnonymous ? 'login_optional' : 'login',
      message: `התחברו לחשבון שלכם ב${job.providerName} בחלון שנפתח (כולל קוד SMS אם נשלח). אני ממשיך לבד ברגע שתתחברו.`,
    });
    loggedIn = await waitFor(async () => (driver.allowAnonymous && skipLogin) || driver.isLoggedIn(page), LOGIN_WAIT_MS) && (await driver.isLoggedIn(page));
    if (!loggedIn && !(driver.allowAnonymous && skipLogin)) return save(job, { status: 'failed', userAction: undefined, message: 'לא זיהיתי התחברות. אפשר לנסות שוב.' });
    await page.goto(driver.homeUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  }

  // Delivery to the household's address, read from the supermarket page itself. The user picks / confirms the
  // address in the supermarket window; Kaniti never fills in or changes it.
  const home = store.household()?.homeAddress;
  const check = async (opts: AssessOpts = {}) =>
    assessDelivery(job.providerId, await Promise.resolve().then(() => driver.readDelivery(page)).catch(() => ({ pageOk: false })), home, opts);
  let delivery = await check();
  if (delivery.deliveryStatus === 'user_action_required' && interactive()) {
    skipAddress = false;
    save(job, {
      status: 'address_required', userAction: 'address', delivery,
      message: `בחרו או אשרו את כתובת המשלוח שלכם באתר ${job.providerName}, בחלון שנפתח. ${delivery.restrictionMessage ?? ''} אני ממשיך ברגע שהאתר יציג את הכתובת.`.trim(),
    });
    await waitFor(async () => {
      if (skipAddress) return true;
      delivery = await check();
      return delivery.deliveryStatus !== 'user_action_required';
    }, LOGIN_WAIT_MS);
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

  const todo: CartLineIn[] = job.lines.filter((l) => l.state === 'pending' && l.productId)
    .map((l) => ({ productId: l.productId!, quantity: l.quantity, name: l.productName ?? l.label, byWeight: l.byWeight }));
  save(job, { status: 'adding', userAction: undefined, anonymous: !loggedIn, delivery, message: `מוסיף ${todo.length} פריטים לעגלה ב${job.providerName}…` });
  const res = await driver.addItems(page, todo);
  for (const l of job.lines) {
    if (!l.productId || l.state !== 'pending') continue;
    const f = res.failed.find((x) => x.productId === l.productId);
    if (f) { l.state = 'failed'; l.reason = f.reason; } else if (res.added.includes(l.productId)) l.state = 'added';
    else { l.state = 'failed'; l.reason = 'לא אושר על ידי האתר'; }
  }
  const cart = await driver.readCart(page).catch(() => ({}) as Awaited<ReturnType<CartDriver['readCart']>>);
  // Re-read delivery with the items in the cart: fee / minimum / windows can depend on the cart, and the address
  // must still be the one confirmed before adding (otherwise the cart is not tied to the household's address).
  const added = job.lines.filter((l) => l.state === 'added').length;
  // If the page can't be re-read now, the cart isn't proven to be tied to the address — the status says so.
  delivery = await check({ previousAddressText: firstAddress, cartTotal: cart.total, basketCompleteness: job.lines.length ? added / job.lines.length : 0 });
  recordDelivery(delivery);
  if (page.url() !== driver.cartUrl) await page.goto(driver.cartUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  save(job, { delivery, ...feeFrom(job, delivery) });
  finish(job, driver.cartUrl, { ...cart, deliveryWindow: delivery.deliveryWindows?.[0] ?? cart.deliveryWindow });
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

function finish(job: CartJob, cartUrl: string, cart: { itemCount?: number; total?: number; deliveryWindow?: string }) {
  const added = job.lines.filter((l) => l.state === 'added').length;
  const notAdded = job.lines.filter((l) => l.state === 'failed' || l.state === 'skipped').length;
  const status: CartJobStatus = added === 0 ? 'failed' : notAdded ? 'partial' : 'ready';
  // The site's cart may already have had things in it — say so, so nothing unexpected gets paid for.
  const extra = cart.itemCount !== undefined ? cart.itemCount - added : 0;
  const base = status === 'ready' ? `העגלה מוכנה ב${job.providerName} 🎯` : status === 'partial' ? `הכנתי את רוב העגלה — ${added}/${job.lines.length} פריטים נוספו` : `לא הצלחתי להוסיף פריטים לעגלה ב${job.providerName}.`;
  save(job, {
    status, cartUrl, cartTotal: cart.total, cartItemCount: cart.itemCount, deliveryWindow: cart.deliveryWindow, preexistingItems: extra > 0 ? extra : undefined,
    message: extra > 0 && added > 0 ? `${base}. שימו לב: בעגלה יש עוד ${extra} פריטים שהיו שם קודם — בדקו לפני התשלום.` : base,
  });
}

/** Demo mode (KANITI_DEMO=1): no browser, clearly labelled. Lets the UI flow be exercised offline. */
async function runDemo(job: CartJob) {
  await new Promise((r) => setTimeout(r, 400));
  const demoDelivery: ProviderDelivery = { providerId: job.providerId, deliveryStatus: 'unknown', restrictionMessage: 'מצב דמו — לא נבדק מול אתר הרשת.', source: 'provider_page', checkedAt: nowIso() };
  if (job.verifyOnly) return save(job, { status: 'ready', delivery: demoDelivery, deliveryFeeEstimated: true, message: deliveryMessage(job.providerName, demoDelivery) });
  save(job, { status: 'adding', message: `מוסיף ${job.lines.filter((l) => l.state === 'pending').length} פריטים (דמו)…` });
  await new Promise((r) => setTimeout(r, 600));
  for (const l of job.lines) if (l.state === 'pending') l.state = 'added';
  job.delivery = demoDelivery;
  const total = job.lines.filter((l) => l.state === 'added').reduce((s, l) => s + (l.price ?? 0) * l.quantity, 0) + (job.deliveryFee ?? 0);
  finish(job, '#demo-cart', { total: Math.round(total * 100) / 100, itemCount: job.lines.filter((l) => l.state === 'added').length });
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
    items: j.lines.filter((l) => l.state === 'added').map((l) => ({ needId: l.needId, quantity: l.quantity, productName: l.productName, price: l.price })),
    basketId: basket?.id,
  };
}

/** Test hook: run a job against a fake driver/browser. */
export async function _runForTest(quote: BasketQuote, driver: CartDriver, deps: BrowserDeps, verifyOnly = false) {
  const job = startCartJob({ quote, verifyOnly }, false);
  await run(job, driver, deps);
  return job;
}
