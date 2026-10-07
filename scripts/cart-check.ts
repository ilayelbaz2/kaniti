// Real cart-preparation check against a live supermarket site (used in CI; also runnable at home).
// Usage: npx tsx scripts/cart-check.ts [providerId=tivtaam]
// Adds a few real products to the site's cart through Kaniti's driver and reads the cart back. Never goes to checkout.
process.env.KANITI_DB = ':memory:';
process.env.KANITI_BROWSER_PROFILE ??= 'data/browser-profile-check';
delete process.env.KANITI_DEMO;
import fs from 'node:fs';
const providerId = process.argv[2] ?? 'tivtaam';
const { onlineCatalog } = await import('../server/providers/index.ts');
const { conceptById } = await import('../server/catalog.ts');
const { chooseProduct } = await import('../server/engine/match.ts');
const { newNeed } = await import('../server/state.ts');
const { startCartJob, currentJob } = await import('../server/cart/prepare.ts');
const { closeBrowser } = await import('../server/cart/browser.ts');
import type { BasketQuote, QuoteLine } from '../shared/types.ts';

const p = onlineCatalog().find((x) => x.id === providerId)!;
await p.checkDelivery({ city: 'רמת גן' }).catch(() => null);
const lines: QuoteLine[] = [];
for (const id of ['MILK', 'TUNA', 'PASTA']) {
  const c = conceptById.get(id)!;
  const rows = await p.searchProducts(c.query);
  const ch = chooseProduct(c, { ...newNeed(c, 2, 1), flexibility: 'category_flexible' }, rows);
  lines.push(ch && !ch.uncertain ? { needId: id, label: c.label, quantity: 1, product: ch.product, lineTotal: ch.product.promoPrice ?? ch.product.price } : { needId: id, label: c.label, quantity: 1, lineTotal: 0, missing: true });
}
const quote: BasketQuote = {
  providerId, providerName: p.name, kind: 'online', ok: true, lines, subtotal: lines.reduce((s, l) => s + l.lineTotal, 0), deliveryFee: p.deliveryFee,
  total: 0, completeness: 1, unavailableCount: 0, substitutionsCount: 0, source: 'live', fetchedAt: new Date().toISOString(),
};
console.log('planned:', lines.map((l) => `${l.label}: ${l.product?.name ?? '—'} (${l.product?.productId ?? ''})`).join(' | '));
startCartJob({ quote });
const t0 = Date.now();
let job = currentJob()!;
while (!['ready', 'partial', 'failed', 'unsupported'].includes(job.status) && Date.now() - t0 < 180000) {
  await new Promise((r) => setTimeout(r, 2000));
  job = currentJob()!;
  console.log(`  [${Math.round((Date.now() - t0) / 1000)}s] ${job.status}: ${job.message}`);
}
const report = { status: job.status, message: job.message, anonymous: job.anonymous, cartItemCount: job.cartItemCount, cartTotal: job.cartTotal, cartUrl: job.cartUrl, lines: job.lines.map((l) => ({ label: l.label, product: l.productName, state: l.state, reason: l.reason })) };
console.log('CART-CHECK', JSON.stringify(report));
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/cart-check.json', JSON.stringify(report, null, 1));
await closeBrowser();
process.exit(job.status === 'ready' || job.status === 'partial' ? 0 : 1);
