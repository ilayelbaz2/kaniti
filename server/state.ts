// Household state: onboarding, needs, stock estimation and the learning rules.
// Everything here is deterministic; the chat layer only calls these functions.
import type { Flexibility, Household, HouseholdNeed, LearningEvent, Level } from '../shared/types.ts';
import { DAIRY_FREE } from './engine/match.ts';
import { CONCEPTS, conceptById, customConcept, defaultTypical14, round1, type Concept } from './catalog.ts';
import { store } from './db.ts';
import { daysBetween, now, nowIso } from './clock.ts';

export function getConcept(id: string): Concept {
  return conceptById.get(id) ?? store.customConcepts().find((c) => c.id === id) ?? customConcept(id, id);
}
export function allConcepts(): Concept[] {
  return [...CONCEPTS, ...store.customConcepts()];
}

export type OnboardingInput = {
  adults: number;
  children: { age: number }[];
  kosher: boolean;
  dairyAllergy: boolean;
  vegetarian: boolean;
  otherConstraint?: string;
  address: { city: string; street?: string };
  onlineProviders: string[];
  physicalStores: { chainId: string; storeId: string; name: string }[];
  flex: Partial<Record<'COLA_ZERO' | 'LAUNDRY_SOFTENER' | 'CREAM_CHEESE', 'strict' | 'deal' | 'any'>>;
  staples: string[];
  customStaples: (string | { label: string; level: 'always' | 'sometimes' })[];
  /** Per item: always / sometimes needed at home, or "not us". Replaces `staples` when present. */
  stapleLevels?: Record<string, 'always' | 'sometimes' | 'no'>;
  annoyText?: string;
  threshold: number;
  dairyAllergyWho?: 'all' | 'kids';
  deliveryStatus?: Record<string, import('../shared/types.ts').DeliveryStatus>;
};

const FLEX_FROM_ANSWER: Record<'strict' | 'deal' | 'any', Flexibility> = {
  strict: 'exact_product',
  deal: 'brand_flexible',
  any: 'category_flexible',
};

