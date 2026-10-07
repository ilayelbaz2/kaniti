// Deterministic Hebrew understanding. Used when no LLM key is configured, as the LLM's fallback, and to validate
// LLM output. Instead of matching whole canned sentences, each clause is read as:
//   modifiers (this time / from now on / only if cheap / negation)  +  entities (product, brand, category, chain,
//   pronoun, unknown product)  +  intent cues (lexicons of verbs and question forms)  +  short conversation context.
// Unclear → one useful clarifying question (never a silent wrong action).
import type { Concept } from '../catalog.ts';
import { allConcepts } from '../state.ts';
import { ACTION_ORDER, type Action, type InsightQuestion, type StockLevel } from './actions.ts';
import type { ChatContext } from './context.ts';

// ---------- normalisation & numbers ----------

export function normalize(s: string) {
  return s
    .replace(/[֑-ׇ]/g, '')
    .replace(/[״”“"]/g, '"').replace(/[׳’`']/g, "'")
    .replace(/(?<=[א-ת])[-־](?=[א-ת\d])/g, ' ') // ל-3 → ל 3, ב-50% → ב 50%
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const NUM_WORDS: [RegExp, number][] = [
  [/קילו וחצי|ק"ג וחצי/, 1.5], [/חצי קילו|חצי ק"ג/, 0.5], [/(^|\s)חצי(\s|$)/, 0.5],
  [/(^|\s)(שתיים|שניים|שני|שתי|זוג)(\s|$)/, 2], [/(^|\s)(שלושה|שלוש)(\s|$)/, 3], [/(^|\s)(ארבעה|ארבע)(\s|$)/, 4],
  [/(^|\s)(חמישה|חמש)(\s|$)/, 5], [/(^|\s)(שישה|שש)(\s|$)/, 6], [/(^|\s)(שבעה|שבע)(\s|$)/, 7], [/(^|\s)שמונה(\s|$)/, 8],
  [/(^|\s)(תשעה|תשע)(\s|$)/, 9], [/(^|\s)(עשרה|עשר)(\s|$)/, 10], [/תריסר/, 12],
];
const ADD_VERB = /(^|\s)(ו?תוסיף|ו?תוסיפי|ו?הוסף|ו?להוסיף|ו?תכניס|ו?תכניסי|ו?להכניס|ו?קח|ו?תקח|ו?תקני|ו?תקנה|ו?תשים|ו?שים|ו?תביא|ו?תזמין|ו?צריך גם|ו?צריכים גם|ו?בא לי|ו?נוסיף|ו?תעשה גם)(\s|$)/;

export function findNumber(s: string): number | undefined {
  const m = s.match(/(\d+(?:\.\d+)?)/);
  if (m) return parseFloat(m[1]);
  for (const [re, v] of NUM_WORDS) if (re.test(s)) return v;
  // "אחד/אחת" is a quantity only right after an add verb ("קח אחד") — not in "אם יש אחד ממש משתל[םמ]".
  if (/(^|\s)(תוסיף|הוסף|קח|תקח|תכניס|שים|תשים|תביא)\s+(עוד\s+)?(אחד|אחת)(\s|$)/.test(s)) return 1;
  return undefined;
}

// ---------- entities ----------

type Mention = { concept: Concept; start: number; end: number; brand?: string };

/** Construct/definite forms people actually type: "גבינת שמנת" ~ "הגבינת שמנת" ~ "גבינת השמנת" ~ "הגבינה שמנת". */
function variants(syn: string): string[] {
  const out = new Set([syn]);
  const w = syn.split(' ');
  if (w.length >= 2) {
    const alt = (x: string) => (x.endsWith('ת') ? x.slice(0, -1) + 'ה' : x.endsWith('ה') ? x.slice(0, -1) + 'ת' : x);
    for (const first of [w[0], alt(w[0])]) {
      out.add([first, ...w.slice(1)].join(' '));
      out.add([first, 'ה' + w[1], ...w.slice(2)].join(' '));
    }
  }
  return [...out];
}

let synCache: { key: number; entries: { syn: string; concept: Concept }[] } | null = null;
function synonymIndex() {
  const concepts = allConcepts();
  if (synCache && synCache.key === concepts.length) return synCache.entries;
  const entries: { syn: string; concept: Concept }[] = [];
  for (const c of concepts) for (const s of [c.label, ...c.synonyms]) for (const v of variants(normalize(s))) entries.push({ syn: v, concept: c });
  entries.sort((a, b) => b.syn.length - a.syn.length);
  synCache = { key: concepts.length, entries };
  return entries;
}

/** Finds concept mentions, longest synonym first, without overlaps. Allows Hebrew prefixes and plural endings. */
export function findConcepts(text: string): Mention[] {
  const t = normalize(text);
  const taken: [number, number][] = [];
  const out: Mention[] = [];
  for (const { syn, concept } of synonymIndex()) {
    let from = 0;
    while (syn.length > 1) {
      const i = t.indexOf(syn, from);
      if (i < 0) break;
      from = i + 1;
      const end = i + syn.length;
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

/** Known brands mentioned without (or with) a product: "לא פפסי", "אנחנו אוהבים את בדין". */
function findBrands(t: string): { brand: string; needIds: string[]; at: number }[] {
  const map = new Map<string, Set<string>>();
  for (const c of allConcepts()) for (const b of c.brands) if (normalize(b).length >= 3) (map.get(b) ?? map.set(b, new Set()).get(b)!).add(c.id);
  const out: { brand: string; needIds: string[]; at: number }[] = [];
  for (const [b, ids] of map) {
    const i = t.search(new RegExp(`(^|\\s)[והבלמש]?${normalize(b).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$|[?.!,])`));
    if (i >= 0) out.push({ brand: b, needIds: [...ids], at: i });
  }
  return out;
}

const CATEGORY_WORDS: [RegExp, { category?: string; subGroup?: string; query: string; label: string }][] = [
  [/(^|\s)[הב]?(דג|דגים)(\s|$|[?.!,])/, { category: 'fish', query: 'פילה דג', label: 'דגים' }],
  [/(^|\s)[הב]?(עוף|עופות)(\s|$|[?.!,])/, { subGroup: 'chicken', query: 'עוף', label: 'עוף' }],
  [/(^|\s)[הב]?בשר(\s|$|[?.!,])/, { category: 'meat', query: 'בשר', label: 'בשר' }],
  [/(^|\s)[הב]?ירקות(\s|$|[?.!,])/, { category: 'produce', query: 'ירקות', label: 'ירקות' }],
];

const PROVIDER_NAMES: [RegExp, string][] = [
  [/שופרסל/, 'shufersal'], [/רמי ?לוי/, 'ramilevy'], [/ויקטורי/, 'victory'], [/יינות ביתן|ביתן/, 'ybitan'],
  [/קרפור|קארפור/, 'carrefour'], [/טיב טעם/, 'tivtaam'], [/קשת/, 'keshet'], [/קוויק/, 'quik'],
];
export const providerFromText = (t: string) => PROVIDER_NAMES.find(([re]) => re.test(t))?.[1];

const PRONOUN = /(^|\s)(זה|בזה|לזה|אותו|אותה|אותם|אותן|הזה|הזאת|הזו|האלה|ממנו|ממנה)(\s|$|[?.!,])/;

// ---------- modifiers & intent cues ----------

const TEMP = /(הפעם|השבוע|בקנייה הזאת|בקניה הזאת|בקנייה הזו|בסל הזה|בסל הזאת|רק עכשיו|לקנייה הזאת|בהזמנה הזאת|הקנייה הזאת)/;
const PERM = /(מעכשיו|מהיום|אף פעם|לעולם|כבר לא|בכלל לא|תפסיק|להבא|מעתה|תמיד)/;
// "אל תוסיף", "לא רוצה", "לא בא לי", "אין צורך ב", "לא את זה" — the add/want words are negated, so it's never an add.
const NEG_WANT = /((^|\s)(אל|לא) (ת)?(וסיף|וסיפי|הוסיף|כניס|כניסי|קח|קני|קנה|שים|ביא|זמין)(\s|$)|(^|\s)(אני |אנחנו )?לא (רוצה|רוצים|בא לי|מתחשק לי|צריך|צריכים)(\s|$)|אין צורך|(^|\s)לא (את )?(זה|הזה|הזאת)$)/;
const COND = /(^|\s)(רק )?(אם|בתנאי ש)[^]{0,25}?(מבצע|זול|משתל[םמ]|מחיר טוב|הנחה|שווה)/;

const RE = {
  insight: [
    [/(כמה|מה) (הוצאנו|הוצאתי|הוצאתם|יצא לנו|שילמנו|עלו לנו הקניות)|הוצאות (החודש|שלנו)|כמה כסף (הלך|הוצאנו)/, 'spend_month'],
    [/על מה (אנחנו )?(מוציאים|הולך|הוצאנו)|(איפה|על מה) הולך (לנו )?ה?כסף|הכי הרבה כסף/, 'top_category'],
    [/(כמה|מה) (חסכתי|חסכנו|חסכתם|נחסך)|חיסכון (שלנו|עם)|חסכנו בזכות/, 'savings'],
    [/מתי (כדאי|כדאי לנו|צריך|נכון) (לעשות|להזמין|לקנות)? ?(את )?(ה)?(קנייה|קניה|הזמנה|קניות)?|מתי הקנייה הבאה|מתי לקנות/, 'when_shop'],
    [/מה (נגמר|נגמרים|נגמרות|אוזל) (אצלנו )?(הכי )?מהר|מה הכי מהר נגמר/, 'fastest'],
    [/(קונים|קנינו) יותר מדי|מה מיותר|על מה אפשר לוותר/, 'overbuy'],
    [/(איזה|באיזה) יום[^]*?(זול|משתל[םמ])|יום (הכי )?זול/, 'cheap_day'],
    [/כמה זמן[^]*?(מחזיק|מחזיקה|מחזיקים|נגמר|מספיק)|לכמה זמן[^]*?(מספיק|מחזיק)/, 'lasts'],
  ] as [RegExp, InsightQuestion][],
  confirm: /^(קניתי|הזמנתי|קנינו|הזמנו)(\s|$|!|\.)|סיימתי (את )?ה?(קני|הזמנ)|(^|\s)(אשר|תאשר) (את )?ה?קנייה/,
  cart: /(תכין|תמלא|תבנה|תעביר|הכן|מלא|תסדר)[^]*?(עגלה|עגלת|לעגלה|את העגלה)|(עגלה|את העגלה) ב/,
  budget: /((אל|לא) (ת)?עבור|תקרה|תקציב|מקסימום|לא יותר מ|סל עד|קנייה עד|עד \d+ ?(ש"ח|שח|שקל|₪))/,
  rebuild: /(תבנה|בנה) (מחדש|שוב)|פשוט תבנה|דלג ובנה|תבנה כבר/,
  build: /(תבנה|בנה|תכין|תרכיב|לבנות|תעשה|נעשה|תתחיל|תארגן|תסדר)[^]*?(קני|סל|רשימ|הזמנ)|^(בנה|תבנה) קנייה|^כן,? תתחיל|^קנייה לשבו|^(יאללה|בוא|בואו) (נעשה |נזמין )?(קנייה|קניה|קניות|הזמנה)|^קנייה חדשה/,
  compareOne: /(כמה (זה )?(ייצא|יצא|יעלה|יעלו|עולה|תעלה)|מה (יהיה )?ה?(מחיר|סכום|סה"כ))[^]*?(אם (אני )?(קונה|נקנה|אקנה|מזמין|נזמין)|ב(שופרסל|רמי|ויקטורי|יינות|קרפור|טיב|קשת|קוויק)|ה?סל|ה?קנייה|ה?עגלה|הכל|הכול)/,
  compare: /(איפה|באיזו? |תשווה|השווה|השוואה|איזו רשת|מאיפה)[^]*?(משתל[םמ]|זול|להזמין|לקנות|רשת|רשתות|הסל)|^השווה רשתות|^איפה הכי זול\??$/,
  explain: /^(ו?למה|מדוע|איך החלטת|על סמך מה|מה הסיבה|למה דווקא)/,
  storeWord: /(רשת|חנות|סופר|סניף|דווקא ב)/,
  stockList: /(מה חסר|מה יש בבית|מה נשאר|מה כנראה חסר|מה המצב בבית|מה צריך לקנות|מה צריך להזמין)/,
  dealAlert: /(תמיד תראה לי|תגיד לי|תעדכן אותי) (אם|כש)[^]*?(זול|מבצע)/,
  flex: /(אל|לא) ת(י)?נעל|לא (חייב|חייבים|צריך|צריכים) (את ה|ב)?מותג|לא אכפת לי|לא משנה לי|לא חשוב לי|לא מעניין אותי איזה|מה ש(זול|במבצע|משתל[םמ])|כל מותג|לא משנה איזה|כל (\S+ )?(זה |יהיה )?בסדר|לא בררנים/,
  strictOnly: /(^|\s)(רק|אך ורק)(\s|$)(?!אם|(\d|שני|שתי|שלוש|ארבע))/,
  prefer: /(תמיד )?(תעדיף|מעדיפים|מעדיף|אנחנו אוהבים|אני אוהב|אני אוהבת|תקנה תמיד|הכי אוהבים)/,
  dislike: /(לא אוהב|לא אוהבת|לא אוהבים|לא טעים|לא טובה|לא טוב|מגעיל|לא מתאים לנו)/,
  never: /((אל|לא) ת(ציע|מליץ)(\s|$)|(אל|לא) ת(ציע|מליץ|כניס|קנה)[^]*?(יותר|אף פעם|לעולם|בכלל)|תפסיק (להציע|להכניס|לקנות|לשים)|אנחנו (כבר )?לא קונים|לא קונים (את זה )?בכלל|אף פעם (אל|לא)|לעולם (אל|לא)|(מעכשיו|מהיום|להבא) (בלי|אל|לא)|(^|\s)לא (לקנות|להכניס|להציע|לשים) (יותר(?! מ)|אף פעם|לעולם|בכלל))/,
  remove: /(עזוב|תעזוב|תוריד|הורד|להוריד|תוציא|הוצא|תמחק|מחק|תשאיר[^]*בחוץ|דלג על|תדלג על|לא צריך|לא צריכים|לא נצטרך|(אל|לא) (ת)?(קנה|תקנה|תכניס|נקנה|להכניס)|(^|\s)בלי |נוותר על|תוותר על|בלי ה)/,
  replace: /(תחליף|החלף|להחליף|משהו אחר|מוצר אחר|סוג אחר|מותג אחר|במקום|חלופה|תמורה|אחר במקום|תביא אחר|יש אחר|(תן|תביא|רוצה|בא לי)[^]*\sאחר(ת|ים)?(\s|$))/,
  promo: /(מבצע|במבצע|מבצעים|הנחה|הנחות|במחיר טוב|מחיר טוב|מחיר מעולה|דיל|סטוק|בכמות|להצטייד|לאגור|לעשות מלאי)/,
  stockUp: /(סטוק|בכמות|להצטייד|לאגור|לעשות מלאי|מלאי לבית)/,
  price: /(כמה (זה )?(עול|עולה|עולות|עולים)|מחיר|הכי זול|הכי משתל[םמ]|איפה (הכי )?(זול|משתל[םמ]|לקנות|יש)|תחפש|חפש|תמצא|תבדוק|בדוק|תראה (לי )?(מה|כמה|אם)|זול|זולה|זולות|זולים|משתל[םמ]|כמה יעלה)/,
  qtyTo: /(תעלה|תוריד|תשנה|שנה|תעשה|תשים|תגדיל|תקטין)[^]*?ל ?(\d+(?:\.\d+)?|שתיים|שניים|שלוש|שלושה|ארבע|ארבעה|חמש|חמישה|שש|שישה)/,
  qtyOnly: /(^|\s)רק (\d+(?:\.\d+)?|שתיים|שניים|שני|שתי|שלוש|שלושה|ארבע|ארבעה|חמש|חמישה)(\s|$)/,
  less: /(^|\s)(פחות|קצת פחות)(\s|$)/,
  more: /(^|\s)(עוד|קצת יותר|יותר)(\s|$)/,
  // Stock — negation first: "עוד לא נגמר", "לא חסר", "כמעט אין".
  stockSome: /(עוד לא נגמר|לא נגמר|לא נגמרה|לא נגמרו|לא חסר|לא חסרה|לא חסרים|יש מספיק|יש עדיין|עדיין יש|נשאר לנו)/,
  stockLittle: /(כמעט (אין|נגמר|נגמרה|נגמרו|כלום|ריק)|נשאר (מעט|קצת)|נשארה (מעט|קצת)|(^|\s)(קצת|מעט|טיפה)(\s|$))/,
  stockNone: /(^|\s)(אין|נגמר|נגמרה|נגמרו|לא נשאר|לא נשארו|אזל|אזלה|אזלו|סיימנו את|סיימנו)(\s|$)/,
  stockHave: /(^|\s)(יש|יש לנו|נשאר|נשארה|נשארו|עוד)(\s|$)/,
  lots: /(מלא|הרבה|המון|ערימה|מספיק|די הרבה|שפע|ים של)/,
  tempWant: /(הפעם|השבוע|בקנייה הזאת|בסל הזה)[^]*?(רוצה|רוצים|בא לי|צריך|צריכים|תכניס|תוסיף|תביא)|(רוצה|רוצים|בא לי) [^]*?(הפעם|השבוע)/,
  thisBrand: /(המותג הזה|המותג הזאת|את המותג|המוצר הזה|את זה)/,
};

const STOP = new Set(['לי', 'גם', 'את', 'בבקשה', 'עכשיו', 'שוב', 'איזה', 'איזו', 'משהו', 'קצת', 'עוד', 'כמה', 'של', 'על', 'יש', 'אם', 'רק', 'לנו', 'ל', 'מה', 'פה', 'לסל', 'לקנייה', 'לעגלה', 'ממש', 'אחד', 'אחת', 'זה', 'אותו', 'אותה', 'הזה', 'הזאת', 'בכמות', 'סטוק', 'אולי', 'פשוט', 'תודה', 'טוב', 'זול', 'זולה', 'משתל[םמ]', 'במבצע', 'מבצע', 'הכי', 'כן', 'לא', 'בכלל']);

/** Unknown product name(s) after a verb: "שים גם חרדל" → ["חרדל"], "תוסיף אבוקדו וגם חרדל" → ["אבוקדו","חרדל"]. */
function unknownLabels(t: string): string[] {
  const m = t.match(/(?:תוסיף|תוסיפי|הוסף|להוסיף|תכניס|תכניסי|שים|תשים|קח|תקח|תקנה|תביא|תזמין|תחפש|חפש|תמצא|תבדוק|בדוק|כמה עול(?:ה|ות|ים)|מחיר(?: של)?|מבצע על|יש מבצע על|יש|צריך גם|בא לי)\s+(.+)$/);
  if (!m) return [];
  const rest = m[1].replace(/\s(רק )?(אם|בתנאי)\s.*$/, '').replace(/[?.!]+$/, '');
  return rest.split(/\s+וגם\s+|,|\s+גם\s+/).map((part) => part.split(' ').filter((w) => w && !STOP.has(w) && !/^\d/.test(w)).join(' ').replace(/^(ה|את ה)(?=\S{3})/, '').trim())
    .filter((l) => l.length >= 2 && l.split(' ').length <= 3 && !PRONOUN.test(` ${l} `) && !/^(כמה|מה|איפה|למה)/.test(l) && !/(מבצע|סטוק|שווה|כדאי|הנחה|משתל[םמ]|זול|ששווה|לעשות)/.test(l));
}

// ---------- clauses ----------

function splitClauses(text: string): { t: string; q: boolean }[] {
  // A "?" ends a clause but is remembered: "יש לנו חלב?" asks, it doesn't report stock.
  const parts = normalize(text).replace(/\?+/g, '?\n')
    .split(/[!\n;]+|\.(?!\d)|\s+(?=ו(?:אין|יש|נגמר|תוסיף|תוריד|אל |רק |לא |קח|תבנה|למה|איפה|כמה|תחליף|עזוב)\S*)/)
    .map((s) => s.replace(/^ו(?=אין|יש|נגמר|תוסיף|תוריד|אל |רק |לא |קח|תבנה|למה|איפה|כמה|תחליף|עזוב)/, '').trim())
    .filter(Boolean);
  // A comma separates clauses only when the next piece has its own verb/stock word ("יש 10 ביצים, אין טונה").
  const out: string[] = [];
  for (const p of parts) for (const piece of p.split(/,\s*/)) {
    if (out.length && !/(^|\s)(אין|יש|נגמר|תוסיף|תוריד|אל|רק|לא|קח|תבנה|למה|איפה|כמה|תחליף|עזוב|שים|תשים)(\s|$)/.test(piece)) out[out.length - 1] += `, ${piece}`;
    else out.push(piece);
  }
  return out.map((c) => ({ t: c.replace(/\?+$/, '').trim(), q: /\?$/.test(c) })).filter((c) => c.t);
}

function horizonFrom(s: string): number {
  if (/שבועיים|14/.test(s)) return 14;
  if (/לשבוע|שבוע אחד|7 ימים/.test(s)) return 7;
  if (/חודש/.test(s)) return 30;
  const m = s.match(/(\d+)\s*ימים/);
  return m ? Math.min(30, Math.max(3, parseInt(m[1]))) : 14;
}

const asNum = (w: string) => findNumber(w) ?? parseFloat(w);

/** Parses one message into typed actions. `ctx` = what the conversation was just about (for "זה", "אותו", "תוסיף 2"). */
export function parseMessage(text: string, ctx: ChatContext | null = null): Action[] {
  const whole = normalize(text);
  const cmd = whole.match(/^#(\w+)\s*(.*)$/);
  if (cmd) return parseCommand(cmd[1], cmd[2]);

  const actions: Action[] = [];
  for (const { t, q } of splitClauses(text)) actions.push(...parseClause(t, ctx, q));
  if (!actions.length) {
    actions.push(whole.split(' ').length <= 2 && ctx?.focusNeedId
      ? { type: 'clarify', question: 'לא בטוח שהבנתי — מה לעשות?', options: focusOptions(ctx.focusNeedId) }
      : { type: 'help' });
  }
  return dedupe(actions).sort((a, b) => ACTION_ORDER.indexOf(a.type) - ACTION_ORDER.indexOf(b.type));
}

function focusOptions(needId: string): { label: string; send: string }[] {
  return [{ label: 'להוסיף לסל', send: `#add ${needId}` }, { label: 'לבדוק מחיר', send: `#price ${needId}` }, { label: 'להוריד מהסל', send: `#skip ${needId}` }];
}

function parseClause(t: string, ctx: ChatContext | null, question = false): Action[] {
  const out: Action[] = [];
  const neg = NEG_WANT.test(t);
  const mentions = findConcepts(t);
  const provider = providerFromText(t);
  const temp = TEMP.test(t), perm = PERM.test(t) && !temp, cond = COND.test(t);
  const pronoun = PRONOUN.test(t);
  const focus = ctx?.focusNeedId;
  const targets = mentions.length ? mentions.map((m) => m.concept.id) : pronoun && focus ? [focus] : [];
  const hasAdd = ADD_VERB.test(t) && !neg;

  // 1. Questions about the household's own history come first ("כמה חסכתי עם קניתי?" is not a purchase).
  for (const [re, q] of RE.insight) if (re.test(t)) return [{ type: 'askInsight', q, needId: q === 'lasts' || q === 'fastest' ? targets[0] : undefined }];
  if (RE.confirm.test(t) && !/(כמה|מה|למה|איפה)/.test(t)) return [{ type: 'confirmPurchase' }];
  if (RE.cart.test(t) && !mentions.length) return [{ type: 'prepareProviderCart', providerId: provider }];
  const n0 = findNumber(t);
  if (RE.budget.test(t) && n0 && n0 >= 50) return [{ type: 'setBudget', cap: n0 }];
  if (RE.rebuild.test(t)) return [{ type: 'generateBasket', horizonDays: horizonFrom(t), skipCheckin: true }];
  if (RE.build.test(t) && !mentions.length) return [{ type: 'generateBasket', horizonDays: horizonFrom(t) }];
  if (RE.compareOne.test(t) && (provider || !mentions.length)) return [{ type: 'compareProviders', providerId: provider }];

  // 2. Explanations — about a product (named or "this one"), or about the store choice.
  if (RE.explain.test(t)) {
    if (mentions.length) return [{ type: 'explainDecision', needId: mentions[0].concept.id, needIds: mentions.map((m) => m.concept.id) }];
    if (provider) return [{ type: 'explainDecision', about: 'store' }];
    if (pronoun && focus) return [{ type: 'explainDecision', needId: focus }];
    if (RE.storeWord.test(t)) return [{ type: 'explainDecision', about: 'store' }];
    if (focus) return [{ type: 'explainDecision', needId: focus }];
    return [{ type: 'explainDecision', about: ctx?.lastIntent === 'compare' ? 'store' : undefined }];
  }
  if (RE.stockList.test(t) && !mentions.length) return [{ type: 'showStock' }];
  if (!mentions.length && RE.compare.test(t)) return [{ type: 'compareProviders', providerId: provider }];

  // 3. Brands said on their own: "לא פפסי", "אנחנו אוהבים את בדין".
  const brands = findBrands(t);
  if (brands.length && !mentions.length) {
    const b = brands[0];
    const ids = focus && b.needIds.includes(focus) ? [focus] : b.needIds;
    const negative = new RegExp(`(לא|בלי|אל|לא אוהב|לא אוהבים|לא אוהבת)\\s+(את\\s+)?(ה)?[^\\s]*${normalize(b.brand).split(' ')[0]}`).test(t) || RE.dislike.test(t);
    if (ids.length > 1) {
      return [{ type: 'clarify', question: `${b.brand} — לאיזה מוצר הכוונה?`, options: ids.slice(0, 4).map((id) => ({ label: allConcepts().find((c) => c.id === id)!.label, send: `${negative ? 'לא' : 'תמיד'} ${b.brand} ב${allConcepts().find((c) => c.id === id)!.label}` })) }];
    }
    if (negative) return [{ type: 'updatePreference', needId: ids[0], forbiddenBrands: [b.brand], statement: t }];
    if (RE.prefer.test(t) || RE.strictOnly.test(t)) return [{ type: 'updatePreference', needId: ids[0], preferredBrands: [b.brand], flexibility: RE.strictOnly.test(t) ? 'exact_product' : 'brand_flexible', statement: t }];
  }

  // 4. No known product in the sentence.
  if (!targets.length) {
    if (RE.thisBrand.test(t) && (RE.never.test(t) || RE.dislike.test(t))) return [{ type: 'updatePreference', needId: 'FOCUS', dislikeCurrent: true, statement: t }];
    const cat = CATEGORY_WORDS.find(([re]) => re.test(t))?.[1];
    if (cat && (RE.price.test(t) || RE.promo.test(t) || question || /איזה/.test(t))) return [{ type: 'searchProductPrices', query: cat.query, category: cat.category, subGroup: cat.subGroup }];
    const labels = unknownLabels(t);
    if (labels.length && RE.promo.test(t) && !hasAdd) return [{ type: 'searchPromotions', query: labels[0] }];
    if (labels.length && RE.price.test(t) && !hasAdd) return [{ type: 'searchProductPrices', query: labels[0] }];
    if (labels.length && hasAdd) {
      const q = findNumber(t);
      return labels.map((l) => ({ type: 'addBasketItem', newLabel: l, quantity: labels.length === 1 ? q : undefined, conditional: cond ? 'good_price' : undefined }) as Action);
    }
    if (RE.promo.test(t) && !hasAdd) return [{ type: 'searchPromotions', stockUp: RE.stockUp.test(t) || undefined }];
    // Follow-ups about the product in focus: "תוסיף 2", "תחליף", "תוריד".
    if (focus) {
      const n = findNumber(t);
      if (RE.replace.test(t)) return [{ type: 'replaceBasketItem', needId: focus }];
      if (RE.remove.test(t) || neg) return [{ type: 'removeBasketItem', needId: focus, temporary: !perm }];
      if (hasAdd && n !== undefined) return [{ type: 'addBasketItem', needId: focus, quantity: n }];
      if (hasAdd && /אז|כן|יאללה|סבבה/.test(t)) return [{ type: 'addBasketItem', needId: focus }];
    }
    if (pronoun && (hasAdd || neg || RE.replace.test(t) || RE.remove.test(t))) return [{ type: 'clarify', question: 'על איזה מוצר מדובר?', options: [] }];
    if (labels.length && !RE.stockHave.test(t)) return [{ type: 'clarify', question: `לחפש "${labels[0]}" או להוסיף לסל?`, options: [{ label: 'לחפש', send: `תחפש ${labels[0]}` }, { label: 'להוסיף לסל', send: `תוסיף ${labels[0]}` }] }];
    return out;
  }

  // 5. Per product.
  for (const id of targets) {
    const m = mentions.find((x) => x.concept.id === id);
    const n = findNumber(m ? t.slice(0, m.start) + ' ' + t.slice(m.end) : t);
    if (RE.dealAlert.test(t)) { out.push({ type: 'updatePreference', needId: id, dealSensitivity: 'high', statement: t }); continue; }
    if (cond && hasAdd && !RE.remove.test(t)) { out.push({ type: 'addBasketItem', needId: id, quantity: n, conditional: 'good_price' }); continue; }
    if (!temp && (RE.never.test(t) || (perm && (RE.remove.test(t) || neg)))) { out.push({ type: 'updatePreference', needId: id, neverSuggest: true, active: false, statement: t }); continue; }
    if (RE.flex.test(t)) { out.push({ type: 'updatePreference', needId: id, flexibility: 'category_flexible', preferredBrands: [], dealSensitivity: 'high', statement: t }); continue; }
    if (RE.replace.test(t) && !RE.price.test(t.replace(/משהו אחר|מוצר אחר/, ''))) { out.push({ type: 'replaceBasketItem', needId: id }); continue; }
    if (RE.replace.test(t) && /(יש|תמצא|תביא)/.test(t)) { out.push({ type: 'replaceBasketItem', needId: id }); continue; }
    const qTo = t.match(RE.qtyTo);
    if (qTo && !RE.stockNone.test(t)) { out.push({ type: 'updateBasketQuantity', needId: id, quantity: asNum(qTo[2]) }); continue; }
    const qOnly = t.match(RE.qtyOnly);
    if (qOnly) { out.push({ type: 'updateBasketQuantity', needId: id, quantity: asNum(qOnly[2]) }); continue; }
    if ((RE.remove.test(t) || neg) && !RE.stockSome.test(t)) {
      out.push(temp ? { type: 'setTemporaryInstruction', needId: id, mode: 'skip' } : { type: 'removeBasketItem', needId: id, temporary: true });
      continue;
    }
    if (RE.strictOnly.test(t) && (m?.brand || /רק /.test(t)) && !hasAdd) {
      const c = m?.concept;
      const forbidden = c ? c.brands.filter((b) => b !== m?.brand && new RegExp(`(לא|בלי)\\s+(את\\s+)?(ה)?${normalize(b)}`).test(t)) : [];
      out.push({ type: 'updatePreference', needId: id, flexibility: 'exact_product', preferredBrands: m?.brand ? [m.brand] : undefined, forbiddenBrands: forbidden.length ? forbidden : undefined, active: true, statement: t });
      continue;
    }
    if (RE.dislike.test(t)) { out.push({ type: 'updatePreference', needId: id, dislikeCurrent: true, statement: t }); continue; }
    if (RE.prefer.test(t) && m?.brand) { out.push({ type: 'updatePreference', needId: id, preferredBrands: [m.brand], flexibility: 'brand_flexible', statement: t }); continue; }
    // Questions: deals vs prices ("פרגיות במבצע?", "תראה אם יש פרגיות במחיר טוב", "יש סלמון זול?").
    if (!hasAdd && /(מבצע|הנחה|מחיר טוב|במחיר טוב|סטוק|בכמות)/.test(t)) { out.push({ type: 'searchPromotions', needId: id, stockUp: RE.stockUp.test(t) || undefined }); continue; }
    if (!hasAdd && RE.price.test(t)) { out.push({ type: 'searchProductPrices', needId: id, query: m?.concept.query ?? '' }); continue; }
    if (hasAdd && RE.less.test(t)) { out.push({ type: 'updateBasketQuantity', needId: id, delta: -1 }); continue; }
    if (RE.less.test(t) && !RE.stockHave.test(t)) { out.push({ type: 'updateBasketQuantity', needId: id, delta: -1 }); continue; }
    if (RE.tempWant.test(t)) { out.push({ type: 'setTemporaryInstruction', needId: id, mode: 'include', quantity: n }); continue; }
    if (hasAdd) { out.push({ type: 'addBasketItem', needId: id, quantity: n }); continue; }
    // "יש לנו חלב?" / "חלב נגמר?" — a question about stock is answered, not recorded.
    if (question && (RE.stockSome.test(t) || RE.stockLittle.test(t) || RE.stockNone.test(t) || RE.stockHave.test(t))) { out.push({ type: 'showStock', needId: id }); continue; }
    // Stock statements (negation and hedging first).
    if (RE.stockSome.test(t)) { out.push({ type: 'updateHouseholdStock', needId: id, level: RE.lots.test(t) ? 'lots' : 'some', raw: t }); continue; }
    if (RE.stockLittle.test(t)) { out.push({ type: 'updateHouseholdStock', needId: id, level: 'little', raw: t }); continue; }
    if (RE.stockNone.test(t)) { out.push({ type: 'updateHouseholdStock', needId: id, level: 'none', raw: t }); continue; }
    if (RE.stockHave.test(t) || RE.lots.test(t)) {
      const level: StockLevel | undefined = n !== undefined ? undefined : RE.lots.test(t) ? 'lots' : 'some';
      out.push({ type: 'updateHouseholdStock', needId: id, qty: n !== undefined && m ? toStockUnits(m.concept, n, t) : undefined, level, raw: t });
      continue;
    }
    if (RE.build.test(t)) continue;
    // Bare product name: a question → price; otherwise most likely they want it.
    if (question || /^(ו)?(מה עם|ומה עם)/.test(t)) { out.push({ type: 'searchProductPrices', needId: id, query: m?.concept.query ?? '' }); continue; }
    if (targets.length === 1 && t.split(' ').length <= 4) { out.push({ type: 'addBasketItem', needId: id, quantity: n }); continue; }
    out.push({ type: 'clarify', question: `מה לעשות עם ${m?.concept.label ?? 'זה'}?`, options: focusOptions(id) });
  }
  if (RE.build.test(t)) out.push({ type: 'generateBasket', horizonDays: horizonFrom(t) });
  return out;
}

/** "2 תבניות ביצים" → 24 eggs; "8 קופסאות טונה" → 8. */
function toStockUnits(c: Concept, n: number, clause: string): number {
  if (c.packSize > 1 && /(תבני|מארז|שישי|רביעי|חבילות|חבילה|אריזות)/.test(clause) && n <= 6) return n * c.packSize;
  return n;
}

function parseCommand(name: string, rest: string): Action[] {
  const [a, b] = rest.split(/\s+/);
  switch (name) {
    case 'build': return [{ type: 'generateBasket', horizonDays: a ? parseInt(a) : 14, skipCheckin: b === 'force' }];
    case 'stock': return [{ type: 'updateHouseholdStock', needId: a, level: b as StockLevel }];
    case 'compare': return [{ type: 'compareProviders', providerId: a || undefined }];
    case 'deals': return [{ type: 'searchPromotions', stockUp: a === 'stock' || undefined }];
    case 'stocklist': return [{ type: 'showStock' }];
    case 'flex': return [{ type: 'updatePreference', needId: a, flexibility: b as never, statement: `#flex ${b}` }];
    case 'add': return [{ type: 'addBasketItem', needId: a, quantity: b ? parseFloat(b) : undefined }];
    case 'addlabel': return [{ type: 'addBasketItem', newLabel: rest.trim(), force: true }];
    case 'price': return [{ type: 'searchProductPrices', needId: a, query: '' }];
    case 'skip': return [{ type: 'removeBasketItem', needId: a, temporary: true }];
    case 'insight': return [{ type: 'askInsight', q: a as InsightQuestion, needId: b }];
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
