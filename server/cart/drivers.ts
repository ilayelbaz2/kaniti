// Per-supermarket cart drivers. Each one runs inside the real supermarket page (same-origin, the user's own
// session) and uses the same cart calls the website itself makes. No passwords, no payment, no checkout.
// Refs: grocery-compare/shufersal_cart.py, supermeskill (Rami Levy / Prutah-ZuZ), rami-levy-mcp (2026).
import type { Page } from 'playwright-core';
import { ZUZ_CHAINS } from '../providers/zuz.ts';
import { kvGet } from '../db.ts';
import type { Address } from '../../shared/types.ts';
import { fromZuz, parseDeliveryText, type DeliveryRead, type ZuzRaw } from './delivery.ts';

export type CartLineIn = { productId: string; quantity: number; name: string; byWeight?: boolean };
export type AddResult = { added: string[]; failed: { productId: string; reason: string }[] };
export type CartState = { itemCount?: number; total?: number; deliveryWindow?: string };

export interface CartDriver {
  providerId: string;
  homeUrl: string;
  loginUrl: string;
  cartUrl: string;
  /** Some sites keep an anonymous cart in the browser; others need an account. */
  allowAnonymous: boolean;
  isLoggedIn(page: Page): Promise<boolean>;
  addItems(page: Page, lines: CartLineIn[]): Promise<AddResult>;
  readCart(page: Page): Promise<CartState>;
  /** Delivery address / availability / fee / windows / minimum as the site itself shows them. Read-only. */
  readDelivery(page: Page, home?: Address): Promise<DeliveryRead>;
}

/** Visible text of the page (what the user sees). */
async function pageText(page: Page): Promise<string> {
  return (await page.locator('body').innerText({ timeout: 10000 }).catch(() => '')).slice(0, 40000);
}

// ---------- Shufersal (Hybris): POST /online/he/cart/add with the XSRF token, like the "הוסף לסל" button ----------

