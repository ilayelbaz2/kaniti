// Two-cycle household rehearsal on REAL data (live online catalogs where reachable + official branch price files).
// Usage: npx tsx scripts/rehearsal.ts [city]   — needs open network (CI or home). Writes data/rehearsal.md.
process.env.KANITI_DB = ':memory:';
process.env.KANITI_BROWSER_PROFILE ??= 'data/browser-profile-rehearsal';
delete process.env.KANITI_DEMO;
import fs from 'node:fs';
const city = process.argv[2] ?? 'רמת גן';
const { store } = await import('../server/db.ts');
const { advanceDays } = await import('../server/clock.ts');
const { completeOnboarding } = await import('../server/state.ts');
const { parseMessage } = await import('../server/chat/parser.ts');
const { executeActions, executeCommand } = await import('../server/chat/execute.ts');
const svc = await import('../server/service.ts');
const { compareBasket } = await import('../server/engine/compare.ts');
const { onlineCatalog } = await import('../server/providers/index.ts');
const { PHYSICAL_CHAINS, listStores } = await import('../server/providers/transparency.ts');
const { storeInCity } = await import('../server/providers/cities.ts');
const { currentJob, cartSeed } = await import('../server/cart/prepare.ts');
const { closeBrowser } = await import('../server/cart/browser.ts');

const out: string[] = [`# Kaniti household rehearsal — ${new Date().toISOString()}`, `City: ${city}`, ''];
const log = (s = '') => { console.log(s); out.push(s); };
const say = async (t: string) => {
  const m = t.startsWith('#') ? (await executeCommand(t.slice(1).split(' ')[0], t.split(' ').slice(1))) ?? (await executeActions(parseMessage(t))) : await executeActions(parseMessage(t));
  const changes = m.components?.filter((c) => c.type === 'state_change').flatMap((c) => (c as { changes: string[] }).changes) ?? [];
  log(`> ${t}\n  ${m.text.split('\n').join('\n  ')}${changes.length ? `\n  ✓ ${changes.join(' | ')}` : ''}`);
};
const basketLines = () => store.basket()!.items.map((i) => `${i.status === 'need' ? '' : i.status === 'opportunity' ? '🔥' : '💡'}${i.label}×${i.quantity}${i.accepted ? '' : '(הצעה)'}${i.uncertain ? '(?)' : ''}`);

// Delivery + branches for the household address
const delivery = await Promise.all(onlineCatalog().map(async (p) => ({ id: p.id, r: await p.checkDelivery({ city }).catch(() => null) })));
const online = delivery.filter((d) => d.r && d.r.status !== 'unavailable').map((d) => d.id);
const physical: { chainId: string; storeId: string; name: string }[] = [];
for (const chainId of ['shufersal', 'ramilevy', 'tivtaam']) {
  const chain = PHYSICAL_CHAINS.find((c) => c.id === chainId)!;
  const local = (await listStores(chain).catch(() => [])).filter((s) => storeInCity(s, city));
  if (local[0]) physical.push({ chainId, storeId: local[0].storeId, name: local[0].name });
}
log(`Online providers: ${online.join(', ')} | Physical: ${physical.map((p) => p.name).join(', ')}`);

completeOnboarding({
  adults: 2, children: [{ age: 2 }], kosher: true, dairyAllergy: true, dairyAllergyWho: 'kids', vegetarian: false, address: { city },
  onlineProviders: online, physicalStores: physical, flex: { COLA_ZERO: 'strict', LAUNDRY_SOFTENER: 'deal', CREAM_CHEESE: 'any' },
  staples: ['EGGS', 'BREAD', 'TUNA', 'CREAM_CHEESE', 'YELLOW_CHEESE', 'KIDS_DAIRY', 'COLA_ZERO', 'SODA', 'PEANUT_BUTTER', 'CHOCO_SPREAD', 'PASTA', 'PTITIM', 'BAMBA',
    'FRUIT_FOR_CHILD', 'TOMATOES', 'CUCUMBERS', 'ONIONS', 'CABBAGE', 'LETTUCE', 'KOHLRABI', 'GROUND_MEAT', 'CHICKEN_BREAST', 'SALMON', 'LAUNDRY_DETERGENT', 'LAUNDRY_SOFTENER', 'VANISH'],
  customStaples: [], threshold: 60, deliveryStatus: Object.fromEntries(delivery.map((d) => [d.id, d.r?.status ?? 'unknown'])),
});
store.saveNeed({ ...store.need('EGGS')!, typical14DayQty: 30, qtySource: 'user' });
store.saveNeed({ ...store.need('TUNA')!, typical14DayQty: 9, qtySource: 'user' });
store.saveNeed({ ...store.need('BREAD')!, typical14DayQty: 2, qtySource: 'user' });

