// Per-supermarket cart drivers. Each one runs inside the real supermarket page (same-origin, the user's own
// session) and uses the same cart calls the website itself makes. No passwords, no payment, no checkout.
// Refs: grocery-compare/shufersal_cart.py, supermeskill (Rami Levy / Prutah-ZuZ), rami-levy-mcp (2026).
//
// Rule: isLoggedIn / readDelivery / readCartLines NEVER navigate the page. They run while the user may be in the
// middle of logging in or choosing an address in that same window — navigating would wipe what they're doing.
import type { Page } from 'playwright-core';
import { ZUZ_CHAINS } from '../providers/zuz.ts';
import { kvGet } from '../db.ts';
import type { Address } from '../../shared/types.ts';
import { fromZuz, parseDeliveryText, type DeliveryRead, type ZuzRaw } from './delivery.ts';

export type CartLineIn = { productId: string; quantity: number; name: string; byWeight?: boolean };
export type AddResult = { added: string[]; failed: { productId: string; reason: string }[] };
/** What the site's own cart holds after adding. `quantity` undefined = the site doesn't expose it. */
export type CartReadback = { lines: { productId: string; quantity?: number }[]; total?: number; itemCount?: number; source: 'server' | 'page' };

export interface CartDriver {
  providerId: string;
  homeUrl: string;
  loginUrl: string;
  cartUrl: string;
  /** Some sites keep an anonymous cart in the browser; others need an account. */
  allowAnonymous: boolean;
  isLoggedIn(page: Page): Promise<boolean>;
  addItems(page: Page, lines: CartLineIn[]): Promise<AddResult>;
  /** Reads the site's cart back (to verify what really got in). null = couldn't read it. Never navigates. */
  readCartLines(page: Page, wanted: string[]): Promise<CartReadback | null>;
  /** Delivery address / availability / fee / windows / minimum as the site itself shows them. Never navigates. */
  readDelivery(page: Page, home?: Address): Promise<DeliveryRead>;
}

/** Runs a function given as source text inside the page with one JSON argument (keeps bundler helpers out). */
const inPage = <T,>(page: Page, src: string, arg: unknown = null) => page.evaluate(`(${src})(${JSON.stringify(arg)})`) as Promise<T>;

