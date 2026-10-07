// Home-network validation against the household's REAL stored address (run on the home computer, Kaniti server stopped).
// Usage: npm run home-validation -- [providerId ...] [--verify-only]
// For each online provider: live basket quote → opens the supermarket in Chrome → you log in / choose your delivery
// address there yourself → Kaniti reads the delivery state the site shows → prepares the cart → reads it again.
// Never goes to checkout and never touches payment. Writes data/home-validation.md.
delete process.env.KANITI_DEMO;
import fs from 'node:fs';
const args = process.argv.slice(2);
const verifyOnly = args.includes('--verify-only');
const wanted = args.filter((a) => !a.startsWith('--'));
const { store } = await import('../server/db.ts');
const svc = await import('../server/service.ts');
const { quoteOne } = await import('../server/engine/compare.ts');
const { householdProviders } = await import('../server/providers/index.ts');
const { startCartJob, currentJob } = await import('../server/cart/prepare.ts');
const { cartSupported } = await import('../server/cart/drivers.ts');
const { closeBrowser } = await import('../server/cart/browser.ts');
const { DELIVERY_TEXT } = await import('../server/cart/prepare.ts');
import type { BasketQuote, CartJob } from '../shared/types.ts';

const h = store.household();
if (!h) { console.error('אין משק בית שמור. השלימו את ההרשמה באפליקציה קודם.'); process.exit(2); }
if (!h.homeAddress.street) { console.error(`בפרופיל שמורה רק עיר (${h.homeAddress.city}). הוסיפו רחוב ומספר בית במסך "הבית" ואז הריצו שוב.`); process.exit(2); }
console.log(`Household address (stored): ${h.homeAddress.street}, ${h.homeAddress.city}`);

let basket = store.basket();
if (!verifyOnly && (!basket || basket.status !== 'building' || !basket.items.length)) {
  console.log('Building a two-week basket from the household profile…');
  basket = (await svc.buildBasket(14)).basket;
}
const providers = householdProviders(h).filter((p) => p.kind === 'online' && cartSupported(p.id) && (!wanted.length || wanted.includes(p.id)));
if (!providers.length) { console.error('אין רשתות אונליין נתמכות לבדיקה.'); process.exit(2); }

type Row = { name: string; job?: CartJob; quote?: BasketQuote; error?: string };
const rows: Row[] = [];
for (const p of providers) {
  console.log(`\n=== ${p.name} ===`);
  let quote: BasketQuote;
  if (verifyOnly) {
    quote = { providerId: p.id, providerName: p.name, kind: 'online', ok: true, lines: [], subtotal: 0, deliveryFee: p.deliveryFee, deliveryFeeEstimated: true, total: 0, completeness: 0, unavailableCount: 0, substitutionsCount: 0, source: 'live', fetchedAt: new Date().toISOString() };
  } else {
    quote = await quoteOne(p, basket!);
    console.log(`Live quote: ${quote.ok ? `₪${Math.round(quote.subtotal)} items · ${Math.round(quote.completeness * 100)}% of the basket · source ${quote.source}` : `failed — ${quote.error}`}`);
    if (!quote.ok) { rows.push({ name: p.name, quote, error: quote.error }); continue; }
  }
  startCartJob({ quote, verifyOnly });
  let last = '';
  const t0 = Date.now();
  let job = currentJob()!;
  while (!['ready', 'partial', 'failed', 'unsupported'].includes(job.status) && Date.now() - t0 < 20 * 60000) {
    await new Promise((r) => setTimeout(r, 2000));
    job = currentJob()!;
    const line = `${job.status}: ${job.message}`;
    if (line !== last) console.log(`  [${Math.round((Date.now() - t0) / 1000)}s] ${line}${['login_required', 'address_required', 'verification_required'].includes(job.status) ? '   ← בחלון Chrome שנפתח' : ''}`);
    last = line;
  }
  rows.push({ name: p.name, job, quote });
  const d = job.delivery;
  console.log(`Delivery: ${d ? DELIVERY_TEXT[d.deliveryStatus] : '—'}${d?.confirmedAddressText ? ` · ${d.confirmedAddressText}` : ''}${d?.restrictionMessage ? ` · ${d.restrictionMessage}` : ''}`);
}

const yn = (b: boolean) => (b ? 'yes' : 'no');
const out = [
  `# Kaniti home validation — ${new Date().toISOString()}`,
  `Stored address: ${h.homeAddress.street}, ${h.homeAddress.city}${verifyOnly ? ' · delivery check only (no items added)' : ''}`, '',
  '| Provider | Exact address verified | Delivery fee live | Delivery windows | Cart tied to address | Live basket | Cart total (site) | Status |',
  '|---|---|---|---|---|---|---|---|',
];
for (const r of rows) {
  const j = r.job, d = j?.delivery;
  const confirmed = d?.deliveryStatus === 'confirmed';
  const feeLive = d?.deliveryFee !== undefined;
  const cartOk = !verifyOnly && (j?.status === 'ready' || j?.status === 'partial');
  const tied = cartOk && confirmed; // re-read after adding items, same address as before adding
  const status = r.error ? `could not verify (${r.error})` : !d ? `could not verify (${j?.message ?? ''})` : d.deliveryStatus === 'unavailable' ? 'unavailable for this address'
    : confirmed && (verifyOnly || (tied && feeLive && j?.cartTotal !== undefined)) ? 'fully verified' : `partial — ${DELIVERY_TEXT[d.deliveryStatus]}${d.restrictionMessage ? `: ${d.restrictionMessage}` : ''}`;
  out.push(`| ${r.name} | ${confirmed ? `yes (${d!.confirmedAddressText})` : d?.deliveryStatus ?? 'no'} | ${feeLive ? `yes ₪${d!.deliveryFee}` : 'no'} | ${d?.deliveryWindows?.length ? d.deliveryWindows.slice(0, 2).join(' / ') : 'none shown'} | ${verifyOnly ? 'n/a' : yn(tied)} | ${r.quote && !verifyOnly ? `${Math.round(r.quote.completeness * 100)}%` : 'n/a'} | ${j?.cartTotal !== undefined ? `₪${j.cartTotal}` : '—'} | ${status} |`);
}
out.push('', 'Payment boundary: stopped before checkout on every provider. Items added stay in your supermarket cart — remove them on the site if you do not order.');
console.log('\n' + out.join('\n'));
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/home-validation.md', out.join('\n'));
await closeBrowser();
process.exit(0);
