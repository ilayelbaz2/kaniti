// Real-site check of exact-address delivery verification on a ZuZ chain (CI or home; anonymous, headless OK).
// Usage: npx tsx scripts/address-check.ts [providerId=tivtaam] ["<street> <number>, <city>"]
// The address is a TEST address (CI has no household). To stand in for the user choosing their address in the
// supermarket window, this harness sets the cart's delivery area through the site's own app state — Kaniti itself
// never does that. Scenarios: area matching the address → confirmed; another area → user action; no area →
// user action; an address the site refuses → unavailable and nothing added. Never goes to checkout.
process.env.KANITI_DB = ':memory:';
process.env.KANITI_BROWSER_PROFILE ??= 'data/browser-profile-address';
process.env.KANITI_BROWSER_HEADLESS ??= '1';
delete process.env.KANITI_DEMO;
import fs from 'node:fs';
import type { BasketQuote, Household, QuoteLine } from '../shared/types.ts';
const providerId = process.argv[2] ?? 'tivtaam';
const [street, city] = (process.argv[3] ?? 'ביאליק 12, רמת גן').split(',').map((s) => s.trim());
const { store } = await import('../server/db.ts');
const { onlineCatalog } = await import('../server/providers/index.ts');
const { ZUZ_CHAINS } = await import('../server/providers/zuz.ts');
const { conceptById } = await import('../server/catalog.ts');
const { chooseProduct } = await import('../server/engine/match.ts');
const { newNeed } = await import('../server/state.ts');
const { startCartJob, currentJob } = await import('../server/cart/prepare.ts');
const { pageFor, closeBrowser } = await import('../server/cart/browser.ts');
const chain = ZUZ_CHAINS.find((c) => c.id === providerId)!;
const p = onlineCatalog().find((x) => x.id === providerId)!;

const household = (s: string, c: string): Household => ({ id: 'h', adults: 2, children: [{ age: 2 }], kosher: true, allergies: [], dietNotes: [], homeAddress: { city: c, street: s },
  driveSavingsThresholdNis: 60, onlineProviders: [providerId], physicalStores: [], flexibilityStyle: 'balanced', shopEveryDays: 14 });

const lines: QuoteLine[] = [];
for (const id of ['MILK', 'TUNA', 'PASTA']) {
  const c = conceptById.get(id)!;
  const rows = await p.searchProducts(c.query);
  const ch = chooseProduct(c, { ...newNeed(c, 2, 1), flexibility: 'category_flexible' }, rows);
  if (ch && !ch.uncertain) lines.push({ needId: id, label: c.label, quantity: 1, product: ch.product, lineTotal: ch.product.promoPrice ?? ch.product.price });
}
const quote: BasketQuote = { providerId, providerName: p.name, kind: 'online', ok: true, lines, subtotal: lines.reduce((s, l) => s + l.lineTotal, 0), deliveryFee: p.deliveryFee,
  deliveryFeeEstimated: true, total: 0, completeness: 1, unavailableCount: 0, substitutionsCount: 0, source: 'live', fetchedAt: new Date().toISOString() };

const page = await pageFor(chain.host);
await page.waitForFunction(`(() => { try { return !!window.angular.element(document.body).injector().get('Config').branch; } catch (e) { return false; } })()`, null, { timeout: 45000 });
// The site's own lookup → which area serves the test address, and some other delivery area for the negative case.
const lookup = await page.evaluate(`(async () => {
  var C = window.angular.element(document.body).injector().get('Config');
  var r = await fetch('/v2/retailers/' + C.retailer.id + '/areas?appId=4&languageId=1&deliveryTypeId=1&query=' + encodeURIComponent(${JSON.stringify(`${street}, ${city}`)}), { headers: { Accept: 'application/json' } });
  var j = await r.json().catch(function () { return {}; });
  var hit = (j.areas || [])[0];
  var other = null;
  (C.retailer.branches || []).forEach(function (b) { (b.areas || []).forEach(function (a) { if (!other && a.deliveryTypeId === 1 && a.isActive && (!hit || a.id !== hit.id) && b.isOnline && !b.isDisabled) other = { branchId: b.id, areaId: a.id, name: a.name }; }); });
  return { status: r.status, hit: hit ? { branchId: hit.branchId, areaId: hit.id, name: hit.name } : null, other: other };
})()`) as { status: number; hit: { branchId: number; areaId: number; name: string } | null; other: { branchId: number; areaId: number; name: string } | null };
console.log('site lookup:', JSON.stringify(lookup));

/** Stand-in for the user picking their delivery area in the site's own "choose area" dialog. */
const chooseArea = (a: { branchId: number; areaId: number } | null) => page.evaluate(`(async () => {
  var C = window.angular.element(document.body).injector().get('Config');
  ${a ? `await C.changeBranch(${a.branchId}, ${a.areaId}, { forceBranchChange: true }); C.isAreaSelectedByUser = true;` : 'C.isAreaSelectedByUser = false; C.isUserDefaultArea = false;'}
  return true;
})()`);

async function run(label: string, addr: [string, string], area: { branchId: number; areaId: number } | null, expect: string) {
  store.saveHousehold(household(...addr));
  await chooseArea(area);
  startCartJob({ quote });
  const t0 = Date.now();
  let job = currentJob()!;
  while (!['ready', 'partial', 'failed', 'unsupported'].includes(job.status) && Date.now() - t0 < 120000) { await new Promise((r) => setTimeout(r, 1500)); job = currentJob()!; }
  const d = job.delivery;
  const ok = d?.deliveryStatus === expect;
  const row = { scenario: label, expect, got: d?.deliveryStatus, ok, address: d?.confirmedAddressText, fee: d?.deliveryFee, windows: d?.deliveryWindows?.slice(0, 3), minimumOrder: d?.minimumOrder,
    restriction: d?.restrictionMessage, jobStatus: job.status, added: job.lines.filter((l) => l.state === 'added').length, cartTotal: job.cartTotal };
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${JSON.stringify(row)}`);
  return row;
}

const results = [];
if (lookup.hit) {
  results.push(await run('area chosen = area serving the address', [street, city], lookup.hit, 'confirmed'));
  if (lookup.other) results.push(await run(`area chosen = another area (${lookup.other.name})`, [street, city], lookup.other, 'user_action_required'));
  results.push(await run('no area chosen', [street, city], null, 'user_action_required'));
} else console.log(`FAIL the site did not resolve ${street}, ${city} (HTTP ${lookup.status})`);
results.push(await run('address outside delivery areas (התמרים 5, אילת)', ['התמרים 5', 'אילת'], lookup.hit, 'unavailable'));
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/address-check.json', JSON.stringify({ providerId, testAddress: `${street}, ${city}`, lookup, results }, null, 1));
await closeBrowser();
process.exit(0);
