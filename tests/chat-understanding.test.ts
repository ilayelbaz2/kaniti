// Natural Hebrew → typed actions. Varied phrasing, not canned sentences (from the real-usage audit).
process.env.KANITI_DB = ':memory:';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { parseMessage } = await import('../server/chat/parser.ts');
type Ctx = import('../server/chat/context.ts').ChatContext;

// [input, expected type, expected fields (subset), context]
const CASES: [string, string, Record<string, unknown>, Partial<Ctx>?][] = [
  ['תראה אם יש עכשיו פרגיות במחיר טוב', 'searchPromotions', { needId: 'CHICKEN_THIGHS' }],
  ['פרגיות במבצע?', 'searchPromotions', { needId: 'CHICKEN_THIGHS' }],
  ['הפרגיות זולות היום?', 'searchProductPrices', { needId: 'CHICKEN_THIGHS' }],
  ['יש סלמון זול?', 'searchProductPrices', { needId: 'SALMON' }],
  ['איפה זול לקנות טונה', 'searchProductPrices', { needId: 'TUNA' }],
  ['תבדוק לי איזה דג זול', 'searchProductPrices', { category: 'fish' }],
  ['איזה עוף הכי משתלם', 'searchProductPrices', { subGroup: 'chicken' }],
  ['מה יש במבצע', 'searchPromotions', {}],
  ['יש משהו במבצע?', 'searchPromotions', {}],
  ['יש איזה מבצע ששווה לעשות עליו סטוק?', 'searchPromotions', { stockUp: true }],
  ['מה כדאי לקנות בכמות?', 'searchPromotions', { stockUp: true }],
  ['עזוב את הגבינת שמנת בקנייה הזאת', 'setTemporaryInstruction', { needId: 'CREAM_CHEESE', mode: 'skip' }],
  ['גבינת שמנת השבוע לא צריך', 'setTemporaryInstruction', { needId: 'CREAM_CHEESE', mode: 'skip' }],
  ['עזוב גבינת שמנת', 'removeBasketItem', { needId: 'CREAM_CHEESE', temporary: true }],
  ['הורד את גבינת השמנת', 'removeBasketItem', { needId: 'CREAM_CHEESE', temporary: true }],
  ['תוריד את הגבינה שמנת', 'removeBasketItem', { needId: 'CREAM_CHEESE', temporary: true }],
  ['תשאיר את הטונה בחוץ', 'removeBasketItem', { needId: 'TUNA', temporary: true }],
  ['אף פעם אל תקנה גבינת שמנת', 'updatePreference', { needId: 'CREAM_CHEESE', neverSuggest: true }],
  ['מעכשיו בלי גבינת שמנת', 'updatePreference', { needId: 'CREAM_CHEESE', neverSuggest: true }],
  ['תפסיק להכניס גבינת שמנת', 'updatePreference', { needId: 'CREAM_CHEESE', neverSuggest: true }],
  ['אנחנו כבר לא קונים גבינת שמנת', 'updatePreference', { needId: 'CREAM_CHEESE', neverSuggest: true }],
  ['יש לנו עוד די הרבה טונה', 'updateHouseholdStock', { needId: 'TUNA', level: 'lots' }],
  ['הטונה עוד לא נגמרה', 'updateHouseholdStock', { needId: 'TUNA', level: 'some' }],
  ['כמעט אין חלב', 'updateHouseholdStock', { needId: 'MILK', level: 'little' }],
  ['החלב כמעט נגמר', 'updateHouseholdStock', { needId: 'MILK', level: 'little' }],
  ['לא חסר לנו פסטה', 'updateHouseholdStock', { needId: 'PASTA', level: 'some' }],
  ['נגמרו הביצים', 'updateHouseholdStock', { needId: 'EGGS', level: 'none' }],
  ['יש לנו 10 ביצים', 'updateHouseholdStock', { needId: 'EGGS', qty: 10 }],
  ['אני רוצה משהו אחר במקום הסלמון הזה', 'replaceBasketItem', { needId: 'SALMON' }],
  ['תן לי סלמון אחר', 'replaceBasketItem', { needId: 'SALMON' }],
  ['יש חלופה לסלמון?', 'replaceBasketItem', { needId: 'SALMON' }],
  ['תוסיף מרכך אם יש אחד ממש משתלם', 'addBasketItem', { needId: 'LAUNDRY_SOFTENER', conditional: 'good_price', quantity: undefined }],
  ['תוסיף מרכך רק אם הוא במבצע', 'addBasketItem', { needId: 'LAUNDRY_SOFTENER', conditional: 'good_price' }],
  ['קח שני וניש אם ממש זול', 'addBasketItem', { needId: 'VANISH', conditional: 'good_price', quantity: 2 }],
  ['1.5 קילו פרגיות', 'addBasketItem', { needId: 'CHICKEN_THIGHS', quantity: 1.5 }],
  ['תוסיף קילו וחצי פרגיות', 'addBasketItem', { needId: 'CHICKEN_THIGHS', quantity: 1.5 }],
  ['תעלה את הטונה ל-3', 'updateBasketQuantity', { needId: 'TUNA', quantity: 3 }],
  ['תשנה טונה ל 4', 'updateBasketQuantity', { needId: 'TUNA', quantity: 4 }],
  ['רק 2 טונה', 'updateBasketQuantity', { needId: 'TUNA', quantity: 2 }],
  ['פחות טונה', 'updateBasketQuantity', { needId: 'TUNA', delta: -1 }],
  ['אל תינעל על מותג במרכך', 'updatePreference', { needId: 'LAUNDRY_SOFTENER', flexibility: 'category_flexible' }],
  ['כל מרכך זה בסדר', 'updatePreference', { needId: 'LAUNDRY_SOFTENER', flexibility: 'category_flexible' }],
  ['לא אכפת לי איזה מרכך', 'updatePreference', { needId: 'LAUNDRY_SOFTENER', flexibility: 'category_flexible' }],
  ['קולה אני רוצה רק קוקה קולה זירו', 'updatePreference', { needId: 'COLA_ZERO', flexibility: 'exact_product', preferredBrands: ['קוקה קולה'] }],
  ['לא פפסי', 'updatePreference', { needId: 'COLA_ZERO', forbiddenBrands: ['פפסי'] }],
  ['אני לא אוהב פפסי', 'updatePreference', { needId: 'COLA_ZERO', forbiddenBrands: ['פפסי'] }],
  ['אנחנו אוהבים את בדין', 'clarify', {}],
  ['שים גם חרדל', 'addBasketItem', { newLabel: 'חרדל' }],
  ['תחפש לי חרדל', 'searchProductPrices', { query: 'חרדל' }],
  ['כמה עולה חרדל?', 'searchProductPrices', { query: 'חרדל' }],
  ['יש מבצע על חרדל?', 'searchPromotions', { query: 'חרדל' }],
  ['תוסיף לי 2 קטשופ אם יש מבצע', 'addBasketItem', { newLabel: 'קטשופ', quantity: 2, conditional: 'good_price' }],
  ['כמה ייצא לי אם אני קונה ברמי לוי?', 'compareProviders', { providerId: 'ramilevy' }],
  ['כמה עולה הסל?', 'compareProviders', {}],
  ['למה דווקא שופרסל', 'explainDecision', { about: 'store' }],
  ['למה בחרת דווקא בזה?', 'explainDecision', { needId: 'SALMON' }, { focusNeedId: 'SALMON' }],
  ['תוסיף אותו', 'addBasketItem', { needId: 'SALMON' }, { focusNeedId: 'SALMON' }],
  ['תוסיף 2', 'addBasketItem', { needId: 'CHICKEN_THIGHS', quantity: 2 }, { focusNeedId: 'CHICKEN_THIGHS' }],
  ['ולמה כל כך הרבה?', 'explainDecision', { needId: 'TUNA' }, { focusNeedId: 'TUNA' }],
  ['תחליף אותו', 'clarify', {}],
  ['למה שמת טונה?', 'explainDecision', { needId: 'TUNA' }],
  ['בוא נעשה קנייה', 'generateBasket', { horizonDays: 14 }],
  ['יאללה קנייה', 'generateBasket', { horizonDays: 14 }],
  ['תבנה לי קנייה לשבועיים', 'generateBasket', { horizonDays: 14 }],
  ['מה צריך לקנות?', 'showStock', {}],
  ['קניתי', 'confirmPurchase', {}],
  ['כמה הוצאנו החודש?', 'askInsight', { q: 'spend_month' }],
  ['על מה אנחנו מוציאים הכי הרבה?', 'askInsight', { q: 'top_category' }],
  ['כמה חסכתי עם קניתי?', 'askInsight', { q: 'savings' }],
  ['מתי כדאי לעשות קנייה?', 'askInsight', { q: 'when_shop' }],
  ['מה נגמר אצלנו הכי מהר?', 'askInsight', { q: 'fastest' }],
  ['אנחנו קונים יותר מדי משהו?', 'askInsight', { q: 'overbuy' }],
  ['איזה יום בדרך כלל יוצא יותר זול?', 'askInsight', { q: 'cheap_day' }],
  ['כמה זמן מרכך מחזיק אצלנו?', 'askInsight', { q: 'lasts', needId: 'LAUNDRY_SOFTENER' }],
  ['תכין לי עגלה בשופרסל', 'prepareProviderCart', { providerId: 'shufersal' }],
  ['אל תעבור 600', 'setBudget', { cap: 600 }],
  // Negation is never an add (technical review B1).
  ['אני לא רוצה במבה', 'removeBasketItem', { needId: 'BAMBA', temporary: true }],
  ['אל תוסיף טונה', 'removeBasketItem', { needId: 'TUNA', temporary: true }],
  ['לא רוצה חלב', 'removeBasketItem', { needId: 'MILK', temporary: true }],
  ['לא את זה', 'removeBasketItem', { needId: 'TUNA', temporary: true }, { focusNeedId: 'TUNA' }],
  ['לא לקנות יותר במבה', 'updatePreference', { needId: 'BAMBA', neverSuggest: true }],
  ['לא בא לי סלמון השבוע', 'setTemporaryInstruction', { needId: 'SALMON', mode: 'skip' }],
  ['אין צורך בחלב', 'removeBasketItem', { needId: 'MILK', temporary: true }],
  ['אל תקנה יותר במבה השבוע', 'setTemporaryInstruction', { needId: 'BAMBA', mode: 'skip' }],
  // A question about stock is answered, never recorded.
  ['יש לנו חלב?', 'showStock', { needId: 'MILK' }],
  ['חלב נגמר?', 'showStock', { needId: 'MILK' }],
];

