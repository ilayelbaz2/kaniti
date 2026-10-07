// Discovery probe (CI only, anonymous, read-only): prints which page services / API calls a ZuZ-platform site
// exposes for delivery address, fee, windows and minimum order. Never logs in, never goes to checkout.
// Usage: npx tsx scripts/delivery-probe.ts [providerId=tivtaam]
process.env.KANITI_BROWSER_PROFILE ??= 'data/browser-profile-probe';
const id = process.argv[2] ?? 'tivtaam';
const { ZUZ_CHAINS } = await import('../server/providers/zuz.ts');
const { pageFor, closeBrowser } = await import('../server/cart/browser.ts');
const chain = ZUZ_CHAINS.find((c) => c.id === id)!;
const page = await pageFor(chain.host);
const calls: string[] = [];
page.on('request', (r) => { const u = r.url(); if (/\/v2\//.test(u) && !/products\?|\.(png|jpg|svg|css|js)/.test(u)) calls.push(`${r.method()} ${u.replace(chain.host, '').slice(0, 200)}`); });
await page.waitForFunction(() => { try { return !!(window as any).angular.element(document.body).injector(); } catch { return false; } }, null, { timeout: 45000 });
await page.waitForTimeout(4000);
// A string, so the bundler can't inject helpers into code that runs inside the page.
const IN_PAGE = `(() => {
  var ng = window.angular; var inj = ng.element(document.body).injector();
  var root = document.querySelector('[ng-app],[data-ng-app]');
  var appName = root ? (root.getAttribute('ng-app') || root.getAttribute('data-ng-app') || '') : '';
  var seen = {}; var names = {};
  function walk(m) { if (seen[m]) return; seen[m] = 1; try { var mod = ng.module(m); (mod._invokeQueue || []).forEach(function (q) { if (q[2] && typeof q[2][0] === 'string') names[q[2][0]] = 1; }); (mod.requires || []).forEach(walk); } catch (e) {} }
  walk(appName);
  var all = Object.keys(names);
  var rel = all.filter(function (n) { return /cart|deliver|area|address|branch|config|^user$|shipping|time|order|checkout|retailer|min|fee/i.test(n); });
  function shape(o, d) {
    if (o === null || o === undefined) return o;
    if (typeof o === 'function') return 'fn';
    if (typeof o !== 'object') return typeof o === 'string' ? o.slice(0, 80) : o;
    if (d > 1) return Array.isArray(o) ? '[' + o.length + ']' : '{...}';
    var out = {}; Object.keys(o).slice(0, 80).forEach(function (k) { try { out[k] = shape(o[k], d + 1); } catch (e) { out[k] = '!'; } });
    return out;
  }
  var services = {};
  rel.forEach(function (n) { try { services[n] = shape(inj.get(n), 0); } catch (e) { services[n] = '! ' + String(e).slice(0, 60); } });
  return { appName: appName, all: all.length, rel: rel, services: services };
})()`;
const dump = await page.evaluate(IN_PAGE) as { appName: string; all: number; rel: string[]; services: Record<string, unknown> };
console.log('PROBE-APP', dump.appName, 'services:', dump.all);
console.log('PROBE-REL', JSON.stringify(dump.rel));
for (const [k, v] of Object.entries(dump.services)) console.log('PROBE-SVC', k, JSON.stringify(v).slice(0, 3000));
const text = await page.locator('body').innerText().catch(() => '');
console.log('PROBE-TEXT', JSON.stringify(text.split('\n').filter((l) => /משלוח|מינימום|כתובת|איסוף|אזור/.test(l)).slice(0, 40)));
console.log('PROBE-CALLS', JSON.stringify(calls.slice(0, 80)));
// Add one product the way the cart driver does, then look at what the cart exposes about delivery.
const { cartDriver } = await import('../server/cart/drivers.ts');
const { zuzProvider } = await import('../server/providers/zuz.ts');
const rows = await zuzProvider(chain).searchProducts('חלב').catch(() => []);
if (rows[0]) await cartDriver(id)!.addItems(page, [{ productId: rows[0].productId, quantity: 1, name: rows[0].name }]).catch((e) => console.log('add failed', String(e)));
await page.waitForTimeout(3000);
const after = await page.evaluate(IN_PAGE) as typeof dump;
for (const k of after.rel.filter((n) => /cart|deliver|area|time|fee|min/i.test(n))) console.log('PROBE-AFTER', k, JSON.stringify(after.services[k]).slice(0, 3000));
const text2 = await page.locator('body').innerText().catch(() => '');
console.log('PROBE-TEXT2', JSON.stringify(text2.split('\n').filter((l) => /משלוח|מינימום|כתובת|איסוף|אזור|₪/.test(l)).slice(0, 60)));
console.log('PROBE-CALLS2', JSON.stringify(calls.slice(0, 120)));
await closeBrowser();
process.exit(0);