export function completeOnboarding(input: OnboardingInput): Household {
  const answers = Object.values(input.flex);
  const flexScore = answers.reduce((s, a) => s + (a === 'strict' ? 0 : a === 'deal' ? 1 : 2), 0) / Math.max(1, answers.length);
  const style: Household['flexibilityStyle'] = flexScore < 0.7 ? 'strict' : flexScore > 1.4 ? 'adventurous' : 'balanced';

  const household: Household = {
    id: 'home',
    adults: input.adults,
    children: input.children,
    kosher: input.kosher,
    allergies: input.dairyAllergy ? [input.dairyAllergyWho === 'kids' ? 'חלב (הילד)' : 'חלב'] : [],
    childDairyAllergy: input.dairyAllergy && input.dairyAllergyWho === 'kids',
    dietNotes: [input.vegetarian ? 'צמחוני' : '', input.otherConstraint ?? ''].filter(Boolean),
    homeAddress: input.address,
    driveSavingsThresholdNis: input.threshold,
    onlineProviders: input.onlineProviders,
    physicalStores: input.physicalStores,
    flexibilityStyle: style,
    shopEveryDays: 14,
    onboardedAt: nowIso(),
    deliveryStatus: input.deliveryStatus,
  };
  store.saveHousehold(household);
  const kidsOnly = input.dairyAllergy && input.dairyAllergyWho === 'kids';
  // A child with a dairy allergy: their desserts become dairy-free desserts.
  if (kidsOnly && input.staples.includes('KIDS_DAIRY')) input.staples = [...input.staples.filter((x) => x !== 'KIDS_DAIRY'), 'DAIRY_FREE_DESSERT'];

  const levels: Record<string, 'always' | 'sometimes' | 'no'> = { ...(input.stapleLevels ?? {}) };
  if (!input.stapleLevels) for (const id of input.staples) levels[id] = 'always';
  if (kidsOnly && levels.KIDS_DAIRY && levels.KIDS_DAIRY !== 'no') { levels.DAIRY_FREE_DESSERT = levels.KIDS_DAIRY; delete levels.KIDS_DAIRY; }
  for (const cs of input.customStaples ?? []) {
    const label = (typeof cs === 'string' ? cs : cs.label).trim();
    if (label) levels[customConceptFor(label).id] = typeof cs === 'string' ? 'always' : cs.level;
  }
  input.staples = Object.entries(levels).filter(([, l]) => l !== 'no').map(([id]) => id);

  const kids = input.children.length;
  for (const concept of allConcepts()) {
    const answer = input.flex[concept.id as keyof OnboardingInput['flex']];
    const n: HouseholdNeed = store.need(concept.id) ?? newNeed(concept, input.adults, kids);
    n.active = input.staples.includes(concept.id);
    // Staple = "don't let it run out". How often it is bought stays with the replenishment engine.
    const level = levels[concept.id];
    n.staple = level === 'always' || level === 'sometimes' ? level : undefined;
    if (level === 'no') n.neverSuggest = true; // "לא אצלנו" — reversible
    else if (level === 'always' || level === 'sometimes') n.neverSuggest = false;
    if (answer) {
      n.flexibility = FLEX_FROM_ANSWER[answer];
      n.flexConfidence = 0.8;
      if (concept.id === 'COLA_ZERO' && answer === 'strict') n.preferredBrands = ['קוקה קולה'];
      if (answer === 'any') n.dealSensitivity = 'high';
    } else {
      n.flexibility = inferFlex(concept.defaultFlex, style);
    }
    if (input.vegetarian && (concept.meat || concept.category === 'fish')) { n.active = false; n.neverSuggest = true; n.hardConstraints = ['צמחוני']; }
    if (input.dairyAllergy && !kidsOnly) {
      // Whole household is dairy-free: dairy concepts are out, everything else must look parve.
      if (concept.dairy) { n.active = false; n.neverSuggest = true; n.hardConstraints = ['אלרגיה לחלב']; } else n.hardConstraints = [DAIRY_FREE];
    }
    if (kidsOnly) {
      if (concept.id === 'KIDS_DAIRY') { n.active = false; n.neverSuggest = true; n.hardConstraints = ['אלרגיה לחלב (הילד)']; }
      else if (concept.kidItem) n.hardConstraints = [DAIRY_FREE]; // shared with the child → must be parve
    }
    if (concept.dairyFree) n.hardConstraints = [DAIRY_FREE];
    if ((concept.id === 'KIDS_DAIRY' || concept.id === 'DAIRY_FREE_DESSERT') && kids === 0) n.active = false;
    store.saveNeed(n);
  }
  return household;
}

function inferFlex(def: Flexibility, style: Household['flexibilityStyle']): Flexibility {
  if (style === 'strict' && def === 'category_flexible') return 'brand_flexible';
  if (style === 'adventurous' && def === 'brand_flexible') return 'category_flexible';
  return def;
}

export function newNeed(concept: Concept, adults: number, kids: number): HouseholdNeed {
  return {
    id: concept.id,
    label: concept.label,
    emoji: concept.emoji,
    active: false,
    flexibility: concept.defaultFlex,
    preferredBrands: [],
    forbiddenBrands: [],
    hardConstraints: [],
    typical14DayQty: defaultTypical14(concept, adults, kids),
    qtySource: 'default',
    stockConfidence: 0,
    dealSensitivity: concept.dealSensitivity,
    wasteRisk: concept.wasteRisk,
    removedCount: 0,
    dismissedDeals: 0,
    flexConfidence: 0.3,
  };
}

/** Make sure a need exists for a concept (used when chat mentions something new). */
export function ensureNeed(conceptId: string): HouseholdNeed {
  const existing = store.need(conceptId);
  if (existing) return existing;
  const h = store.household();
  const n = newNeed(getConcept(conceptId), h?.adults ?? 2, h?.children.length ?? 0);
  store.saveNeed(n);
  return n;
}