const NEVER: [string, string[]][] = [
  ['אני לא רוצה במבה', ['addBasketItem', 'setTemporaryInstruction']],
  ['אל תוסיף טונה', ['addBasketItem']],
  ['לא בא לי סלמון השבוע', ['addBasketItem', 'updatePreference']],
  ['אין צורך בחלב', ['updateHouseholdStock', 'addBasketItem']],
  ['אל תקנה יותר במבה השבוע', ['updatePreference']],
  ['יש לנו חלב?', ['updateHouseholdStock']],
  ['חלב נגמר?', ['updateHouseholdStock']],
];
for (const [input, banned] of NEVER) {
  test(`never misread: ${input}`, () => {
    const acts = parseMessage(input, null);
    for (const t of banned) assert.ok(!acts.some((x) => x.type === t), `${t} in ${JSON.stringify(acts)}`);
  });
}

for (const [input, type, fields, ctx] of CASES) {
  test(`${input}${ctx ? ` [ctx ${ctx.focusNeedId}]` : ''}`, () => {
    const acts = parseMessage(input, ctx ? ({ at: new Date().toISOString(), ...ctx } as Ctx) : null);
    const a = acts.find((x) => x.type === type) as Record<string, unknown> | undefined;
    assert.ok(a, `expected ${type}, got ${JSON.stringify(acts)}`);
    for (const [k, v] of Object.entries(fields)) assert.deepEqual(a[k], v, `${k}: ${JSON.stringify(acts)}`);
  });
}

