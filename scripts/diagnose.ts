// Temporary diagnostics for provider formats (run in CI where the network is open).
process.env.KANITI_DB = ':memory:';
import zlib from 'node:zlib';
const T = await import('../server/providers/transparency.ts');
const { httpFetch } = await import('../server/providers/types.ts');

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

p('=== store cities');
for (const id of ['shufersal', 'ramilevy', 'osherad', 'keshet']) {
  const chain = T.PHYSICAL_CHAINS.find((c) => c.id === id)!;
  try {
    const stores = await T.listStores(chain);
    p(id, stores.length, JSON.stringify(stores.slice(0, 3)));
    p('  cities sample:', [...new Set(stores.map((s) => s.city))].slice(0, 25).join(' | '));
    p('  רמת:', JSON.stringify(stores.filter((s) => /רמת|גן|ramat/i.test(s.city + s.name + (s.address ?? ''))).slice(0, 5)));
  } catch (e) { p(id, 'ERR', (e as Error).message); }
}

p('=== shufersal promo links');
const html = await raw('https://prices.shufersal.co.il/FileObject/UpdateCategory?catID=4&storeId=1');
const links = [...html.matchAll(/href="(https:\/\/pricesprodpublic[^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
p('  links', links.length, links[0]?.slice(0, 160));
if (links[0]) {
  const buf = Buffer.from(await (await httpFetch(links[0], {}, 60000)).arrayBuffer());
  const xml = T.decodeXml(buf);
  p('  promo xml head:', snip(xml, 1500));
  p('  parsed promos:', T.parsePromoFull(xml).size);
}

p('=== cerberus RamiLevi files');
{
  // reuse internals through loadBranch path: replicate listing
  const base = 'https://url.publishedprices.co.il';
  let cookie = '';
  const jar = (r: Response) => { for (const c of r.headers.getSetCookie()) cookie = [cookie, c.split(';')[0]].filter(Boolean).join('; '); };
  let r = await fetch(`${base}/login`); jar(r);
  let t = (await r.text()).match(/name="csrftoken"\s+content="([^"]+)"/)?.[1] ?? '';
  r = await fetch(`${base}/login/user`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ username: 'RamiLevi', password: '', csrftoken: t }), headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' } }); jar(r);
  p('  login', r.status);
  r = await fetch(`${base}/file`, { headers: { Cookie: cookie } }); jar(r);
  t = (await r.text()).match(/name="csrftoken"\s+content="([^"]+)"/)?.[1] ?? '';
  r = await fetch(`${base}/file/json/dir`, { method: 'POST', body: new URLSearchParams({ sEcho: '1', iDisplayStart: '0', iDisplayLength: '100000', cd: '/', csrftoken: t }), headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' } });
  const j = (await r.json()) as { aaData: { fname: string }[] };
  const names = j.aaData.map((f) => f.fname);
  p('  files', names.length);
  p('  promo-ish:', names.filter((n) => /promo/i.test(n)).slice(0, 12).join(' , '));
  p('  price-ish:', names.filter((n) => /price/i.test(n)).slice(0, 8).join(' , '));
  p('  stores-ish:', names.filter((n) => /store/i.test(n)).slice(0, 5).join(' , '));
  const promo = names.filter((n) => /^promofull/i.test(n)).sort().reverse()[0];
  if (promo) {
    const b = Buffer.from(await (await fetch(`${base}/file/d/${encodeURIComponent(promo)}`, { headers: { Cookie: cookie } })).arrayBuffer());
    const xml = T.decodeXml(b[0] === 0x1f ? zlib.gunzipSync(b) : b);
    p('  ', promo, 'parsed', T.parsePromoFull(xml).size, 'head', snip(xml, 800));
  }
}

p('=== Tiv Taam (ZuZ) search variants');
const host = 'https://www.tivtaam.co.il';
await raw(`${host}/v2/retailers/1062/branches?appId=4&languageId=1`);
const filters = encodeURIComponent(JSON.stringify({ must: { exists: ['family.id', 'family.categoriesPaths.id', 'branch.regularPrice'], term: { 'branch.isActive': true, 'branch.isVisible': true } }, mustNot: { term: { 'branch.regularPrice': 0 } } }));
for (const bid of [924, 1278]) {
  await raw(`${host}/v2/retailers/1062/branches/${bid}/products?appId=4&languageId=1&isSearch=true&from=0&size=3&query=${encodeURIComponent('חלב')}&filters=${filters}`, { headers: { Accept: 'application/json' } });
  await raw(`${host}/v2/retailers/1062/branches/${bid}/products?appId=4&languageId=1&from=0&size=3&query=${encodeURIComponent('חלב')}`, { headers: { Accept: 'application/json' } });
  await raw(`${host}/v2/retailers/1062/branches/${bid}/products?appId=4&languageId=1&from=0&size=3&q=${encodeURIComponent('חלב')}`, { headers: { Accept: 'application/json' } });
}

p('=== blocked online sites');
await raw('https://www.shufersal.co.il/online/he/search/results?q=%D7%97%D7%9C%D7%91&limit=3', { headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' } });
await raw('https://www.rami-levy.co.il/api/catalog?', { method: 'POST', body: JSON.stringify({ q: 'חלב', store: '331', aggs: 0, size: 3 }), headers: { Accept: 'application/json', 'Content-Type': 'application/json;charset=UTF-8', Origin: 'https://www.rami-levy.co.il', Referer: 'https://www.rami-levy.co.il/he' } });
await raw('https://www.victoryonline.co.il/v2/retailers/1470/branches?appId=4&languageId=1', { headers: { Accept: 'application/json' } });