/** Finds a known concept by label/synonym, or creates a custom one for something new ("אבוקדו"). */
export function customConceptFor(label: string): Concept {
  const clean = label.trim();
  const existing = allConcepts().find((c) => c.label === clean || c.synonyms.includes(clean));
  if (existing) return existing;
  const cc = customConcept('CUSTOM_' + Math.abs(hash(clean)), clean);
  store.saveCustomConcept(cc);
  return cc;
}

// ---------- stock ----------

export type StockEstimate = { qty: number; confidence: number; known: boolean };

export function estimateStock(n: HouseholdNeed, at: Date = now()): StockEstimate {
  const rate = n.typical14DayQty / 14;
  if (n.stockAsOf === undefined || n.currentStockEstimate === undefined) {
    return { qty: round1(n.typical14DayQty * 0.25), confidence: 0.15, known: false };
  }
  const days = Math.max(0, daysBetween(n.stockAsOf, at));
  const qty = Math.max(0, n.currentStockEstimate - rate * days);
  const confidence = n.stockConfidence * Math.pow(0.5, days / 14);
  return { qty: round1(qty), confidence, known: true };
}

export function setStock(needId: string, qty: number, confidence: number, raw?: string): HouseholdNeed {
  const n = ensureNeed(needId);
  // Reality check against our estimate: ran out early → they use more; lots left over → they use less.
  const est = estimateStock(n);
  if (est.known && est.confidence > 0.3 && n.qtySource !== 'user' && confidence >= 0.7) {
    if (qty <= 0.01 && est.qty > n.typical14DayQty * 0.35) {
      n.typical14DayQty = round1(n.typical14DayQty * 1.15);
      n.qtySource = 'learned';
      logEvent({ type: 'quantity_changed', needId, value: { reason: 'ran_out_early', newTypical: n.typical14DayQty } });
    } else if (qty > est.qty + n.typical14DayQty * 0.5) {
      n.typical14DayQty = round1(Math.max(n.typical14DayQty * 0.9, 0.3));
      n.qtySource = 'learned';
      logEvent({ type: 'quantity_changed', needId, value: { reason: 'left_over', newTypical: n.typical14DayQty } });
    }
  }
  n.currentStockEstimate = Math.max(0, qty);
  n.stockAsOf = nowIso();
  n.stockConfidence = confidence;
  store.saveNeed(n);
  logEvent({ type: 'stock_report', needId, value: { qty, raw } });
  return n;
}

/** Turns fuzzy amounts ("הרבה", "קצת") into stock units relative to consumption. */
export function fuzzyStock(n: HouseholdNeed, level: 'none' | 'little' | 'some' | 'lots'): { qty: number; confidence: number } {
  const t = n.typical14DayQty;
  switch (level) {
    case 'none': return { qty: 0, confidence: 0.95 };
    case 'little': return { qty: t * 0.25, confidence: 0.7 };
    case 'some': return { qty: t * 0.7, confidence: 0.6 };
    case 'lots': return { qty: t * 1.6, confidence: 0.75 };
  }
}

// ---------- learning ----------

export function logEvent(e: Omit<LearningEvent, 'createdAt'>) {
  store.addEvent({ ...e, createdAt: nowIso() });
}

export function updateNeed(needId: string, patch: Partial<HouseholdNeed>, statement?: string): HouseholdNeed {
  const n = { ...ensureNeed(needId), ...patch };
  store.saveNeed(n);
  if (statement !== undefined) logEvent({ type: 'preference_statement', needId, value: { patch, statement } });
  return n;
}

