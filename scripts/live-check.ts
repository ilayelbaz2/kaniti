// Live connectivity + real-basket check against the actual supermarket sites.
// Usage: npm run live-check -- "רמת גן"
// Uses a throwaway in-memory DB. Writes a markdown report to data/live-check.md (and $GITHUB_STEP_SUMMARY if set).
process.env.KANITI_DB = ':memory:';
delete process.env.KANITI_DEMO;
import fs from 'node:fs';

const city = process.argv[2] ?? 'רמת גן';
const { onlineCatalog } = await import('../server/providers/index.ts');
const { PHYSICAL_CHAINS, listStores, loadBranch, searchBranch } = await import('../server/providers/transparency.ts');
const { sameCity } = await import('../server/providers/cities.ts');
const { completeOnboarding } = await import('../server/state.ts');
const svc = await import('../server/service.ts');
const { compareBasket } = await import('../server/engine/compare.ts');
const { store } = await import('../server/db.ts');

const out: string[] = [`# Kaniti live check — ${new Date().toISOString()}`, `City: **${city}**`, ''];
const log = (s = '') => { console.log(s); out.push(s); };
const timed = async <T,>(fn: () => Promise<T>) => { const t = Date.now(); try { return { ok: true as const, v: await fn(), ms: Date.now() - t }; } catch (e) { return { ok: false as const, e: (e as Error).message, ms: Date.now() - t }; } };

log('## Online providers');
log('| chain | delivery | search "חלב" | search "טונה בשמן" | promo seen |');
log('|---|---|---|---|---|');
const working: string[] = [];
for (const p of onlineCatalog()) {
  const d = await timed(() => p.checkDelivery({ city }));
  const a = await timed(() => p.searchProducts('חלב 3%'));
  const b = await timed(() => p.searchProducts('טונה בשמן'));
  const cell = (r: typeof a) => (r.ok ? `${r.v.length} items, e.g. ${r.v[0] ? `${r.v[0].name} ₪${r.v[0].price}` : '—'} (${r.ms}ms)` : `❌ ${r.e}`);
  const promo = [a, b].flatMap((r) => (r.ok ? r.v : [])).find((x) => x.promoPrice);
  log(`| ${p.name} | ${d.ok ? `${d.v.delivers === true ? '✅' : d.v.delivers === null ? '❔' : '—'} ${d.v.note}` : `❌ ${d.e}`} | ${cell(a)} | ${cell(b)} | ${promo ? `${promo.name}: ₪${promo.price} → ₪${promo.promoPrice} (${promo.promoText ?? ''})` : '—'} |`);
  if ((a.ok && a.v.length) || (b.ok && b.v.length)) working.push(p.id);
}

log('', '## Physical branches (price-transparency files)');
const physical: { chainId: string; storeId: string; name: string }[] = [];
for (const chain of PHYSICAL_CHAINS) {
  const s = await timed(() => listStores(chain));
  if (!s.ok) { log(`- ${chain.name}: ❌ stores: ${s.e}`); continue; }
  const local = s.v.filter((x) => sameCity(x.city, city));
  const pick = local[0] ?? s.v[0];
  if (!pick) { log(`- ${chain.name}: stores file empty`); continue; }
  const br = await timed(() => loadBranch(chain, pick.storeId));
  if (!br.ok) { log(`- ${chain.name}: ${s.v.length} stores (${local.length} in ${city}); ❌ prices for ${pick.name}: ${br.e}`); continue; }
  const tuna = searchBranch(br.v.items, 'טונה בשמן')[0];
  const promos = br.v.items.filter((i) => i.promoPrice).length;
  log(`- ${chain.name}: ${s.v.length} stores (${local.length} in ${city}); branch "${pick.name}" → ${br.v.items.length} items, ${promos} with promos (${br.ms}ms). e.g. ${tuna ? `${tuna.name} ₪${tuna.price}${tuna.promoPrice ? ` → ₪${tuna.promoPrice}` : ''}` : '—'}`);
  if (physical.length < 2) physical.push({ chainId: chain.id, storeId: pick.storeId, name: pick.name });
}

log('', '## Real basket comparison');
if (!working.length) {
  log('❌ No online provider returned data — cannot compare.');
} else {
  completeOnboarding({
    adults: 2, children: [{ age: 6 }], kosher: true, dairyAllergy: false, vegetarian: false, address: { city },
    onlineProviders: working, physicalStores: physical, flex: { COLA_ZERO: 'strict', LAUNDRY_SOFTENER: 'deal', CREAM_CHEESE: 'any' },
    staples: ['EGGS', 'BREAD', 'TUNA', 'CREAM_CHEESE', 'YELLOW_CHEESE', 'MILK', 'COLA_ZERO', 'PASTA', 'BAMBA', 'COFFEE', 'CHICKEN_BREAST', 'LAUNDRY_SOFTENER', 'TOMATOES', 'CUCUMBERS'],
    customStaples: [], threshold: 60,
  });
  const { basket, failures } = await svc.buildBasket(14);
  log(`Basket: ${basket.items.length} items (${basket.priceSourceNote ?? ''}). Provider failures: ${failures.map((f) => `${f.name}: ${f.error}`).join('; ') || 'none'}`);
  for (const i of basket.items) log(`- ${i.status} ${i.emoji} ${i.label} × ${i.quantity} — ${i.product ? `${i.product.name} ₪${i.product.price}${i.product.live ? ' (live)' : ''}` : 'no price'} — ${i.reason}`);
  const cmp = await compareBasket(store.basket()!);
  log('', `**Recommendation:** ${cmp.recommendation.text}`, '');
  log('| store | source | total | delivery | completeness | missing |');
  log('|---|---|---|---|---|---|');
  for (const q of cmp.quotes) log(`| ${q.providerName} | ${q.source} | ${q.ok ? `₪${Math.round(q.total)}` : `❌ ${q.error ?? ''}`} | ${q.deliveryFee} | ${Math.round(q.completeness * 100)}% | ${q.unavailableCount} |`);
}

fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/live-check.md', out.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, out.join('\n'));
process.exit(working.length >= 1 ? 0 : 1);
