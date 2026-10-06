// Single source of "now". A dev-only offset lets us simulate the next shopping cycle.
import { kvGet, kvSet } from './db.ts';

export function now(): Date {
  const offsetDays = kvGet<number>('clockOffsetDays') ?? 0;
  return new Date(Date.now() + offsetDays * 86400000);
}
export const nowIso = () => now().toISOString();
export function advanceDays(days: number) {
  kvSet('clockOffsetDays', (kvGet<number>('clockOffsetDays') ?? 0) + days);
}
export function daysBetween(fromIso: string, to: Date = now()) {
  return (to.getTime() - new Date(fromIso).getTime()) / 86400000;
}
export const uid = (p = '') => p + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
