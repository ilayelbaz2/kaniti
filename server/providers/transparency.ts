// Physical-branch prices from the Israeli price-transparency law feeds (חוק שקיפות מחירים).
// Shufersal: prices.shufersal.co.il. Cerberus chains: url.publishedprices.co.il (login flow per
// OpenIsraeliSupermarkets / cerberus.js). Files are cached on disk once per day per store.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { XMLParser } from 'fast-xml-parser';
import type { DeliveryAvailability, ProductSearchResult } from '../../shared/types.ts';
import { nowIso } from '../clock.ts';
import { httpFetch, type GroceryProvider } from './types.ts';

export type PhysicalChain = { id: string; name: string; kind: 'shufersal' | 'cerberus'; user?: string; password?: string };

export const PHYSICAL_CHAINS: PhysicalChain[] = [
  { id: 'shufersal', name: 'שופרסל', kind: 'shufersal' },
  { id: 'ramilevy', name: 'רמי לוי', kind: 'cerberus', user: 'RamiLevi' },
  { id: 'osherad', name: 'אושר עד', kind: 'cerberus', user: 'osherad' },
  { id: 'yohananof', name: 'יוחננוף', kind: 'cerberus', user: 'yohananof' },
  { id: 'tivtaam', name: 'טיב טעם', kind: 'cerberus', user: 'TivTaam' },
  { id: 'keshet', name: 'קשת טעמים', kind: 'cerberus', user: 'Keshet' },
];

export type BranchItem = { code: string; name: string; maker?: string; price: number; promoPrice?: number; promoText?: string; promoMinQty?: number };
export type StoreInfo = { storeId: string; name: string; city: string; address?: string };

const CACHE_DIR = path.resolve(process.env.KANITI_CACHE ?? 'data/cache');
const today = () => new Date().toISOString().slice(0, 10);

// ---------- decoding / XML ----------

export function decodeXml(buf: Buffer): string {
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  const head = buf.subarray(0, 120).toString('latin1');
  const enc = head.match(/encoding="([^"]+)"/i)?.[1]?.toLowerCase();
  if (enc && /1255|8859-8/.test(enc)) return new TextDecoder('windows-1255').decode(buf);
  return buf.toString('utf8');
}

const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: true });

type Obj = Record<string, unknown>;
const lc = (o: Obj) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v])) as Obj;

/** Walks any XML dialect and yields objects that have one of the given (lower-case) keys. */
function* walk(node: unknown, keys: string[]): Generator<Obj> {
  if (Array.isArray(node)) { for (const x of node) yield* walk(x, keys); return; }
  if (!node || typeof node !== 'object') return;
  const o = lc(node as Obj);
  if (keys.some((k) => k in o)) { yield o; if (!('promotionitems' in o) && !('items' in o)) return; }
  for (const v of Object.values(o)) if (v && typeof v === 'object') yield* walk(v, keys);
}

const str = (v: unknown) => (v === undefined || v === null ? '' : String(v).trim());
const fl = (v: unknown) => { const n = parseFloat(str(v)); return Number.isFinite(n) ? n : 0; };

export function parsePriceFull(xml: string): BranchItem[] {
  const doc = parser.parse(xml);
  const out: BranchItem[] = [];
  for (const o of walk(doc, ['itemcode'])) {
    if (!('itemprice' in o)) continue;
    const price = fl(o.itemprice);
    const name = str(o.itemname) || str(o.manufactureritemdescription) || str(o.manufactureitemdescription);
    if (!(price > 0) || !name) continue;
    out.push({ code: str(o.itemcode), name, maker: str(o.manufacturername) || str(o.manufacturename) || undefined, price });
  }
  return out;
}

export function parsePromoFull(xml: string): Map<string, { price: number; minQty: number; text: string }> {
  const doc = parser.parse(xml);
  const map = new Map<string, { price: number; minQty: number; text: string }>();
  for (const o of walk(doc, ['promotionid'])) {
    const clubs = o.clubs as Obj | undefined;
    const club = str(o.clubid ?? (clubs && typeof clubs === 'object' ? lc(clubs).clubid : ''));
    if (club && !/^0\b|כלל/.test(club)) continue; // members-only promotions are not for everyone
    const end = str(o.promotionenddate || o.promotionenddatetime).slice(0, 10);
    if (end && end < today()) continue;
    const text = str(o.promotiondescription);
    // Cerberus puts the price on the promotion; Shufersal on each PromotionItem (inside Groups).
    for (const it of walk(o.promotionitems ?? o.groups, ['itemcode'])) {
      // DiscountedPrice = price for MinQty units. (DiscountedPricePerMida is per unit of *measure*, e.g. per 100g — not usable.)
      const minQty = Math.max(1, Math.round(fl(it.minqty ?? o.minqty)));
      const total = fl(it.discountedprice ?? o.discountedprice);
      const perUnit = total > 0 ? total / minQty : 0;
      if (!(perUnit > 0)) continue;
      const code = str(it.itemcode);
      const prev = map.get(code);
      if (!prev || perUnit < prev.price) map.set(code, { price: Math.round(perUnit * 100) / 100, minQty, text });
    }
  }
  return map;
}

