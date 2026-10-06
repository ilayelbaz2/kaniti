// Temporary diagnostics for provider formats (run in CI where the network is open).
process.env.KANITI_DB = ':memory:';

const p = (...a: unknown[]) => console.log(...a);
const snip = (s: string, n = 600) => s.replace(/\s+/g, ' ').slice(0, n);

async function raw(url: string, init: RequestInit = {}) {
  try {
    const r = await fetch(url, { ...init, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36', 'Accept-Language': 'he-IL,he;q=0.9', ...(init.headers ?? {}) } });
    const t = await r.text();
    p(`  ${r.status} ${url.slice(0, 140)} server=${r.headers.get('server')} cf=${r.headers.get('cf-ray') ? 'yes' : 'no'} :: ${snip(t, 400)}`);
    return t;
  } catch (e) { p(`  ERR ${url.slice(0, 120)} ${(e as Error).message}`); return ''; }
}

p('=== Tiv Taam (ZuZ) search variants');
const host = 'https://www.tivtaam.co.il';
const filters = encodeURIComponent(JSON.stringify({ must: { exists: ['family.id', 'family.categoriesPaths.id', 'branch.regularPrice'], term: { 'branch.isActive': true, 'branch.isVisible': true } }, mustNot: { term: { 'branch.regularPrice': 0 } } }));
const br = JSON.parse((await raw(`${host}/v2/retailers/1062/branches?appId=4&languageId=1`)) || '{}');
p('  branches:', JSON.stringify((br.branches ?? []).slice(0, 6).map((b: { id: number; name: string; city?: string }) => [b.id, b.name, b.city])));
const ids = [924, ...(br.branches ?? []).slice(0, 2).map((b: { id: number }) => b.id)];
for (const bid of ids) {
  await raw(`${host}/v2/retailers/1062/branches/${bid}/products?appId=4&languageId=1&isSearch=true&from=0&size=3&query=${encodeURIComponent('חלב')}&filters=${filters}`, { headers: { Accept: 'application/json' } });
  await raw(`${host}/v2/retailers/1062/branches/${bid}/products?appId=4&languageId=1&from=0&size=3&query=${encodeURIComponent('חלב')}`, { headers: { Accept: 'application/json' } });
  await raw(`${host}/v2/retailers/1062/branches/${bid}/products?appId=4&languageId=1&from=0&size=3&q=${encodeURIComponent('חלב')}`, { headers: { Accept: 'application/json' } });
}

p('=== blocked online sites');
await raw('https://www.shufersal.co.il/online/he/search/results?q=%D7%97%D7%9C%D7%91&limit=3', { headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' } });
await raw('https://www.rami-levy.co.il/api/catalog?', { method: 'POST', body: JSON.stringify({ q: 'חלב', store: '331', aggs: 0, size: 3 }), headers: { Accept: 'application/json', 'Content-Type': 'application/json;charset=UTF-8', Origin: 'https://www.rami-levy.co.il', Referer: 'https://www.rami-levy.co.il/he' } });
await raw('https://www.victoryonline.co.il/v2/retailers/1470/branches?appId=4&languageId=1', { headers: { Accept: 'application/json' } });

await raw(`${host}/v2/retailers/1062/branches/${ids[1] ?? 924}/categories?appId=4&languageId=1`, { headers: { Accept: 'application/json' } });
await raw(`${host}/v2/retailers/1062/products?appId=2&languageId=1&from=0&size=2&query=${encodeURIComponent('חלב')}`, { headers: { Accept: 'application/json' } });

p('=== Tiv Taam product shape');
{
  const t = await raw(`${host}/v2/retailers/1062/branches/939/products?appId=4&languageId=1&isSearch=true&from=0&size=2&query=${encodeURIComponent('חלב')}&filters=${filters}`, { headers: { Accept: 'application/json' } });
  try {
    const j = JSON.parse(t);
    const pr = j.products?.[0] ?? {};
    p('  keys:', Object.keys(pr).join(','));
    p('  name fields:', JSON.stringify({ localName: pr.localName, names: pr.names, id: pr.id, productId: pr.productId }).slice(0, 400));
    p('  branch:', JSON.stringify(pr.branch ?? pr.branches ?? null).slice(0, 600));
  } catch (e) { p('  parse fail', (e as Error).message); }
}