const SHUF = 'https://www.shufersal.co.il';
const shufersal: CartDriver = {
  providerId: 'shufersal',
  homeUrl: `${SHUF}/online/he/A`,
  loginUrl: `${SHUF}/online/he/login`,
  cartUrl: `${SHUF}/online/he/cart`,
  allowAnonymous: false,
  async isLoggedIn(page) {
    return page.evaluate(async () => {
      const r = await fetch('/online/he/my-account', { credentials: 'include' });
      return r.ok && !/\/login/.test(r.url);
    }).catch(() => false);
  },
  async addItems(page, lines) {
    return page.evaluate(async (lines) => {
      const xsrf = decodeURIComponent((document.cookie.match(/(?:^|; )XSRF-TOKEN=([^;]+)/) || [])[1] || '');
      const out = { added: [] as string[], failed: [] as { productId: string; reason: string }[] };
      for (const l of lines) {
        try {
          const qty = l.byWeight ? String(l.quantity) : String(Math.max(1, Math.round(l.quantity)));
          const r = await fetch('/online/he/cart/add?cartContext%5BopenFrom%5D=CATEGORY&cartContext%5BrecommendationType%5D=PRODUCT', {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json', Accept: '*/*', 'X-Requested-With': 'XMLHttpRequest', csrftoken: xsrf, 'X-XSRF-TOKEN': xsrf },
            body: JSON.stringify({ productCodePost: l.productId, productCode: l.productId, sellingMethod: l.byWeight ? 'BY_WEIGHT' : 'BY_UNIT', qty, frontQuantity: qty, comment: '', affiliateCode: '' }),
          });
          const text = await r.text();
          if (!r.ok || /"errors"\s*:\s*\[\s*\{/.test(text)) out.failed.push({ productId: l.productId, reason: `HTTP ${r.status}` });
          else out.added.push(l.productId);
        } catch (e) { out.failed.push({ productId: l.productId, reason: String(e) }); }
      }
      return out;
    }, lines);
  },
  async readCart(page) {
    await page.goto(this.cartUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2500);
    const body = (await page.locator('body').innerText({ timeout: 10000 }).catch(() => '')).slice(0, 20000);
    const m = body.match(/לתשלום\s*:?\s*[₪]?\s*([\d,.]+)/) ?? body.match(/שקלים חדשים\s*([\d,.]+)/);
    const slot = body.match(/(יום[^\n]{0,30}\d{1,2}\/\d{1,2}[^\n]{0,30}\d{1,2}:\d{2})/);
    return { total: m ? parseFloat(m[1].replace(/,/g, '')) : undefined, deliveryWindow: slot?.[1] };
  },
  async readDelivery(page) {
    // The cart page shows the delivery address, fee and the chosen / offered delivery slot for the logged-in account.
    if (!page.url().startsWith(this.cartUrl)) await page.goto(this.cartUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2500);
    return parseDeliveryText(await pageText(page));
  },
};

// ---------- Rami Levy (Nuxt): the logged-in token from the site's store + POST /api/v2/cart ----------

const RL = 'https://www.rami-levy.co.il';
const ramilevy: CartDriver = {
  providerId: 'ramilevy',
  homeUrl: `${RL}/he`,
  loginUrl: `${RL}/he`,
  cartUrl: `${RL}/he`,
  allowAnonymous: false,
  async isLoggedIn(page) {
    return page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const st = (document.querySelector('#__nuxt') as any)?.__vue__?.$store?.state;
      return !!st?.authuser?.user?.token;
    }).catch(() => false);
  },
  async addItems(page, lines) {
    const fallbackStore = kvGet<number>('provider:ramilevy:store') ?? 331;
    return page.evaluate(async ({ lines, fallbackStore }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const user = (document.querySelector('#__nuxt') as any)?.__vue__?.$store?.state?.authuser?.user;
      const headers = { 'Content-Type': 'application/json;charset=UTF-8', Accept: 'application/json', locale: 'he', ecomtoken: user?.token ?? '' };
      const store = String(user?.store_id ?? fallbackStore);
      // Keep whatever is already in the cart, set Kaniti's lines on top.
      let items: Record<string, string> = {};
      try {
        const cur = await (await fetch('/api/v2/cart', { headers, credentials: 'include' })).json();
        for (const it of cur?.items ?? []) items[String(it.id)] = String(it.quantity);
      } catch { items = {}; }
      for (const l of lines) items[l.productId] = l.quantity.toFixed(2);
      const supplyAt = new Date(Date.now() + 86400000).toISOString();
      const r = await fetch('/api/v2/cart', { method: 'POST', headers, credentials: 'include', body: JSON.stringify({ store, isClub: 0, supplyAt, items, meta: null }) });
      const out = { added: [] as string[], failed: [] as { productId: string; reason: string }[] };
      if (!r.ok) { for (const l of lines) out.failed.push({ productId: l.productId, reason: `HTTP ${r.status}` }); return out; }
      const j = await r.json().catch(() => ({}));
      const inCart = new Set((j?.items ?? []).map((it: { id: number | string }) => String(it.id)));
      for (const l of lines) {
        if (inCart.size === 0 || inCart.has(l.productId)) out.added.push(l.productId);
        else out.failed.push({ productId: l.productId, reason: 'לא נמצא בסניף שלכם' });
      }
      return out;
    }, { lines, fallbackStore });
  },
  async readCart(page) {
    return page.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const user = (document.querySelector('#__nuxt') as any)?.__vue__?.$store?.state?.authuser?.user;
      const j = await (await fetch('/api/v2/cart', { headers: { Accept: 'application/json', locale: 'he', ecomtoken: user?.token ?? '' }, credentials: 'include' })).json().catch(() => null);
      const total = Number(j?.total ?? j?.totals?.total ?? j?.price ?? NaN);
      return { itemCount: Array.isArray(j?.items) ? j.items.length : undefined, total: Number.isFinite(total) ? total : undefined };
    }).catch(() => ({}));
  },
  async readDelivery(page) {
    // The site shows the selected delivery address and slot in the header / cart panel for the logged-in account.
    await page.waitForTimeout(1500);
    return parseDeliveryText(await pageText(page));
  },
};

// ---------- Stor.ai "ZuZ" chains (AngularJS): the site's own Cart service, which syncs to the account ----------

function zuzDriver(id: string, host: string): CartDriver {
  return {
    providerId: id,
    homeUrl: host,
    loginUrl: `${host}/?loginOrRegister=1`,
    cartUrl: host,
    allowAnonymous: true,
    async isLoggedIn(page) {
      return page.evaluate(() => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const U = (window as any).angular.element(document.body).injector().get('User');
          return !!(U?.session?.userId);
        } catch { return false; }
      }).catch(() => false);
    },
    async addItems(page, lines) {
      await page.waitForFunction(() => {
        try { return !!(window as unknown as { angular: { element(e: Element): { injector(): unknown } } }).angular.element(document.body).injector(); } catch { return false; }
      }, null, { timeout: 30000 });
      return page.evaluate(async (lines) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const Cart = (window as any).angular.element(document.body).injector().get('Cart');
        const out = { added: [] as string[], failed: [] as { productId: string; reason: string }[] };
        for (const l of lines) {
          try {
            const existing = Object.values(Cart.lines ?? {}).find((x: unknown) => String((x as { product?: { id?: number } }).product?.id) === l.productId) as { quantity: number } | undefined;
            if (existing) { existing.quantity = l.quantity; out.added.push(l.productId); continue; }
            await Cart.addLine({ product: { id: Number(l.productId) }, quantity: l.quantity, isCase: false });
            out.added.push(l.productId);
          } catch (e) { out.failed.push({ productId: l.productId, reason: String((e as Error)?.message ?? e).slice(0, 120) }); }
        }
        await new Promise((r) => setTimeout(r, 3000)); // the Cart service syncs to the server in the background
        return out;
      }, lines);
    },
    async readCart(page) {
      return page.evaluate(() => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const Cart = (window as any).angular.element(document.body).injector().get('Cart');
          const t = Cart.total ?? {};
          const total = Number(t.finalPriceForView ?? t.priceForView ?? t.finalPrice ?? NaN);
          return { itemCount: Object.keys(Cart.lines ?? {}).length, total: Number.isFinite(total) ? total : undefined };
        } catch { return {}; }
      }).catch(() => ({}));
    },
    async readDelivery(page, home) {
      // The site's own state: which delivery area the cart is set to, the site's lookup of the household address
      // against its delivery polygons, and the free delivery slots for that area. Read-only.
      const query = home?.street ? `${home.street}, ${home.city}` : '';
      return fromZuz(await page.evaluate(`(${ZUZ_DELIVERY})(${JSON.stringify({ query })})`).catch(() => null) as ZuzRaw | null);
    },
  };
}

// Runs inside the ZuZ page. Kept as a string so the bundler can't inject helpers into it.
const ZUZ_DELIVERY = `async function (arg) {
  var inj = window.angular.element(document.body).injector();
  var Config = inj.get('Config'), Cart = inj.get('Cart'), User = inj.get('User');
  if (Config.initPromise) await Config.initPromise;
  var rid = Config.retailer.id, settings = Config.retailer.settings || {};
  var out = { query: arg.query, minOrder: Number(settings.minimumOrderPrice) > 0 ? Number(settings.minimumOrderPrice) : undefined, cartArea: null };
  var area = null; try { area = Config.getBranchArea(); } catch (e) { area = null; }
  var chosen = !!area && (Config.isAreaSelectedByUser || Config.isUserDefaultArea || !!(User.session && User.session.userId));
  if (chosen) out.cartArea = { id: area.id, name: area.name, deliveryTypeId: area.deliveryTypeId, fee: area.retailerBranchProductDeliveryPrice != null ? area.retailerBranchProductDeliveryPrice : area.retailerProductDeliveryPrice };
  if (arg.query) {
    var r = await fetch('/v2/retailers/' + rid + '/areas?appId=4&languageId=1&deliveryTypeId=1&deliveryTypeId=5&query=' + encodeURIComponent(arg.query), { credentials: 'include', headers: { Accept: 'application/json' } });
    var j = await r.json().catch(function () { return null; });
    out.lookup = { status: r.status, error: j && j.error, areas: ((j && j.areas) || []).map(function (a) { return { id: a.id, name: a.name, branchId: a.branchId, price: a.deliveryAreaPrice, min: a.deliveryMinimumCost }; }),
      components: ((j && j.addressComponents) || []).map(function (c) { return { name: c.long_name, types: c.types }; }) };
  }
  if (out.cartArea && Config.branch) {
    var t = await fetch('/v2/retailers/' + rid + '/branches/' + Config.branch.id + '/areas/' + area.id + '/delivery-times?appId=4', { credentials: 'include', headers: { Accept: 'application/json' } });
    var times = await t.json().catch(function () { return []; });
    out.slots = (Array.isArray(times) ? times : (times.times || [])).filter(function (s) { return s.isActive !== false && !s.isFull && s.newFrom; })
      .sort(function (a, b) { return a.newFrom < b.newFrom ? -1 : 1; }).slice(0, 12).map(function (s) { return { from: s.newFrom, to: s.newTo, price: s.deliveryTimePrice }; });
  }
  var dc = Cart.total && Cart.total.deliveryCost; if (dc && dc.finalPriceForView > 0) out.cartDeliveryCost = dc.finalPriceForView;
  return out;
}`;

const DRIVERS: CartDriver[] = [shufersal, ramilevy, ...ZUZ_CHAINS.map((c) => zuzDriver(c.id, c.host))];

export const cartDriver = (providerId: string) => DRIVERS.find((d) => d.providerId === providerId);
export const cartSupported = (providerId: string) => !!cartDriver(providerId);
