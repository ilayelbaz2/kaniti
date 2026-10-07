// Tiny persistence layer on Node's built-in SQLite. JSON documents in a few tables.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import type { Basket, ChatMessage, Household, HouseholdNeed, LearningEvent, Purchase, PriceSnapshot, ProductSearchResult, Comparison } from '../shared/types.ts';
import type { Concept } from './catalog.ts';

const file = process.env.KANITI_DB ?? path.resolve('data/kaniti.db');
if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
export const db = new DatabaseSync(file);

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS needs (id TEXT PRIMARY KEY, json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS custom_concepts (id TEXT PRIMARY KEY, json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, need_id TEXT, json TEXT NOT NULL, created_at TEXT);
  CREATE TABLE IF NOT EXISTS purchases (id TEXT PRIMARY KEY, json TEXT NOT NULL, created_at TEXT);
  CREATE TABLE IF NOT EXISTS chat (id TEXT PRIMARY KEY, json TEXT NOT NULL, created_at TEXT);
  CREATE TABLE IF NOT EXISTS price_snapshots (local_date TEXT, provider_id TEXT, need_id TEXT, json TEXT NOT NULL, PRIMARY KEY (local_date, provider_id, need_id));
  CREATE TABLE IF NOT EXISTS prices (
    provider_id TEXT, product_id TEXT, need_id TEXT, name TEXT, price REAL, promo_price REAL,
    source TEXT, json TEXT NOT NULL, fetched_at TEXT
  );
  CREATE INDEX IF NOT EXISTS prices_need ON prices(need_id, fetched_at);
`);

const getKv = db.prepare('SELECT value FROM kv WHERE key = ?');
const setKvStmt = db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

export function kvGet<T>(key: string): T | null {
  const row = getKv.get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : null;
}
export function kvSet(key: string, value: unknown) {
  if (value === null || value === undefined) db.prepare('DELETE FROM kv WHERE key = ?').run(key);
  else setKvStmt.run(key, JSON.stringify(value));
}

export const store = {
  household: () => kvGet<Household>('household'),
  saveHousehold: (h: Household) => kvSet('household', h),
  basket: () => kvGet<Basket>('basket'),
  saveBasket: (b: Basket | null) => kvSet('basket', b),
  comparison: () => kvGet<Comparison>('comparison'),
  saveComparison: (c: Comparison | null) => kvSet('comparison', c),

  needs(): HouseholdNeed[] {
    return (db.prepare('SELECT json FROM needs').all() as { json: string }[]).map((r) => JSON.parse(r.json));
  },
  need(id: string): HouseholdNeed | null {
    const r = db.prepare('SELECT json FROM needs WHERE id = ?').get(id) as { json: string } | undefined;
    return r ? JSON.parse(r.json) : null;
  },
  saveNeed(n: HouseholdNeed) {
    db.prepare('INSERT INTO needs (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json').run(n.id, JSON.stringify(n));
  },

  customConcepts(): Concept[] {
    return (db.prepare('SELECT json FROM custom_concepts').all() as { json: string }[]).map((r) => JSON.parse(r.json));
  },
  saveCustomConcept(c: Concept) {
    db.prepare('INSERT OR REPLACE INTO custom_concepts (id, json) VALUES (?, ?)').run(c.id, JSON.stringify(c));
  },

  addEvent(e: LearningEvent) {
    db.prepare('INSERT INTO events (type, need_id, json, created_at) VALUES (?, ?, ?, ?)').run(e.type, e.needId ?? null, JSON.stringify(e), e.createdAt);
  },
  events(needId?: string, limit = 200): LearningEvent[] {
    const rows = needId
      ? db.prepare('SELECT id, json FROM events WHERE need_id = ? ORDER BY id DESC LIMIT ?').all(needId, limit)
      : db.prepare('SELECT id, json FROM events ORDER BY id DESC LIMIT ?').all(limit);
    return (rows as { id: number; json: string }[]).map((r) => ({ ...JSON.parse(r.json), id: r.id }));
  },

  /** One price per (day, provider, need) — the latest of the day wins. For learning cheap weekdays. */
  addSnapshots(rows: PriceSnapshot[]) {
    const st = db.prepare('INSERT OR REPLACE INTO price_snapshots (local_date, provider_id, need_id, json) VALUES (?, ?, ?, ?)');
    for (const r of rows) st.run(r.localDate, r.providerId, r.needId, JSON.stringify(r));
  },
  snapshots(sinceDate: string): PriceSnapshot[] {
    return (db.prepare('SELECT json FROM price_snapshots WHERE local_date >= ?').all(sinceDate) as { json: string }[]).map((r) => JSON.parse(r.json));
  },

  purchases(): Purchase[] {
    return (db.prepare('SELECT json FROM purchases ORDER BY created_at DESC').all() as { json: string }[]).map((r) => JSON.parse(r.json));
  },
  savePurchase(p: Purchase) {
    db.prepare('INSERT OR REPLACE INTO purchases (id, json, created_at) VALUES (?, ?, ?)').run(p.id, JSON.stringify(p), p.createdAt);
  },

  chat(limit = 80): ChatMessage[] {
    return (db.prepare('SELECT json FROM chat ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit) as { json: string }[])
      .map((r) => JSON.parse(r.json))
      .reverse();
  },
  addChat(m: ChatMessage) {
    db.prepare('INSERT INTO chat (id, json, created_at) VALUES (?, ?, ?)').run(m.id, JSON.stringify(m), m.createdAt);
  },

  addPrices(needId: string, rows: ProductSearchResult[]) {
    const ins = db.prepare('INSERT INTO prices (provider_id, product_id, need_id, name, price, promo_price, source, json, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const r of rows) ins.run(r.providerId, r.productId, needId, r.name, r.price, r.promoPrice ?? null, r.source, JSON.stringify(r), r.fetchedAt);
  },
  /** Median regular price we've seen for this exact product at this provider (our "normal price"). */
  dismissedDeals: () => kvGet<string[]>('dismissedDealIds') ?? [],
  normalPrice(providerId: string, productId: string, sinceIso: string): number | null {
    const rows = db.prepare('SELECT price FROM prices WHERE provider_id = ? AND product_id = ? AND fetched_at >= ?').all(providerId, productId, sinceIso) as { price: number }[];
    if (rows.length < 2) return null;
    const v = rows.map((r) => r.price).sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)];
  },

  reset() {
    db.exec('DELETE FROM kv; DELETE FROM needs; DELETE FROM custom_concepts; DELETE FROM events; DELETE FROM purchases; DELETE FROM chat; DELETE FROM prices; DELETE FROM price_snapshots;');
  },
};
