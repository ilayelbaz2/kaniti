// Temporary diagnostics for provider formats (run in CI where the network is open).
process.env.KANITI_DB = ':memory:';
const { ZUZ_CHAINS, zuzProvider } = await import('../server/providers/zuz.ts');
const { kvSet } = await import('../server/db.ts');
const chain = ZUZ_CHAINS.find((c) => c.id === 'tivtaam')!;
const prov = zuzProvider(chain);
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const r = await realFetch(url, init);
  const t = await r.clone().text();
  console.log('FETCH', r.status, String(url).slice(0, 220), '::', t.replace(/\s+/g, ' ').slice(0, 300));
  return r;
}) as typeof fetch;
for (const b of [939, 924]) {
  kvSet('provider:tivtaam:branch', b);
  try { const r = await prov.searchProducts('חלב 3%'); console.log('branch', b, 'items', r.length, JSON.stringify(r[0] ?? null)); } catch (e) { console.log('branch', b, 'ERR', (e as Error).message); }
}