async function cycle(n: number, chat: string[]) {
  log('', `## Cycle ${n}`);
  for (const t of chat) await say(t);
  const b = store.basket()!;
  log(`Basket (${b.items.length}): ${basketLines().join(', ')}`);
  log(`Skipped: ${b.skipped.map((s) => `${s.label} (${s.reason})`).join('; ')}`);
  log(`Prices: ${b.priceSourceNote ?? ''}`);
  const cmp = await compareBasket(b);
  log(`Recommendation: ${cmp.recommendation.text}`);
  for (const q of cmp.quotes) log(`  - ${q.providerName} [${q.source}${q.cartSupported ? ', cart✓' : ''}]: ${q.ok ? `₪${Math.round(q.total)} · ${Math.round(q.completeness * 100)}% · missing ${q.unavailableCount} · unsure ${q.uncertainCount ?? 0}` : `❌ ${q.error}`}`);
  // Prepare the real cart at the best online store that answered (headless here: anonymous cart).
  const target = cmp.quotes.find((q) => q.ok && q.kind === 'online' && q.cartSupported);
  if (target) {
    await say(`תכין לי עגלה ב${target.providerName}`);
    const t0 = Date.now();
    while (!['ready', 'partial', 'failed', 'unsupported'].includes(currentJob()?.status ?? '') && Date.now() - t0 < 240000) await new Promise((r) => setTimeout(r, 2000));
    const j = currentJob()!;
    log(`Cart @ ${j.providerName}: ${j.status} — ${j.message} · site cart: ${j.cartItemCount ?? '?'} items, ₪${j.cartTotal ?? '?'} · not added: ${j.lines.filter((l) => l.state !== 'added').map((l) => `${l.label} (${l.reason})`).join('; ')}`);
  }
  const seed = cartSeed();
  const win = cmp.quotes.find((q) => q.providerId === (seed?.providerId ?? cmp.recommendation.winnerId)) ?? cmp.quotes.find((q) => q.ok)!;
  const items = seed?.items ?? win.lines.filter((l) => !l.missing).map((l) => ({ needId: l.needId, quantity: l.quantity, productName: l.product?.name, price: l.lineTotal / l.quantity }));
  const p = svc.confirmPurchase({ storeName: seed?.providerName ?? win.providerName, providerId: seed?.providerId ?? win.providerId, total: seed?.total ?? win.total, items, viaCart: !!seed });
  log(`Purchase confirmed: ${p.storeName} ₪${Math.round(p.total)} · ${p.items.length} items · removed: ${p.removed?.map((r) => r.label).join(', ') || '—'} · stock-ups: ${p.stockUps?.join(', ') || '—'}${p.viaCart ? ' · seeded from cart' : ''}`);
  return b;
}

const b1 = await cycle(1, [
  'יש לנו 10 ביצים', 'אין טונה', 'יש מלא פסטה', 'רק קוקה קולה זירו', 'לא אכפת לי איזה מרכך',
  'תבנה לי קנייה לשבועיים', '#build 14 force', 'אל תקנה גבינת שמנת הפעם', 'תוסיף גם פרגיות אם המחיר טוב', 'קח שני וניש אם ממש זול', 'למה שמת טונה?',
]);
advanceDays(14);
const b2 = await cycle(2, ['יש הרבה טונה', 'נגמרו הביצים', 'תבנה לי קנייה לשבועיים', '#build 14 force']);

log('', '## What changed between cycles');
const q1 = new Map(b1.items.map((i) => [i.needId, i])), q2 = new Map(b2.items.map((i) => [i.needId, i]));
for (const id of new Set([...q1.keys(), ...q2.keys()])) {
  const a = q1.get(id), b = q2.get(id);
  if (a?.quantity !== b?.quantity || a?.status !== b?.status) log(`- ${(a ?? b)!.label}: ${a ? `${a.quantity}${a.status === 'need' ? '' : ' ' + a.status}` : '—'} → ${b ? `${b.quantity}${b.status === 'need' ? '' : ' ' + b.status}` : '— (' + (b2.skipped.find((s) => s.needId === id)?.reason ?? '') + ')'}`);
}
for (const id of ['EGGS', 'TUNA', 'CREAM_CHEESE', 'LAUNDRY_SOFTENER', 'COLA_ZERO']) {
  const n = store.need(id)!;
  log(`- learned ${n.label}: ~${n.typical14DayQty}/14d (${n.qtySource}), ${n.flexibility}${n.preferredBrands.length ? ' ' + n.preferredBrands.join('/') : ''}`);
}
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/rehearsal.md', out.join('\n'));
await closeBrowser();
process.exit(0);
