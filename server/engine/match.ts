// Picks a concrete product for a need, honouring how flexible the household is about it.
import type { HouseholdNeed, ProductSearchResult } from '../../shared/types.ts';
import type { Concept } from '../catalog.ts';

export const effPrice = (p: ProductSearchResult) => p.promoPrice ?? p.price;

/** Parses pack size from a product name: "500 גרם", "1.5 ליטר", "6*1.5 ל", "1 ק\"ג". Returns base units (g / ml). */
export function parseSize(name: string): { amount: number; unit: 'g' | 'ml' } | null {
  const s = name.replace(/״/g, '"').replace(/׳/g, "'");
  const multi = s.match(/(\d+)\s*[*xX×]\s*(\d+(?:\.\d+)?)\s*(גרם|גר|ג'|ג|מ"ל|מל|ליטר|ל'|ל|ק"ג|קג)/);
  const single = s.match(/(\d+(?:\.\d+)?)\s*(גרם|גר'|גר|ג'|מ"ל|מל|ליטר|ל'|ק"ג|קג|ק"ג)/);
  const toBase = (v: number, u: string) => {
    if (/ק"?ג/.test(u)) return { amount: v * 1000, unit: 'g' as const };
    if (/ג/.test(u)) return { amount: v, unit: 'g' as const };
    if (/מ"?ל/.test(u)) return { amount: v, unit: 'ml' as const };
    return { amount: v * 1000, unit: 'ml' as const };
  };
  if (multi) {
    const b = toBase(parseFloat(multi[2]), multi[3]);
    return { amount: b.amount * parseInt(multi[1]), unit: b.unit };
  }
  if (single) return toBase(parseFloat(single[1]), single[2]);
  return null;
}

/** Price per 100g/100ml when the size is parseable, else the pack price. Only comparable within the same unit. */
function comparablePrice(p: ProductSearchResult): { key: string; v: number } {
  const size = parseSize(p.name + ' ' + (p.sizeText ?? ''));
  if (size && size.amount > 0) return { key: size.unit, v: (effPrice(p) / size.amount) * 100 };
  return { key: 'pack', v: effPrice(p) };
}

export function cheaper(a: ProductSearchResult, b: ProductSearchResult): number {
  const ca = comparablePrice(a), cb = comparablePrice(b);
  if (ca.key === cb.key) return ca.v - cb.v;
  return effPrice(a) - effPrice(b);
}

const norm = (s: string) => s.replace(/["'׳״\-]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const has = (hay: string, needle: string) => norm(hay).includes(norm(needle));

export function brandOf(p: ProductSearchResult, concept: Concept): string | undefined {
  if (p.brand) return p.brand;
  return concept.brands.find((b) => has(p.name, b));
}

export function relevant(concept: Concept, need: HouseholdNeed | null, p: ProductSearchResult): boolean {
  if (!p.available || !(p.price > 0)) return false;
  const text = p.name + ' ' + (p.brand ?? '');
  if (concept.mustInclude?.length && !concept.mustInclude.some((w) => has(text, w))) return false;
  if (concept.exclude?.some((w) => has(text, w))) return false;
  if (need?.forbiddenBrands.some((b) => has(text, b))) return false;
  return true;
}

export type Choice = { product: ProductSearchResult; substituted: boolean; usualName?: string; note?: string } | null;

export function chooseProduct(concept: Concept, need: HouseholdNeed, candidates: ProductSearchResult[]): Choice {
  const pool = candidates.filter((p) => relevant(concept, need, p));
  if (!pool.length) return null;
  const sorted = [...pool].sort(cheaper);
  const cheapest = sorted[0];
  const preferred = sorted.filter((p) =>
    need.preferredBrands.some((b) => has(p.name + ' ' + (p.brand ?? ''), b)) ||
    (need.lastProductName ? norm(p.name) === norm(need.lastProductName) : false),
  );
  const usual = need.lastProductName ? pool.find((p) => norm(p.name) === norm(need.lastProductName!)) : undefined;

  switch (need.flexibility) {
    case 'exact_product': {
      // Strict: only the preferred product/brand. Never substitute.
      if (usual) return { product: usual, substituted: false };
      if (need.preferredBrands.length) return preferred[0] ? { product: preferred[0], substituted: false } : null;
      return { product: cheapest, substituted: false };
    }
    case 'brand_flexible': {
      const best = preferred[0];
      if (!best) return { product: cheapest, substituted: false };
      // Switch brand only when it's really worth it (15%+ cheaper).
      if (cheaper(cheapest, best) < 0 && effPrice(cheapest) <= effPrice(best) * 0.85) {
        return { product: cheapest, substituted: true, usualName: best.name, note: `זול ב־${Math.round((1 - effPrice(cheapest) / effPrice(best)) * 100)}% מ${best.name}` };
      }
      return { product: best, substituted: false };
    }
    default: {
      const substituted = !!need.lastProductName && norm(cheapest.name) !== norm(need.lastProductName);
      return { product: cheapest, substituted, usualName: substituted ? need.lastProductName : undefined };
    }
  }
}
