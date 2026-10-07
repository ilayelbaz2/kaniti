// Discovery probe (CI only, anonymous, read-only): prints which page services / API calls a ZuZ-platform site
// exposes for delivery address, fee, windows and minimum order. Never logs in, never goes to checkout.
// Usage: npx tsx scripts/delivery-probe.ts [providerId=tivtaam]
process.env.KANITI_BROWSER_PROFILE ??= 'data/browser-profile-probe';
const id = process.argv[2] ?? 'tivtaam';
const { ZUZ_CHAINS } = await import('../server/providers/zuz.ts');
const { pageFor, closeBrowser } = await import('../server/cart/browser.ts');
const chain = ZUZ_CHAINS.find((c) => c.id === id)!;
const page = await pageFor(chain.host);
page.on('response', async (r) => {
  const u = r.url();
  if (/\/v2\/.*(carts|areas|delivery|times)/.test(u)) {
    const body = await r.text().catch(() => '');
    console.log('PROBE-RESP', r.request().method(), u.replace(chain.host, '').slice(0, 160), body.slice(0, 2500));
  }
});
// In-page code is a string, so the bundler can't inject helpers into it.
const WAIT = `(() => { try { return !!window.angular.element(document.body).injector(); } catch (e) { return false; } })()`;
await page.waitForFunction(WAIT, null, { timeout: 45000 });
await page.waitForTimeout(4000);
const IN_PAGE = `(async () => {
  var inj = window.angular.element(document.body).injector();
  var get = function (n) { try { return inj.get(n); } catch (e) { return null; } };
  var out = {};
  function shape(o, d) {
    if (o === null || o === undefined) return o;
    if (typeof o === 'function') return 'fn';
    if (typeof o !== 'object') return typeof o === 'string' ? o.slice(0, 120) : o;
    if (d > 2) return Array.isArray(o) ? '[' + o.length + ']' : '{...}';
    var r = {}; Object.keys(o).slice(0, 60).forEach(function (k) { try { r[k] = shape(o[k], d + 1); } catch (e) { r[k] = '!'; } });
    return r;
  }
  function src(f) { return f ? String(f).replace(/\\s+/g, ' ').slice(0, 700) : null; }
  var Config = get('Config'), Cart = get('Cart'), User = get('User'), Areas = get('SpDeliveryAreasService'), Br = get('BranchesService');
  var cfg = {}; Object.keys(Config).filter(function (k) { return k !== 'retailer' && k !== 'retailers'; }).forEach(function (k) { cfg[k] = shape(Config[k], 1); });
  out.config = cfg;
  var st = (Config.retailer && Config.retailer.settings) || {}; var s2 = {};
  Object.keys(st).forEach(function (k) { if (/area|deliver|address|min|slot|fee|ship|time|precis/i.test(k)) s2[k] = shape(st[k], 1); });
  out.retailerSettings = s2;
  out.advancedArea = shape(Config.retailer && Config.retailer.advancedAreaAvailabilitySettings, 0);
  out.noSlotsMsgs = shape(Config.retailer && Config.retailer.shippingNoAvailableSlotsMessages, 0);
  out.branchSample = shape(Config.branch || (Config.retailer && Config.retailer.branches && Config.retailer.branches[0]), 0);
  try { out.branchArea = shape(await Config.getBranchArea(), 0); } catch (e) { out.branchArea = '! ' + String(e).slice(0, 100); }
  var proto = []; var p = Object.getPrototypeOf(Cart);
  while (p && p !== Object.prototype) { proto = proto.concat(Object.getOwnPropertyNames(p)); p = Object.getPrototypeOf(p); }
  out.cartProto = proto;
  var cv = {}; proto.concat(Object.keys(Cart)).forEach(function (k) { if (/total|deliver|fee|area|address|min|server|time|slot|branch/i.test(k)) { try { var v = Cart[k]; cv[k] = typeof v === 'function' ? src(v).slice(0, 300) : shape(v, 1); } catch (e) { cv[k] = '!'; } } });
  out.cartValues = cv;
  out.userData = shape(User.data, 0); out.userSession = shape(User.session, 0);
  out.src = {
    getBranchArea: src(Config.getBranchArea), changeBranch: src(Config.changeBranch), setUserArea: src(User.setUserArea),
    getAreaAddressText: src(Areas && Areas.getAreaAddressText), initBranchAndArea: src(Areas && Areas.initBranchAndArea),
    getAreas: src(Areas && Areas.getAreas), getChooseAreaMode: src(Areas && Areas.getChooseAreaMode), filterDeliveryAreas: src(Areas && Areas.filterDeliveryAreas),
    autoCompleteDeliveryAreasWithFullData: src(Areas && Areas.autoCompleteDeliveryAreasWithFullData),
    getAreaTimes: src(Br && Br.getAreaTimes), addDeliveryFeeLineIfNeeded: src(Cart.addDeliveryFeeLineIfNeeded),
  };
  try { out.chooseAreaMode = shape(await Areas.getChooseAreaMode(), 0); } catch (e) { out.chooseAreaMode = '! ' + String(e).slice(0, 100); }
  out.cookieNames = document.cookie.split(';').map(function (c) { return c.split('=')[0].trim(); });
  out.storage = Object.keys(localStorage).filter(function (k) { return /area|branch|address|deliver|cart/i.test(k); }).map(function (k) { return k + '=' + String(localStorage.getItem(k)).slice(0, 200); });
  return out;
})()`;
const dump = await page.evaluate(IN_PAGE) as Record<string, unknown>;
for (const [k, v] of Object.entries(dump)) console.log('PROBE-' + k, JSON.stringify(v).slice(0, 6000));
const { cartDriver } = await import('../server/cart/drivers.ts');
const { zuzProvider } = await import('../server/providers/zuz.ts');
const rows = await zuzProvider(chain).searchProducts('חלב').catch(() => []);
if (rows[0]) await cartDriver(id)!.addItems(page, [{ productId: rows[0].productId, quantity: 1, name: rows[0].name }]).catch((e) => console.log('add failed', String(e)));
await page.waitForTimeout(3000);
const after = await page.evaluate(IN_PAGE) as Record<string, unknown>;
console.log('PROBE-AFTER-cartValues', JSON.stringify(after.cartValues).slice(0, 6000));
console.log('PROBE-AFTER-branchArea', JSON.stringify(after.branchArea).slice(0, 2000));
await closeBrowser();
process.exit(0);
