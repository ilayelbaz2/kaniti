// Discovery probe (CI only, anonymous, read-only): how a ZuZ-platform site resolves a street address to its delivery
// areas, and what its delivery-times look like. Never logs in, never goes to checkout.
// Usage: npx tsx scripts/delivery-probe.ts [providerId=tivtaam]
const id = process.argv[2] ?? 'tivtaam';
const { ZUZ_CHAINS } = await import('../server/providers/zuz.ts');
const chain = ZUZ_CHAINS.find((c) => c.id === id)!;
const H = { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126 Safari/537.36' };
const get = async (path: string) => { const r = await fetch(chain.host + path, { headers: H }); return `${r.status} ${(await r.text()).slice(0, 2500)}`; };
for (const q of ['ביאליק 12, רמת גן', 'רמת גן', 'דיזנגוף 50, תל אביב', 'התמרים 5, אילת', 'xyzzy']) {
  const qs = `appId=4&languageId=1&query=${encodeURIComponent(q)}&deliveryTypeId=1&deliveryTypeId=5`;
  console.log('PROBE-AREAS', q, '→', await get(`/v2/retailers/${chain.retailerId}/areas?${qs}`));
}
console.log('PROBE-TIMES 924/10006', await get(`/v2/retailers/${chain.retailerId}/branches/924/areas/10006/delivery-times?appId=4`));
console.log('PROBE-TIMES 924/2450', await get(`/v2/retailers/${chain.retailerId}/branches/924/areas/2450/delivery-times?appId=4`));
process.exit(0);
