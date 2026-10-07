// Picks a concrete product for a need, honouring how flexible the household is about it.
import { identityGaps } from '../../shared/product.ts';
import type { HouseholdNeed, ProductSearchResult } from '../../shared/types.ts';
import { PARVE_MARKERS, type Concept } from '../catalog.ts';

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

// Words that turn a product into something else ("מיץ עגבניות", "אטריות ביצים", "תחליב רחצה מלפפון").
// Ignored when the concept itself uses the word (e.g. ממרח שוקולד, מעדנים).
const NOISE = ['מיץ', 'תחליב', 'שמפו', 'סבון', 'עוגי', 'עוגה', 'אטריות', 'איטריות', 'רוטב', 'ממרח', 'יוגורט', 'מעדן', 'גלידה', 'חטיף', 'סלט', 'קרם', 'משקה', 'בטעם', 'רסק', 'אבקת', 'תרסיס', 'מגבונ', 'ופל', 'מרק', 'קוסקוס', 'פירורי', 'מילוי', 'ממולא', 'שייק', 'אוזני', 'ביסקוויט', 'שוקו', 'קוביות', 'כבוש', 'במלח', 'לאטה', 'סניקרס'];
const words = (s: string) => norm(s).split(/[\s,.()/+*]+/).filter(Boolean);

/** How well a product name fits the concept: core term near the start of the name ranks highest. */
export function fit(concept: Concept, p: ProductSearchResult): number {
  const w = words(p.name).map((x) => x.replace(/^[והב](?=..)/, ''));
  const must = (concept.mustInclude ?? []).map(norm);
  const starts = (x: string | undefined) => !!x && must.some((m) => x.startsWith(m) || norm(p.name).startsWith(m));
  let score = 0;
  if (starts(w[0])) score += 3;
  else if (starts(w[1])) score += 1;
  for (const t of words(concept.query)) if (t.length > 1 && !/^\d/.test(t) && has(p.name, t)) score += 1;
  if (concept.prefer && concept.prefer.test(p.name + ' ' + (p.sizeText ?? ''))) score += 2;
  return score;
}

export function relevant(concept: Concept, need: HouseholdNeed | null, p: ProductSearchResult): boolean {
  if (!p.available || !(p.price > 0)) return false;
  const text = p.name + ' ' + (p.brand ?? '');
  if (concept.mustInclude?.length && !concept.mustInclude.some((w) => has(text, w))) return false;
  if (concept.alsoInclude?.length && !concept.alsoInclude.some((w) => has(text, w))) return false;
  if (concept.exclude?.some((w) => has(text, w))) return false;
  if (need?.forbiddenBrands.some((b) => has(text, b))) return false;
  const own = norm([concept.label, concept.query, ...concept.synonyms, ...(concept.mustInclude ?? [])].join(' '));
  if (words(p.name).some((x) => NOISE.some((n) => (x.startsWith(n) || x.slice(1).startsWith(n)) && !own.includes(n)))) return false;
  if (needsParveCheck(concept, need) && !PARVE_MARKERS.some((m) => has(text, m))) return false;
  if ((concept.dairyFree || need?.hardConstraints.includes(DAIRY_FREE)) && mentionsDairy(p.name)) return false;
  return true;
}

export const DAIRY_FREE = 'ללא חלב';

/** "…וחלב 2%", "חלבי", "גבינה" — dairy named in the product (plant "milks" and "ללא חלב" don't count). */
export function mentionsDairy(name: string): boolean {
  const n = norm(name).replace(/ללא (חלב|לקטוז)/g, ' ').replace(/(חלב|משקה) (סויה|שקדים|קוקוס|שיבולת שועל|אורז)/g, ' ').replace(/חמאת בוטנים/g, ' ');
  return /(^|\s)(ו?חלב|חלבי|ו?גבינ|ו?שמנת|ו?חמאה|מי גבינה)/.test(n);
}
const SAFE_FOR_DAIRY_FREE = new Set(['meat', 'fish', 'produce', 'cleaning', 'paper', 'eggs']);
/** A hard dairy-free constraint is enforced by name markers (פרווה / ללא חלב / סויה…) unless the category can't contain dairy. */
export function needsParveCheck(concept: Concept, need: HouseholdNeed | null): boolean {
  if (concept.dairyFree) return false; // already enforced by alsoInclude
  if (!need?.hardConstraints.includes(DAIRY_FREE)) return false;
  return !SAFE_FOR_DAIRY_FREE.has(concept.category) && !concept.parveByDefault;
}

/** The concept's core word appears among the first words of the product name ("ביצים L…", not "…מאפה עם ביצים"). */
export function headMatch(concept: Concept, p: ProductSearchResult): boolean {
  const must = (concept.mustInclude ?? []).map(norm);
  if (!must.length) return true;
  const w = words(p.name).slice(0, 3).map((x) => x.replace(/^[והב](?=..)/, ''));
  return w.some((x) => must.some((m) => x.startsWith(m))) || must.some((m) => norm(p.name).startsWith(m));
}

/** uncertain = the best candidate doesn't clearly look like this need — show alternatives, never auto-buy it. */
export type Choice = { product: ProductSearchResult; substituted: boolean; usualName?: string; note?: string; uncertain?: boolean } | null;

export function chooseProduct(concept: Concept, need: HouseholdNeed, candidates: ProductSearchResult[]): Choice {
  const c = choose(concept, need, candidates);
  if (c && !headMatch(concept, c.product) && norm(c.product.name) !== norm(need.lastProductName ?? '')) c.uncertain = true;
  // Can't tell the user what exactly this is (no brand, no size, not sold by weight) → let them pick, never auto-buy.
  if (c && identityGaps(c.product).ambiguous && norm(c.product.name) !== norm(need.lastProductName ?? '')) c.uncertain = true;
  return c;
}

function choose(concept: Concept, need: HouseholdNeed, candidates: ProductSearchResult[]): Choice {
  const all = candidates.filter((p) => relevant(concept, need, p));
  if (!all.length) return null;
  // Only the best-fitting names compete on price (so "ביצים L" beats a cheaper "ביצים לבישול" side product).
  const best = Math.max(...all.map((p) => fit(concept, p)));
  const pool = all.filter((p) => fit(concept, p) >= best - 1);
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
