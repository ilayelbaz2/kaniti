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
const dump = await page.evaluate(() => {
  const ng = (window as any).angular;
  const inj = ng.element(document.body).injector();
  const root = document.querySelector('[ng-app],[data-ng-app]');
  const appName = root?.getAttribute('ng-app') ?? root?.getAttribute('data-ng-app') ?? '';
  const seen = new Set<string>(); const names = new Set<string>();
  const walk = (m: string) => { if (seen.has(m)) return; seen.add(m); try { const mod = ng.module(m); for (const q of mod._invokeQueue ?? []) if (typeof q[2]?.[0] === 'string') names.add(q[2][0]); for (const r of mod.requires ?? []) walk(r); } catch { /* */ } };
  walk(appName);
  const rel = [...names].filter((n) => /cart|deliver|area|address|branch|config|^user$|shipping|time|order|checkout|retailer|min/i.test(n));
  const shape = (o: any, depth = 0): any => {
    if (o === null || o === undefined) return o;
    if (typeof o === 'function') return 'fn';
    if (typeof o !== 'object') return typeof o === 'string' ? o.slice(0, 80) : o;
    if (depth > 1) return Array.isArray(o) ? `[${o.length}]` : '{…}';
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).slice(0, 60)) { try { out[k] = shape(o[k], depth + 1); } catch { out[k] = '!'; } }
    return out;
  };
  const services: Record<string, unknown> = {};
  for (const n of rel) { try { services[n] = shape(inj.get(n)); } catch (e) { services[n] = `! ${String(e).slice(0, 60)}`; } }
  return { appName, all: [...names].length, rel, services };
});
console.log('PROBE-APP', dump.appName, 'services:', dump.all);
console.log('PROBE-REL', JSON.stringify(dump.rel));
for (const [k, v] of Object.entries(dump.services)) console.log('PROBE-SVC', k, JSON.stringify(v).slice(0, 3000));
const text = await page.locator('body').innerText().catch(() => '');
console.log('PROBE-TEXT', JSON.stringify(text.split('\n').filter((l) => /משלוח|מינימום|כתובת|איסוף|אזור/.test(l)).slice(0, 40)));
console.log('PROBE-CALLS', JSON.stringify(calls.slice(0, 80)));
await closeBrowser();
process.exit(0);
