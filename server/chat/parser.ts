// Deterministic Hebrew intent parser. Used when no LLM key is configured, and as a fallback.
// Covers the V1 intents from the spec; anything it can't map falls through to 'help'.
import type { Concept } from '../catalog.ts';
import { allConcepts } from '../state.ts';
import { ACTION_ORDER, type Action, type StockLevel } from './actions.ts';

const NUM_WORDS: [RegExp, number][] = [
  [/חצי/, 0.5], [/(^|\s)(אחד|אחת)(\s|$)/, 1], [/שתיים|שניים|(^|\s)שני(\s|$)|(^|\s)שתי(\s|$)|זוג/, 2], [/שלושה|שלוש/, 3], [/ארבעה|ארבע/, 4],
  [/חמישה|חמש/, 5], [/שישה|(^|\s)שש(\s|$)/, 6], [/שבעה|(^|\s)שבע(\s|$)/, 7], [/שמונה/, 8], [/תשעה|תשע/, 9], [/עשרה|(^|\s)עשר(\s|$)/, 10], [/תריסר/, 12],
];

export function normalize(s: string) {
  return s
    .replace(/[֑-ׇ]/g, '')
    .replace(/[״”“"]/g, '"').replace(/[׳’`']/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function findNumber(s: string): number | undefined {
  const m = s.match(/(\d+(?:\.\d+)?)/);
  if (m) return parseFloat(m[1]);
  for (const [re, v] of NUM_WORDS) if (re.test(s)) return v;
  return undefined;
}

type Mention = { concept: Concept; start: number; end: number; brand?: string };

/** Finds concept mentions, longest synonym first, without overlaps. */
export function findConcepts(text: string): Mention[] {
  const t = normalize(text);
  const entries: { syn: string; concept: Concept }[] = [];
  for (const c of allConcepts()) for (const syn of [c.label, ...c.synonyms]) entries.push({ syn: normalize(syn), concept: c });
  entries.sort((a, b) => b.syn.length - a.syn.length);
  const taken: [number, number][] = [];
  const out: Mention[] = [];
  for (const { syn, concept } of entries) {
    let from = 0;
    while (syn.length > 1) {
      const i = t.indexOf(syn, from);
      if (i < 0) break;
      from = i + 1;
      const end = i + syn.length;
      // Word-ish boundary: allow Hebrew prefixes (ו/ה/ב/ל/מ/ש/כ) before, and nothing alphabetic after except plural/possessive endings.
      const before = t.slice(Math.max(0, i - 3), i);
      const after = t[end] ?? ' ';
      if (i > 0 && !(syn.length > 2 ? /(^|\s)[והבלמשכ]{0,2}$/ : /(^|\s)[וה]?$/).test(before)) continue;
      if (/[א-תa-z]/.test(after) && !/^(ים|ות|ה|י|ת)(\s|$|[.,!?])/.test(t.slice(end, end + 4))) continue;
      if (taken.some(([a, b]) => i < b && end > a)) continue;
      taken.push([i, end]);
      if (!out.some((m) => m.concept.id === concept.id)) out.push({ concept, start: i, end });
    }
  }
  for (const m of out) {
    const brand = m.concept.brands.find((b) => t.includes(normalize(b)));
    if (brand) m.brand = brand;
  }
  return out.sort((a, b) => a.start - b.start);
}

function splitClauses(text: string): string[] {
  return normalize(text)
    .split(/[.!?\n;,]+|\s+(?=ו(?:אין|יש|נגמר|תוסיף|תוריד|אל |רק |לא |קח|תבנה|למה|איפה)\S*)/)
    .map((s) => s.replace(/^ו(?=אין|יש|נגמר|תוסיף|תוריד|אל |רק |לא |קח|תבנה|למה|איפה)/, '').trim())
    .filter(Boolean);
}

function horizonFrom(s: string): number {
  if (/שבועיים|14/.test(s)) return 14;
  if (/לשבוע|שבוע אחד|7 ימים/.test(s)) return 7;
  if (/חודש/.test(s)) return 30;
  const m = s.match(/(\d+)\s*ימים/);
  return m ? Math.min(30, Math.max(3, parseInt(m[1]))) : 14;
}

const RE = {
  build: /(תבנה|בנה|תכין|תרכיב|לבנות|תעשה|תתחיל|תארגן)[^]*?(קני|סל|רשימ|הזמנ)|^(בנה|תבנה) קנייה|^כן,? תתחיל|^קנייה לשבו/,
  rebuild: /(תבנה|בנה) (מחדש|שוב)|פשוט תבנה|דלג ובנה|תבנה כבר/,
  compare: /(איפה|באיזו? |תשווה|השווה|השוואה|איזו רשת|מאיפה)[^]*?(משתלם|זול|להזמין|לקנות|רשת|רשתות|הסל)|^השווה רשתות|^איפה הכי זול\??$/,
  price: /(איפה|כמה עול|מחיר|הכי זול|כמה זה|כמה יעלה)/,
  promo: /(יש מבצע|מבצעים|יש הנחה|מבצע על)/,
  explain: /^(למה|מדוע|איך החלטת|למה שמת|למה הכנסת|למה בחרת)/,
  store: /(רשת|חנות|סופר|סניף)/,
  budget: /((אל|לא) (ת)?עבור|תקרה|תקציב|מקסימום|לא יותר מ)/,
  confirm: /(קניתי|הזמנתי|קנינו|הזמנו|סיימתי (את )?ה?קני|אשר קנייה|תאשר קנייה)/,
  neverSuggest: /(אל|לא) ת(ציע|מליץ)|תפסיק להציע|אנחנו לא קונים|לא קונים בכלל|אף פעם לא|לעולם לא|אל תקנה[^]*?(יותר|אף פעם|לעולם)/,
  dontCare: /לא אכפת לי|לא משנה לי|לא חשוב לי|לא מעניין אותי איזה|מה שזול|מה שבמבצע|מה שמשתלם|כל מותג|לא משנה איזה/,
  strict: /(^|\s)(רק|אך ורק|אך ורק את)(\s|$)/,
  prefer: /(תמיד )?(תעדיף|מעדיפים|אנחנו אוהבים|אני אוהב|אני אוהבת|תקנה תמיד)/,
  dislike: /(לא אוהב|לא אוהבת|לא אוהבים|לא טעים|לא טובה|לא טוב|מגעיל)/,
  dealAlert: /(תמיד תראה לי|תגיד לי) אם (זול|יש מבצע)/,
  skipTemp: /((אל|לא) ת?(קנה|תקנה|תכניס|צריך|נצטרך)|בלי |תוריד|תוציא|תמחק|לא צריך|לא צריכים|לא הפעם|דלג על)/,
  none: /(^|\s)(אין|נגמר|נגמרה|נגמרו|לא נשאר|לא נשארו|אזל|אזלה|אזלו|סיימנו את)/,
  have: /(^|\s)(יש|נשאר|נשארה|נשארו|עוד|יש לנו|יש עדיין)(\s|$)/,
  lots: /(מלא|הרבה|המון|ערימה|מספיק|די הרבה|שפע)/,
  little: /(קצת|מעט|טיפה|כמעט נגמר|כמעט כלום|פחות)/,
  add: /(תוסיף|תוסיפי|תכניס|הוסף|להוסיף|קח|תקח|תקנה|צריך גם|צריכים גם|בא לי|תשים|שים|תביא|לקנות)/,
  conditional: /אם (יש )?(מבצע|מחיר טוב|המחיר טוב|ה?מחיר משתלם|זול|משתלם|יש מחיר טוב)/,
  qty: /(תשים|תעשה|שנה ל|תשנה ל|תוריד ל|תעלה ל|במקום)\s*(\d+)/,
  replace: /(תחליף|החלף|מוצר אחר|משהו אחר במקום)/,
  stockList: /(מה חסר|מה יש בבית|מה נשאר|מה כנראה חסר|מה המצב בבית)/,
};

export function parseMessage(text: string): Action[] {
  const actions: Action[] = [];
  const whole = normalize(text);

  // Structured quick-reply payloads from UI cards: "#stock NEED level" / "#build"
  const cmd = whole.match(/^#(\w+)\s*(.*)$/);
  if (cmd) return parseCommand(cmd[1], cmd[2]);

  for (const clause of splitClauses(text)) {
    const mentions = findConcepts(clause);
    const first = mentions[0];
    const n = findNumber(clause.replace(first ? normalize(first.concept.label) : '', ''));

    if (RE.confirm.test(clause)) { actions.push({ type: 'confirmPurchase' }); continue; }
    if (RE.rebuild.test(clause)) { actions.push({ type: 'generateBasket', horizonDays: horizonFrom(clause), skipCheckin: true }); continue; }
    if (RE.build.test(clause) && !mentions.length) { actions.push({ type: 'generateBasket', horizonDays: horizonFrom(clause) }); continue; }
    if (RE.budget.test(clause) && n && n >= 50) { actions.push({ type: 'setBudget', cap: n }); continue; }
    if (RE.explain.test(clause)) {
      actions.push(first ? { type: 'explainBasketDecision', needId: first.concept.id } : { type: 'explainBasketDecision', about: RE.store.test(clause) ? 'store' : undefined });
      continue;
    }
    if (RE.stockList.test(clause)) { actions.push({ type: 'showStock' }); continue; }
    if (!first && RE.compare.test(clause)) { actions.push({ type: 'quoteBasketAcrossProviders' }); continue; }
    if (!first && RE.promo.test(clause)) { actions.push({ type: 'searchPromotions' }); continue; }
    if (RE.dealAlert.test(clause) && first) {
      actions.push({ type: 'updatePreference', needId: first.concept.id, dealSensitivity: 'high', statement: clause });
      continue;
    }

    if (!first) {
      // Unknown product with an add verb: "תוסיף אבוקדו"
      const m = clause.match(new RegExp(RE.add.source + '\\s+(?:גם\\s+)?(?:את\\s+)?(?:ה)?([א-ת][א-ת\\s]{1,20}?)(?:\\s+אם|$)'));
      if (m && m[2]) {
        actions.push({ type: 'addBasketItem', newLabel: m[2].trim(), quantity: findNumber(clause), conditional: RE.conditional.test(clause) ? 'good_price' : undefined });
        continue;
      }
      if (RE.build.test(clause)) { actions.push({ type: 'generateBasket', horizonDays: horizonFrom(clause) }); continue; }
      continue;
    }

    for (const m of mentions) {
      const id = m.concept.id;
      if (RE.skipTemp.test(clause) && !RE.neverSuggest.test(clause)) { actions.push({ type: 'removeBasketItem', needId: id, temporary: true }); continue; }
      if (RE.add.test(clause) && RE.conditional.test(clause)) { actions.push({ type: 'addBasketItem', needId: id, quantity: n, conditional: 'good_price' }); continue; }
      if (RE.promo.test(clause)) { actions.push({ type: 'searchPromotions', needId: id }); continue; }
      if (RE.price.test(clause) && !RE.add.test(clause)) { actions.push({ type: 'searchProductPrices', needId: id, query: m.concept.query }); continue; }
      if (RE.neverSuggest.test(clause)) { actions.push({ type: 'updatePreference', needId: id, neverSuggest: true, active: false, statement: clause }); continue; }
      if (RE.dontCare.test(clause)) { actions.push({ type: 'updatePreference', needId: id, flexibility: 'category_flexible', preferredBrands: [], dealSensitivity: 'high', statement: clause }); continue; }
      if (RE.strict.test(clause)) {
        const forbidden = m.concept.brands.filter((b) => b !== m.brand && new RegExp(`(לא|בלי)\\s+(את\\s+)?(ה)?${normalize(b)}`).test(clause));
        actions.push({ type: 'updatePreference', needId: id, flexibility: 'exact_product', preferredBrands: m.brand ? [m.brand] : undefined, forbiddenBrands: forbidden.length ? forbidden : undefined, active: true, statement: clause });
        continue;
      }
      if (RE.dislike.test(clause)) { actions.push({ type: 'updatePreference', needId: id, dislikeCurrent: true, statement: clause }); continue; }
      if (RE.prefer.test(clause) && m.brand) { actions.push({ type: 'updatePreference', needId: id, preferredBrands: [m.brand], flexibility: 'brand_flexible', statement: clause }); continue; }
      if (RE.replace.test(clause)) { actions.push({ type: 'replaceBasketItem', needId: id }); continue; }
      if (RE.none.test(clause)) { actions.push({ type: 'updateHouseholdStock', needId: id, level: 'none', raw: clause }); continue; }
      const qm = clause.match(RE.qty);
      if (qm) { actions.push({ type: 'updateBasketQuantity', needId: id, quantity: parseFloat(qm[2]) }); continue; }
      if (RE.add.test(clause) || RE.conditional.test(clause)) {
        actions.push({ type: 'addBasketItem', needId: id, quantity: n, conditional: RE.conditional.test(clause) ? 'good_price' : undefined });
        continue;
      }
      if (RE.have.test(clause) || RE.lots.test(clause) || RE.little.test(clause)) {
        const level: StockLevel | undefined = n !== undefined ? undefined : RE.little.test(clause) ? 'little' : RE.lots.test(clause) ? 'lots' : 'some';
        const qty = n !== undefined ? toStockUnits(m.concept, n, clause) : undefined;
        actions.push({ type: 'updateHouseholdStock', needId: id, qty, level, raw: clause });
        continue;
      }
      if (RE.build.test(clause)) continue;
      // Bare product name ("טונה") — most likely they want it.
      if (mentions.length === 1 && clause.split(' ').length <= 3) actions.push({ type: 'addBasketItem', needId: id, quantity: n });
    }
    if (RE.build.test(clause)) actions.push({ type: 'generateBasket', horizonDays: horizonFrom(clause) });
  }

  if (!actions.length) actions.push({ type: 'help' });
  return dedupe(actions).sort((a, b) => ACTION_ORDER.indexOf(a.type) - ACTION_ORDER.indexOf(b.type));
}

/** "2 תבניות ביצים" → 24 eggs; "8 קופסאות טונה" → 8. */
function toStockUnits(c: Concept, n: number, clause: string): number {
  if (c.packSize > 1 && /(תבני|מארז|שישי|רביעי|חבילות|חבילה|אריזות)/.test(clause) && n <= 6) return n * c.packSize;
  if (/(ק"ג|קילו|קג)/.test(clause) || c.stockUnit === 'ק״ג') return n;
  return n;
}

function parseCommand(name: string, rest: string): Action[] {
  const [a, b] = rest.split(/\s+/);
  switch (name) {
    case 'build': return [{ type: 'generateBasket', horizonDays: a ? parseInt(a) : 14, skipCheckin: b === 'force' }];
    case 'stock': return [{ type: 'updateHouseholdStock', needId: a, level: b as StockLevel }];
    case 'compare': return [{ type: 'quoteBasketAcrossProviders' }];
    case 'deals': return [{ type: 'searchPromotions' }];
    case 'stocklist': return [{ type: 'showStock' }];
    case 'flex': return [{ type: 'updatePreference', needId: a, flexibility: b as never, statement: `#flex ${b}` }];
    default: return [{ type: 'help' }];
  }
}

function dedupe(actions: Action[]): Action[] {
  const seen = new Set<string>();
  return actions.filter((a) => {
    const k = JSON.stringify(a);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