/** User changed the quantity of a generated item: nudge the consumption estimate toward it. */
export function learnFromQuantity(needId: string, packs: number, horizonDays: number) {
  const n = ensureNeed(needId);
  const c = getConcept(needId);
  const projected = estimateStock(n).qty;
  const implied = ((packs * c.packSize + projected) / Math.max(7, horizonDays)) * 14;
  n.typical14DayQty = round1(0.6 * n.typical14DayQty + 0.4 * implied);
  n.qtySource = 'learned';
  store.saveNeed(n);
  logEvent({ type: 'quantity_changed', needId, value: { packs, newTypical: n.typical14DayQty } });
}

/** Removed from a generated basket. Repeated removals reduce how much we expect them to use it. */
export function learnFromRemoval(needId: string, temporary: boolean) {
  const n = ensureNeed(needId);
  n.removedCount += 1; // counted either way, so we can ask "להפסיק להכניס?" after repeated removals
  // "רק הפעם" means this shop only — it must not change how much we think the household uses.
  if (!temporary && n.removedCount >= 2 && n.qtySource !== 'user') {
    n.typical14DayQty = round1(Math.max(getConcept(needId).packSize * 0.25, n.typical14DayQty * 0.7));
    n.qtySource = 'learned';
  }
  store.saveNeed(n);
  logEvent({ type: 'removed_product', needId, value: { temporary, removedCount: n.removedCount } });
  return n;
}

export function learnFromReplacement(needId: string, fromName: string | undefined, toName: string, toBrand?: string, restoredUsual = false) {
  const n = ensureNeed(needId);
  if (toBrand && !n.preferredBrands.includes(toBrand)) n.preferredBrands = [toBrand, ...n.preferredBrands].slice(0, 3);
  n.lastProductName = toName;
  logEvent({ type: 'replaced_product', needId, fromProductId: fromName, toProductId: toName, value: { restoredUsual } });
  const events = store.events(needId).filter((e) => e.type === 'replaced_product');
  const restores = events.filter((e) => (e.value as { restoredUsual?: boolean } | undefined)?.restoredUsual).length;
  const swaps = events.length - restores;
  let inferred: string | undefined;
  // Keeps undoing our substitutions → they want that exact product.
  if (restores >= 2 && n.flexibility !== 'exact_product') {
    n.flexibility = 'exact_product';
    if (toBrand) n.preferredBrands = [toBrand];
    n.flexConfidence = 0.85;
    inferred = 'strict';
  }
  // Keeps switching between different products on their own → brand doesn't matter much.
  else if (swaps >= 3 && (n.flexibility === 'exact_product' || n.flexibility === 'brand_flexible') && n.flexConfidence < 0.9) {
    n.flexibility = 'category_flexible';
    n.dealSensitivity = 'high';
    n.flexConfidence = 0.7;
    inferred = 'flexible';
  }
  store.saveNeed(n);
  if (inferred) logEvent({ type: 'preference_statement', needId, value: { inferred, from: 'repeated_replacements' } });
  return { need: n, replacements: swaps, inferred };
}

export function learnFromQtyFeedback(needId: string, fb: 'too_much' | 'right' | 'ran_out') {
  const n = ensureNeed(needId);
  if (fb === 'too_much') n.typical14DayQty = round1(n.typical14DayQty * 0.8);
  if (fb === 'ran_out') n.typical14DayQty = round1(n.typical14DayQty * 1.25);
  if (fb !== 'right') n.qtySource = 'learned';
  store.saveNeed(n);
  logEvent({ type: 'quantity_feedback', needId, value: fb });
}

export function dealSensitivityFor(level: Level) {
  return level === 'high' ? 0.15 : level === 'medium' ? 0.22 : 0.35;
}

function hash(s: string) {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return h;
}

/** Days until the next shop based on last purchase. */
export function nextShopInDays(): number | null {
  const h = store.household();
  if (!h) return null;
  const last = store.purchases()[0];
  const from = last?.createdAt ?? h.onboardedAt;
  if (!from) return null;
  return Math.round(h.shopEveryDays - daysBetween(from));
}
