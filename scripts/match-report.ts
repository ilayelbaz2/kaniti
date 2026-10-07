// Dumps real search results per household concept so matching can be regression-tested on real names.
// Usage: npx tsx scripts/match-report.ts  (needs open network; used in CI)
process.env.KANITI_DB = ':memory:';
delete process.env.KANITI_DEMO;
const { CONCEPTS } = await import('../server/catalog.ts');
const { onlineCatalog } = await import('../server/providers/index.ts');
const { PHYSICAL_CHAINS, physicalProvider } = await import('../server/providers/transparency.ts');
const { chooseProduct, relevant } = await import('../server/engine/match.ts');
const { newNeed } = await import('../server/state.ts');
import fs from 'node:fs';

const tiv = onlineCatalog().find((p) => p.id === 'tivtaam')!;
await tiv.checkDelivery({ city: 'רמת גן' }).catch(() => null);
const branch = (id: string, store: string, name: string) => physicalProvider(PHYSICAL_CHAINS.find((c) => c.id === id)!, store, name);
const providers = [tiv, branch('shufersal', '164', 'שופרסל ר"ג ביאליק'), branch('ramilevy', '16', 'רמי לוי ר"ג'), branch('tivtaam', '88', 'טיב טעם רמת אפעל')];
const out: Record<string, Record<string, { names: string[]; chosen?: string; uncertain?: boolean; relevant: string[] }>> = {};
for (const c of CONCEPTS) {
  out[c.id] = {};
  const need = { ...newNeed(c, 2, 1), flexibility: 'category_flexible' as const, hardConstraints: c.kidItem && c.id !== 'BAMBA' ? ['ללא חלב'] : [] };
  for (const p of providers) {
    try {
      const rows = await p.searchProducts(c.query);
      const ch = chooseProduct(c, need, rows);
      out[c.id][p.id] = { names: rows.slice(0, 25).map((r) => `${r.name} ₪${r.promoPrice ?? r.price}`), chosen: ch?.product.name, uncertain: ch?.uncertain, relevant: rows.filter((r) => relevant(c, need, r)).slice(0, 8).map((r) => r.name) };
      console.log(`MR|${c.id}|${p.id}|chosen=${ch?.product.name ?? '—'}${ch?.uncertain ? ' (UNCERTAIN)' : ''}|raw=${rows.slice(0, 14).map((r) => r.name).join(' ;; ')}`);
    } catch (e) {
      console.log(`MR|${c.id}|${p.id}|ERR ${(e as Error).message}`);
    }
  }
}
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/match-report.json', JSON.stringify(out, null, 1));