export function parseStores(xml: string): StoreInfo[] {
  const doc = parser.parse(xml);
  const out: StoreInfo[] = [];
  for (const o of walk(doc, ['storeid'])) {
    if (!('storename' in o)) continue;
    out.push({ storeId: str(o.storeid), name: str(o.storename), city: str(o.city), address: str(o.address) || undefined });
  }
  return out;
}

// ---------- file access ----------

async function shufersalLinks(catId: number, storeId: string): Promise<string[]> {
  const url = `https://prices.shufersal.co.il/FileObject/UpdateCategory?catID=${catId}&storeId=${storeId}`;
  const res = await httpFetch(url, {}, 40000).catch(() => httpFetch(url, {}, 40000));
  const html = await res.text();
  return [...html.matchAll(/href="(https:\/\/pricesprodpublic[^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
}

class Cerberus {
  cookie = '';
  constructor(private user: string, private password = '') {}
  private base = 'https://url.publishedprices.co.il';
  private jar(res: Response) {
    const set = res.headers.getSetCookie?.() ?? [];
    const merged = new Map(this.cookie.split('; ').filter(Boolean).map((c) => [c.split('=')[0], c]));
    for (const c of set) { const kv = c.split(';')[0]; merged.set(kv.split('=')[0], kv); }
    this.cookie = [...merged.values()].join('; ');
  }
  private async csrf(url: string) {
    const res = await httpFetch(url, { headers: { Cookie: this.cookie }}, 20000);
    this.jar(res);
    const html = await res.text();
    const t = html.match(/name="csrftoken"\s+content="([^"]+)"/)?.[1];
    if (!t) throw new Error('Cerberus: לא נמצא csrftoken');
    return t;
  }
  async login() {
    const t = await this.csrf(`${this.base}/login`);
    const body = new URLSearchParams({ username: this.user, password: this.password, csrftoken: t });
    const res = await fetch(`${this.base}/login/user`, {
      method: 'POST', redirect: 'manual', body,
      headers: { Cookie: this.cookie, 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0' },
    });
    this.jar(res);
    if (res.status !== 302 && res.status !== 303) throw new Error(`Cerberus login נכשל (${res.status})`);
  }
  async list(): Promise<string[]> {
    const t = await this.csrf(`${this.base}/file`);
    const body = new URLSearchParams({ sEcho: '1', iDisplayStart: '0', iDisplayLength: '100000', cd: '/', csrftoken: t });
    const res = await httpFetch(`${this.base}/file/json/dir`, { method: 'POST', body, headers: { Cookie: this.cookie, 'Content-Type': 'application/x-www-form-urlencoded' } }, 30000);
    const j = (await res.json()) as { aaData?: { fname: string }[]; error?: string };
    if (j.error) throw new Error('Cerberus: ' + j.error);
    return (j.aaData ?? []).map((f) => f.fname);
  }
  async download(name: string): Promise<Buffer> {
    const res = await httpFetch(`${this.base}/file/d/${encodeURIComponent(name)}`, { headers: { Cookie: this.cookie } }, 60000);
    return Buffer.from(await res.arrayBuffer());
  }
}

/** Store id from a feed file name. Two shapes exist:
 *  PriceFull<chain>-<store>-<yyyymmddhhmm>.gz  and  PriceFull<chain>-<subchain>-<store>-<yyyymmdd>-<hhmmss>.gz */
export function storeOfFile(name: string): string | null {
  const parts = name.replace(/\.(gz|xml|zip)$/gi, '').split('-');
  if (parts.length >= 5) return String(parseInt(parts[2]));
  if (parts.length >= 3) return String(parseInt(parts[1]));
  return null;
}
const kindOf = (name: string) => name.match(/^[a-z]+/i)?.[0].toLowerCase() ?? '';

const latest = (names: string[], re: RegExp) => names.filter((n) => re.test(n)).sort((a, b) => stamp(b) - stamp(a))[0];
const stamp = (n: string) => {
  const p = n.replace(/\.(gz|xml|zip)$/gi, '').split('-');
  const tail = p.length >= 5 ? p[p.length - 2] + p[p.length - 1] : p[p.length - 1];
  return parseInt(tail.replace(/\D/g, '').padEnd(14, '0').slice(0, 14) || '0');
};

async function downloadBest(links: string[]): Promise<Buffer> {
  const sorted = [...links].sort((a, b) => stamp(fileOf(b)) - stamp(fileOf(a)));
  if (!sorted[0]) throw new Error('לא נמצא קובץ מחירים');
  const res = await httpFetch(sorted[0], {}, 60000);
  return Buffer.from(await res.arrayBuffer());
}
const fileOf = (url: string) => decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');

export async function listStores(chain: PhysicalChain): Promise<StoreInfo[]> {
  const cacheFile = path.join(CACHE_DIR, `${chain.id}-stores.json`);
  if (fs.existsSync(cacheFile) && Date.now() - fs.statSync(cacheFile).mtimeMs < 7 * 86400000) return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  let xml: string;
  let publishing: Set<string> | undefined;
  if (chain.kind === 'shufersal') xml = decodeXml(await downloadBest(await shufersalLinks(5, '0')));
  else {
    const c = new Cerberus(chain.user!, chain.password);
    await c.login();
    const files = await c.list();
    const name = latest(files, /^stores/i);
    if (!name) throw new Error('אין קובץ סניפים');
    xml = decodeXml(await c.download(name));
    publishing = new Set(files.filter((f) => kindOf(f) === 'pricefull').map(storeOfFile).filter((x): x is string => !!x));
  }
  let stores = parseStores(xml);
  if (publishing?.size) stores = stores.filter((st) => publishing!.has(String(parseInt(st.storeId))));
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(stores));
  return stores;
}

export type BranchData = { items: BranchItem[]; fileDate: string; files?: string[]; promoCount?: number };

export async function loadBranch(chain: PhysicalChain, storeId: string): Promise<BranchData> {
  const cacheFile = path.join(CACHE_DIR, `${chain.id}-${storeId}-${today()}.json`);
  if (fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  let priceXml: string, promoXml = '';
  const used: string[] = [];
  if (chain.kind === 'shufersal') {
    const pl = await shufersalLinks(2, storeId);
    used.push(fileOf(pl[0] ?? ''));
    priceXml = decodeXml(await downloadBest(pl));
    promoXml = await shufersalLinks(4, storeId).then((l) => { used.push(fileOf(l[0] ?? '')); return downloadBest(l); }).then(decodeXml).catch(() => '');
  } else {
    const c = new Cerberus(chain.user!, chain.password);
    await c.login();
    const files = await c.list();
    const sid = String(parseInt(storeId));
    const of = (kind: string) => files.filter((f) => kindOf(f) === kind && storeOfFile(f) === sid);
    const pf = latest(of('pricefull'), /./);
    if (!pf) throw new Error(`אין קובץ PriceFull לסניף ${storeId}`);
    priceXml = decodeXml(await c.download(pf));
    const pr = latest(of('promofull'), /./);
    used.push(pf, pr ?? '(no PromoFull)');
    if (pr) promoXml = decodeXml(await c.download(pr));
  }
  const items = parsePriceFull(priceXml);
  const promos = promoXml ? parsePromoFull(promoXml) : new Map();
  for (const it of items) {
    const p = promos.get(it.code);
    // Sanity: ignore "promos" deeper than 70% — in the feeds those are coupons, gifts or unit-of-measure artefacts.
    if (p && p.price < it.price && p.price >= it.price * 0.3) { it.promoPrice = p.price; it.promoText = p.text; it.promoMinQty = p.minQty; }
  }
  const data: BranchData = { items, fileDate: nowIso(), files: used, promoCount: promos.size };
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  // drop older caches for this store
  for (const f of fs.readdirSync(CACHE_DIR)) if (f.startsWith(`${chain.id}-${storeId}-`) && f !== path.basename(cacheFile)) fs.rmSync(path.join(CACHE_DIR, f));
  fs.writeFileSync(cacheFile, JSON.stringify(data));
  return data;
}

const norm = (s: string) => s.replace(/["'׳״\-]/g, '').replace(/\s+/g, ' ').trim();

/** Simple token search over a branch's price list. */
export function searchBranch(items: BranchItem[], query: string): BranchItem[] {
  const tokens = norm(query).split(' ').filter((t) => t.length > 1 && !/^\d/.test(t));
  if (!tokens.length) return [];
  const scored = items
    .map((it) => {
      const n = norm(it.name);
      const hits = tokens.filter((t) => n.includes(t)).length;
      return { it, hits, score: hits * 2 + (n.startsWith(tokens[0]) ? 3 : 0) };
    })
    .filter((x) => x.hits >= Math.min(tokens.length, Math.max(1, tokens.length - 1)));
  return scored.sort((a, b) => b.score - a.score).slice(0, 60).map((x) => x.it);
}

export function physicalProvider(chain: PhysicalChain, storeId: string, storeName: string): GroceryProvider {
  const id = `branch:${chain.id}:${storeId}`;
  return {
    id, name: `${chain.name} — ${storeName}`, kind: 'physical', deliveryFee: 0, minOrder: 0,
    async checkDelivery(): Promise<DeliveryAvailability> {
      return { providerId: id, delivers: false, note: 'סניף פיזי', checkedLive: false };
    },
    async searchProducts(query): Promise<ProductSearchResult[]> {
      const { items, fileDate } = await loadBranch(chain, storeId);
      return searchBranch(items, query).map((it) => ({
        providerId: id, productId: it.code, name: it.name, brand: it.maker, price: it.price, promoPrice: it.promoPrice,
        promoText: it.promoText, promoMinQty: it.promoMinQty, available: true, source: 'branch_data' as const, fetchedAt: fileDate,
      }));
    },
  };
}
