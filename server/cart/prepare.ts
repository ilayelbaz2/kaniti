// Prepares the real online cart at the chosen supermarket and stops at the cart page.
// The user logs in / passes verification themselves in the supermarket window; checkout and payment stay
// entirely on the supermarket's side. Kaniti never submits an order.
import type { BasketQuote, CartJob, CartJobLine, CartJobStatus } from '../../shared/types.ts';
import { kvGet, kvSet, store } from '../db.ts';
import { nowIso, uid } from '../clock.ts';
import { DEMO } from '../providers/index.ts';
import { cartDriver, type CartDriver, type CartLineIn } from './drivers.ts';

let current: CartJob | null = kvGet<CartJob>('cartJob');
let poke: (() => void) | null = null;
const LOGIN_WAIT_MS = Number(process.env.KANITI_LOGIN_WAIT_MS ?? 10 * 60 * 1000);

export const currentJob = () => current;

function save(job: CartJob, patch: Partial<CartJob> & { status?: CartJobStatus }) {
  Object.assign(job, patch, { updatedAt: nowIso() });
  kvSet('cartJob', job);
}

let skipLogin = false;
/** User says "I logged in / I finished the check" — re-check right away instead of waiting for the next poll.
 *  `withoutLogin` continues with an anonymous cart on sites that allow it. */
export function resume(withoutLogin = false) { if (withoutLogin) skipLogin = true; poke?.(); }

async function waitFor(check: () => Promise<boolean>, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check().catch(() => false)) return true;
    await new Promise<void>((r) => { poke = r; setTimeout(r, 3000); });
    poke = null;
  }
  return false;
}

export type PrepareInput = { quote: BasketQuote; demo?: boolean };

export function startCartJob({ quote }: PrepareInput, autorun = true): CartJob {
  const driver = cartDriver(quote.providerId);
  const lines: CartJobLine[] = quote.lines.map((l) => ({
    needId: l.needId, label: l.label, productId: l.product?.productId, productName: l.product?.name,
    quantity: l.quantity, price: l.product ? +(l.lineTotal / Math.max(1, l.quantity)).toFixed(2) : undefined,
    state: l.missing || l.uncertain || !l.product ? 'skipped' : 'pending',
    reason: l.uncertain ? 'לא בטוח שזה המוצר הנכון — בחרו בעצמכם' : l.missing || !l.product ? 'לא נמצא ברשת הזאת' : undefined,
  }));
  const job: CartJob = {
    id: uid('cart_'), providerId: quote.providerId, providerName: quote.providerName,
    status: driver ? 'starting' : 'unsupported',
    message: driver ? `פותח את ${quote.providerName}…` : `הכנת עגלה לא נתמכת ב${quote.providerName} — אפשר להזמין לפי הרשימה.`,
    startedAt: nowIso(), updatedAt: nowIso(), lines, substitutions: quote.substitutionsCount,
    plannedTotal: quote.total, deliveryFee: quote.deliveryFee, loginRequired: false,
    paymentBoundary: 'stopped_before_checkout', demo: DEMO || undefined,
  };
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

  const todo: CartLineIn[] = job.lines.filter((l) => l.state === 'pending' && l.productId)
    .map((l) => ({ productId: l.productId!, quantity: l.quantity, name: l.productName ?? l.label, byWeight: /ק"?ג/.test(l.productName ?? '') }));
  save(job, { status: 'adding', userAction: undefined, anonymous: !loggedIn, message: `מוסיף ${todo.length} פריטים לעגלה ב${job.providerName}…` });
  const res = await driver.addItems(page, todo);
  for (const l of job.lines) {
    if (!l.productId || l.state !== 'pending') continue;
    const f = res.failed.find((x) => x.productId === l.productId);
    if (f) { l.state = 'failed'; l.reason = f.reason; } else if (res.added.includes(l.productId)) l.state = 'added';
    else { l.state = 'failed'; l.reason = 'לא אושר על ידי האתר'; }
  }
  const cart = await driver.readCart(page).catch(() => ({}) as Awaited<ReturnType<CartDriver['readCart']>>);
  if (page.url() !== driver.cartUrl) await page.goto(driver.cartUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  finish(job, driver.cartUrl, cart);
}

function finish(job: CartJob, cartUrl: string, cart: { itemCount?: number; total?: number; deliveryWindow?: string }) {
  const added = job.lines.filter((l) => l.state === 'added').length;
  const notAdded = job.lines.filter((l) => l.state === 'failed' || l.state === 'skipped').length;
  const status: CartJobStatus = added === 0 ? 'failed' : notAdded ? 'partial' : 'ready';
  save(job, {
    status, cartUrl, cartTotal: cart.total, cartItemCount: cart.itemCount, deliveryWindow: cart.deliveryWindow,
    message: status === 'ready' ? `העגלה מוכנה ב${job.providerName} 🎯` : status === 'partial' ? `הכנתי את רוב העגלה — ${added}/${job.lines.length} פריטים נוספו` : `לא הצלחתי להוסיף פריטים לעגלה ב${job.providerName}.`,
  });
}

/** Demo mode (KANITI_DEMO=1): no browser, clearly labelled. Lets the UI flow be exercised offline. */
async function runDemo(job: CartJob) {
  await new Promise((r) => setTimeout(r, 400));
  save(job, { status: 'adding', message: `מוסיף ${job.lines.filter((l) => l.state === 'pending').length} פריטים (דמו)…` });
  await new Promise((r) => setTimeout(r, 600));
  for (const l of job.lines) if (l.state === 'pending') l.state = 'added';
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
export async function _runForTest(quote: BasketQuote, driver: CartDriver, deps: BrowserDeps) {
  const job = startCartJob({ quote }, false);
  await run(job, driver, deps);
  return job;
}