/** HTML → readable text lines (block elements become line breaks). Pure; exported for tests. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript)[^]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/div|\/li|\/p|\/h\d|\/tr|\/section|\/button|\/label)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&').replace(/&#8362;|&#x20aa;/gi, '₪')
    .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

// ---------- Shufersal (Hybris): POST /online/he/cart/add with the XSRF token, like the "הוסף לסל" button ----------

const SHUF = 'https://www.shufersal.co.il';

/** Shufersal cart page HTML → which of our product codes are in it, the total, and the delivery facts. Pure. */
export function parseShufersalCart(html: string, wanted: string[]): { readback: CartReadback | null; text: string } {
  const text = htmlToText(html);
  const present = wanted.filter((code) => html.includes(code));
  const looksLikeCart = /סל הקניות|העגלה שלי|לתשלום|סה"כ|סיכום הזמנה|cart/i.test(text);
  const m = text.match(/לתשלום\s*:?\s*₪?\s*([\d,.]+)/) ?? text.match(/סה"כ\s*:?\s*₪?\s*([\d,.]+)/);
  if (!looksLikeCart) return { readback: null, text };
  return { readback: { lines: present.map((productId) => ({ productId })), total: m ? parseFloat(m[1].replace(/,/g, '')) : undefined, source: 'page' }, text };
}

const fetchText = (page: Page, path: string) => inPage<string | null>(page, `async function (p) {
  try { var r = await fetch(p, { credentials: 'include', headers: { Accept: 'text/html' } }); return r.ok ? (await r.text()).slice(0, 400000) : null; } catch (e) { return null; }
}`, path).catch(() => null);

const shufersal: CartDriver = {
  providerId: 'shufersal',
  homeUrl: `${SHUF}/online/he/A`,
  loginUrl: `${SHUF}/online/he/login`,
  cartUrl: `${SHUF}/online/he/cart`,
  allowAnonymous: false,
  async isLoggedIn(page) {
    return inPage<boolean>(page, `async function () {
      try { var r = await fetch('/online/he/my-account', { credentials: 'include' }); return r.ok && !/\\/login/.test(r.url); } catch (e) { return false; }
    }`).catch(() => false);
  },
  async addItems(page, lines) {
    return inPage<AddResult>(page, `async function (lines) {
      var xsrf = decodeURIComponent((document.cookie.match(/(?:^|; )XSRF-TOKEN=([^;]+)/) || [])[1] || '');
      var out = { added: [], failed: [] };
      for (var i = 0; i < lines.length; i++) {
        var l = lines[i];
        try {
          var qty = l.byWeight ? String(l.quantity) : String(Math.max(1, Math.round(l.quantity)));
          var r = await fetch('/online/he/cart/add?cartContext%5BopenFrom%5D=CATEGORY&cartContext%5BrecommendationType%5D=PRODUCT', {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json', Accept: '*/*', 'X-Requested-With': 'XMLHttpRequest', csrftoken: xsrf, 'X-XSRF-TOKEN': xsrf },
            body: JSON.stringify({ productCodePost: l.productId, productCode: l.productId, sellingMethod: l.byWeight ? 'BY_WEIGHT' : 'BY_UNIT', qty: qty, frontQuantity: qty, comment: '', affiliateCode: '' }),
          });
          var text = await r.text();
          if (!r.ok || /"errors"\\s*:\\s*\\[\\s*\\{/.test(text)) out.failed.push({ productId: l.productId, reason: 'HTTP ' + r.status });
          else out.added.push(l.productId);
        } catch (e) { out.failed.push({ productId: l.productId, reason: String(e) }); }
      }
      return out;
    }`, lines);
  },
  async readCartLines(page, wanted) {
    const html = await fetchText(page, '/online/he/cart');
    return html ? parseShufersalCart(html, wanted).readback : null;
  },
  async readDelivery(page) {
    // The cart page (fetched, not navigated to) shows the delivery address and the chosen / offered slot.
    const html = await fetchText(page, '/online/he/cart');
    return html ? parseDeliveryText(htmlToText(html)) : { pageOk: false };
  },
};

// ---------- Rami Levy (Nuxt): the logged-in token from the site's store + /api/v2/cart ----------

const RL = 'https://www.rami-levy.co.il';

/** Rami Levy cart response → product lines (the delivery-fee line is not a product). Pure. */
export function ramiCartLines(j: unknown): { lines: { productId: string; quantity?: number }[]; deliveryFee?: number; total?: number } | null {
  const o = j as { items?: { id: number | string; quantity?: number | string; is_delivery?: boolean; price?: number }[]; total?: number; price?: number } | null;
  if (!o || !Array.isArray(o.items)) return null;
  const delivery = o.items.find((it) => it.is_delivery);
  const lines = o.items.filter((it) => !it.is_delivery).map((it) => ({ productId: String(it.id), quantity: it.quantity !== undefined ? Number(it.quantity) : undefined }));
  const total = Number(o.total ?? o.price ?? NaN);
  return { lines, deliveryFee: delivery?.price !== undefined ? Number(delivery.price) : undefined, total: Number.isFinite(total) ? total : undefined };
}

const RL_CART = `async function (arg) {
  var root = document.querySelector('#__nuxt'); var vm = root && root.__vue__; var st = vm && vm.$store;
  var user = st && st.state && st.state.authuser && st.state.authuser.user;
  var headers = { 'Content-Type': 'application/json;charset=UTF-8', Accept: 'application/json', locale: 'he', ecomtoken: (user && user.token) || '' };
  var storeId = null; try { storeId = st.getters['cart/getStoreId']; } catch (e) {}
  storeId = String(storeId || (user && user.store_id) || arg.fallbackStore);
  var cur = null;
  try { var g = await fetch('/api/v2/cart', { headers: headers, credentials: 'include' }); cur = g.ok ? await g.json() : null; } catch (e) { cur = null; }
  if (arg.mode === 'read') return cur;
  // Never overwrite a cart we couldn't read — that would wipe what the user already had.
  if (!cur || !Array.isArray(cur.items)) return { error: 'cannot_read_cart' };
  var items = {};
  cur.items.forEach(function (it) { if (!it.is_delivery) items[String(it.id)] = String(it.quantity); });
  arg.lines.forEach(function (l) { items[l.productId] = Number(l.quantity).toFixed(2); });
  var supplyAt = new Date(Date.now() + 86400000).toISOString();
  var r = await fetch('/api/v2/cart', { method: 'POST', headers: headers, credentials: 'include', body: JSON.stringify({ store: storeId, isClub: 0, supplyAt: supplyAt, items: items, meta: null }) });
  if (!r.ok) return { error: 'HTTP ' + r.status };
  return await r.json().catch(function () { return { error: 'bad_json' }; });
}`;

// Looks through the site's own state for the delivery address / slot it has selected. Values stay in memory only.
const RL_DELIVERY = `async function () {
  var root = document.querySelector('#__nuxt'); var vm = root && root.__vue__; var st = vm && vm.$store;
  if (!st || !st.state) return null;
  var found = []; var seen = [];
  function walk(o, path, depth) {
    if (!o || typeof o !== 'object' || depth > 5 || seen.indexOf(o) >= 0 || found.length > 20) return;
    seen.push(o);
    var keys = Object.keys(o);
    var city = keys.filter(function (k) { return /^city(_name)?$|cityName/i.test(k); })[0];
    var street = keys.filter(function (k) { return /^street(_name)?$|streetName|^address(_line)?1?$/i.test(k); })[0];
    if (city && street && typeof o[city] === 'string' && typeof o[street] === 'string') {
      var num = keys.filter(function (k) { return /house|building|street_?num|^number$/i.test(k); })[0];
      found.push({ path: path, city: o[city], street: o[street], number: num != null ? String(o[num]) : undefined });
    }
    keys.forEach(function (k) { try { walk(o[k], path + '.' + k, depth + 1); } catch (e) {} });
  }
  walk(st.state, 'state', 0);
  var pick = found.filter(function (f) { return /deliver|ship|select|current|address|supply|order|checkout/i.test(f.path); })[0] || null;
  var user = st.state.authuser && st.state.authuser.user;
  var cart = null;
  try { var g = await fetch('/api/v2/cart', { headers: { Accept: 'application/json', locale: 'he', ecomtoken: (user && user.token) || '' }, credentials: 'include' }); cart = g.ok ? await g.json() : null; } catch (e) {}
  var slot = null; Object.keys(st.state).forEach(function (m) { var s = st.state[m]; if (s && typeof s === 'object') ['supplyAt', 'supply_at', 'selectedTime', 'deliveryTime', 'timeSlot'].forEach(function (k) { if (!slot && s[k] && typeof s[k] === 'string') slot = s[k]; }); });
  return { address: pick, candidates: found.length, cart: cart, slot: slot, loggedIn: !!(user && user.token) };
}`;

/** Rami Levy page state → delivery facts. Confirmed only with an address in the site's delivery state AND evidence
 *  of delivery (a delivery line in the cart or a chosen slot). Pure; exported for tests. */
export function ramiDelivery(raw: { address: { street: string; number?: string; city: string } | null; cart: unknown; slot: string | null } | null): DeliveryRead {
  if (!raw) return { pageOk: false };
  const cart = ramiCartLines(raw.cart);
  const read: DeliveryRead = { pageOk: true, fee: cart?.deliveryFee };
  if (!raw.address) return { ...read, restriction: 'לא מצאתי באתר כתובת משלוח שנבחרה.' };
  const number = raw.address.number ?? raw.address.street.match(/\d+/)?.[0];
  read.address = { street: raw.address.street.replace(/\s*\d+\s*$/, '').trim(), number, city: raw.address.city };
  read.addressSelected = true;
  if (cart?.deliveryFee !== undefined || raw.slot) read.available = true;
  if (raw.slot) read.windows = [raw.slot];
  return read;
}

const ramilevy: CartDriver = {
  providerId: 'ramilevy',
  homeUrl: `${RL}/he`,
  loginUrl: `${RL}/he`,
  cartUrl: `${RL}/he`,
  allowAnonymous: false,
  async isLoggedIn(page) {
    return inPage<boolean>(page, `function () {
      var root = document.querySelector('#__nuxt'); var st = root && root.__vue__ && root.__vue__.$store && root.__vue__.$store.state;
      return !!(st && st.authuser && st.authuser.user && st.authuser.user.token);
    }`).catch(() => false);
  },
  async addItems(page, lines) {
    const fallbackStore = kvGet<number>('provider:ramilevy:store') ?? 331;
    const j = await inPage<Record<string, unknown> | null>(page, RL_CART, { mode: 'add', lines, fallbackStore }).catch((e) => ({ error: String(e) }));
    const out: AddResult = { added: [], failed: [] };
    const parsed = j && !('error' in j) ? ramiCartLines(j) : null;
    if (!parsed) {
      const reason = j && 'error' in j && j.error === 'cannot_read_cart' ? 'לא הצלחתי לקרוא את העגלה הקיימת באתר — לא שיניתי אותה' : `האתר לא אישר (${(j as { error?: string })?.error ?? 'אין תשובה'})`;
      for (const l of lines) out.failed.push({ productId: l.productId, reason });
      return out;
    }
    const inCart = new Set(parsed.lines.map((x) => x.productId));
    for (const l of lines) {
      if (inCart.has(l.productId)) out.added.push(l.productId);
      else out.failed.push({ productId: l.productId, reason: 'לא נמצא בסניף שלכם' });
    }
    // The site's own cart view keeps its own copy; reload once so the window shows what's really in the cart.
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    return out;
  },
  async readCartLines(page) {
    const j = await inPage<unknown>(page, RL_CART, { mode: 'read', lines: [], fallbackStore: 0 }).catch(() => null);
    const p = ramiCartLines(j);
    return p ? { lines: p.lines, total: p.total, itemCount: p.lines.length, source: 'server' } : null;
  },
  async readDelivery(page) {
    return ramiDelivery(await inPage<Parameters<typeof ramiDelivery>[0]>(page, RL_DELIVERY).catch(() => null));
  },
};

// ---------- Stor.ai "ZuZ" chains (AngularJS): the site's own Cart service, which syncs to the account ----------

const ZUZ_READY = `function () { try { return !!window.angular.element(document.body).injector().get('Cart'); } catch (e) { return false; } }`;

function zuzDriver(id: string, host: string): CartDriver {
  return {
    providerId: id,
    homeUrl: host,
    loginUrl: `${host}/?loginOrRegister=1`,
    cartUrl: host,
    allowAnonymous: true,
    async isLoggedIn(page) {
      return inPage<boolean>(page, `function () {
        try { var U = window.angular.element(document.body).injector().get('User'); return !!(U && U.session && U.session.userId); } catch (e) { return false; }
      }`).catch(() => false);
    },
    async addItems(page, lines) {
      await page.waitForFunction(`(${ZUZ_READY})()`, null, { timeout: 30000 });
      return inPage<AddResult>(page, `async function (lines) {
        var Cart = window.angular.element(document.body).injector().get('Cart');
        var out = { added: [], failed: [] };
        var idOf = function (x) { return String((x.product && (x.product.id || x.product.productId)) || x.retailerProductId || ''); };
        for (var i = 0; i < lines.length; i++) {
          var l = lines[i];
          try {
            var existing = Object.keys(Cart.lines || {}).map(function (k) { return Cart.lines[k]; }).filter(function (x) { return idOf(x) === l.productId; })[0];
            if (existing) {
              existing.quantity = l.quantity;
              if (typeof Cart.quantityChanged === 'function') Cart.quantityChanged(existing);
            } else {
              await Cart.addLine({ product: { id: Number(l.productId) }, quantity: l.quantity, isCase: false });
            }
            out.added.push(l.productId);
          } catch (e) { out.failed.push({ productId: l.productId, reason: String((e && e.message) || e).slice(0, 120) }); }
        }
        // Push the changes to the server cart before we read it back.
        try { if (typeof Cart.save === 'function') await Cart.save(); } catch (e) {}
        await new Promise(function (r) { setTimeout(r, 2500); });
        return out;
      }`, lines);
    },
    async readCartLines(page) {
      // Only the site's own server cart counts — never the page's local copy. The site's $http carries its session
      // headers (a plain fetch may not); a short diagnostic is left on window for the live check.
      return inPage<CartReadback | null>(page, `async function () {
        var diag = window.__kanitiCartDiag = { tries: [] };
        try {
          var inj = window.angular.element(document.body).injector(); var Cart = inj.get('Cart'); var Config = inj.get('Config');
          var idOf = function (x) { return String(x.retailerProductId || (x.product && (x.product.id || x.product.productId)) || x.productId || ''); };
          var isProduct = function (x) { return !x.type || x.type === 1; };
          var t = Cart.total || {}; var total = Number(t.finalPriceForView != null ? t.finalPriceForView : t.priceForView);
          diag.serverCartId = Cart.serverCartId || null; diag.branch = Config.branch ? Config.branch.id : null;
          if (!Cart.serverCartId || !Config.branch) return null;
          var url = '/v2/retailers/' + Config.retailer.id + '/branches/' + Config.branch.id + '/carts/' + Cart.serverCartId;
          var linesOf = function (j) {
            if (!j) return null; var c = j.cart || j; var ls = c.lines;
            if (ls && !Array.isArray(ls) && typeof ls === 'object') ls = Object.keys(ls).map(function (k) { return ls[k]; });
            return Array.isArray(ls) ? ls : null;
          };
          var done = function (ls) { return { lines: ls.filter(isProduct).map(function (x) { return { productId: idOf(x), quantity: Number(x.quantity) }; }), total: isFinite(total) ? total : undefined, source: 'server' }; };
          try {
            var r1 = await inj.get('$http').get(url, { params: { appId: 4 } });
            var l1 = linesOf(r1.data);
            diag.tries.push({ via: 'http', status: r1.status, keys: Object.keys(r1.data || {}).slice(0, 12), lines: l1 ? l1.length : null });
            if (l1) return done(l1);
          } catch (e) { diag.tries.push({ via: 'http', status: e && e.status, err: String((e && (e.statusText || e.message)) || e).slice(0, 120) }); }
          var r = await fetch(url + '?appId=4', { credentials: 'include', headers: { Accept: 'application/json' } });
          var j = r.ok ? await r.json().catch(function () { return null; }) : null;
          var l2 = linesOf(j);
          diag.tries.push({ via: 'fetch', status: r.status, keys: j ? Object.keys(j).slice(0, 12) : null, lines: l2 ? l2.length : null });
          if (l2) return done(l2);
          return null;
        } catch (e) { diag.err = String(e).slice(0, 160); return null; }
      }`).catch(() => null);
    },
    async readDelivery(page, home) {
      // The site's own state: which delivery area the cart is set to, the site's lookup of the household address
      // against its delivery polygons, and the free delivery slots for that area. Read-only.
      const query = home?.street ? `${home.street}, ${home.city}` : '';
      return fromZuz(await inPage<ZuzRaw | null>(page, ZUZ_DELIVERY, { query }).catch(() => null));
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