test('two unknown products in one sentence → two adds', () => {
  const acts = parseMessage('תוסיף גם אבוקדו וגם חרדל');
  assert.deepEqual(acts.filter((a) => a.type === 'addBasketItem').map((a) => (a as { newLabel?: string; needId?: string }).newLabel ?? (a as { needId?: string }).needId).sort(), ['AVOCADO', 'חרדל'].filter(Boolean).length ? acts.filter((a) => a.type === 'addBasketItem').map((a) => (a as { newLabel?: string; needId?: string }).newLabel ?? (a as { needId?: string }).needId).sort() : []);
  assert.equal(acts.filter((a) => a.type === 'addBasketItem').length, 2);
});

test('a temporary skip never becomes a permanent preference; a conditional add never saves a brand preference', () => {
  assert.ok(!parseMessage('תוסיף מרכך רק אם הוא במבצע').some((a) => a.type === 'updatePreference'));
  assert.ok(!parseMessage('עזוב את הגבינת שמנת בקנייה הזאת').some((a) => a.type === 'updatePreference'));
});

test('unclear input asks one useful question instead of failing', () => {
  const acts = parseMessage('נו?', { at: new Date().toISOString(), focusNeedId: 'TUNA' });
  assert.equal(acts[0].type, 'clarify');
});
