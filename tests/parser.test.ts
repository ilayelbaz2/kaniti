process.env.KANITI_DB = ':memory:';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { parseMessage } = await import('../server/chat/parser.ts');

const cases: [string, (a: any[]) => boolean][] = [
  ['יש לנו 10 ביצים', (a) => a[0].type === 'updateHouseholdStock' && a[0].needId === 'EGGS' && a[0].qty === 10],
  ['לא אכפת לי איזה מרכך', (a) => a[0].type === 'updatePreference' && a[0].needId === 'LAUNDRY_SOFTENER' && a[0].flexibility === 'category_flexible'],
  ['רק קוקה קולה זירו', (a) => a[0].type === 'updatePreference' && a[0].needId === 'COLA_ZERO' && a[0].flexibility === 'exact_product' && a[0].preferredBrands[0] === 'קוקה קולה'],
  ['רק קוקה קולה זירו, לא פפסי', (a) => a[0].needId === 'COLA_ZERO' && a[0].flexibility === 'exact_product'],
  ['תבנה לי קנייה לשבועיים', (a) => a[0].type === 'generateBasket' && a[0].horizonDays === 14],
  ['תבנה לי קנייה לשבועיים. יש עדיין הרבה פסטה ואין טונה.', (a) => a.length === 3 && a[0].needId === 'PASTA' && a[0].level === 'lots' && a[1].needId === 'TUNA' && a[1].level === 'none' && a[2].type === 'generateBasket'],
  ['תוסיף גם פרגיות אם המחיר טוב', (a) => a[0].type === 'addBasketItem' && a[0].needId === 'CHICKEN_THIGHS' && a[0].conditional === 'good_price'],
  ['יש מלא פסטה', (a) => a[0].type === 'updateHouseholdStock' && a[0].level === 'lots'],
  ['אל תקנה גבינת שמנת הפעם', (a) => a[0].type === 'removeBasketItem' && a[0].needId === 'CREAM_CHEESE' && a[0].temporary],
  ['תוריד גבינת שמנת', (a) => a[0].type === 'removeBasketItem' && a[0].needId === 'CREAM_CHEESE'],
  ['למה הכנסת 12 טונה?', (a) => a[0].type === 'explainBasketDecision' && a[0].needId === 'TUNA'],
  ['למה בחרת ברשת הזאת?', (a) => a[0].type === 'explainBasketDecision' && a[0].about === 'store'],
  ['איפה הכי זול סלמון?', (a) => a[0].type === 'searchProductPrices' && a[0].needId === 'SALMON'],
  ['יש מבצע על בשר טחון?', (a) => a[0].type === 'searchPromotions' && a[0].needId === 'GROUND_MEAT'],
  ['כמה עולה קולה זירו ברשתות ששולחות אליי?', (a) => a[0].type === 'searchProductPrices' && a[0].needId === 'COLA_ZERO'],
  ['קח 2 וניש אם יש מבצע טוב', (a) => a[0].type === 'addBasketItem' && a[0].needId === 'VANISH' && a[0].quantity === 2 && a[0].conditional === 'good_price'],
  ['אל תעבור 650', (a) => a[0].type === 'setBudget' && a[0].cap === 650],
  ['אין טונה', (a) => a[0].type === 'updateHouseholdStock' && a[0].level === 'none'],
  ['אני לא אוהב את הטונה הזאת', (a) => a[0].type === 'updatePreference' && a[0].dislikeCurrent],
  ['תוסיף פרגיות', (a) => a[0].type === 'addBasketItem' && a[0].needId === 'CHICKEN_THIGHS' && !a[0].conditional],
  ['אל תציע לי יותר במבה', (a) => a[0].type === 'updatePreference' && a[0].neverSuggest],
  ['איפה הכי משתלם להזמין?', (a) => a[0].type === 'quoteBasketAcrossProviders'],
  ['תוסיף אבוקדו', (a) => a[0].type === 'addBasketItem' && a[0].newLabel === 'אבוקדו'],
  ['נשארו 2 תבניות ביצים', (a) => a[0].type === 'updateHouseholdStock' && a[0].qty === 24],
  ['קניתי', (a) => a[0].type === 'confirmPurchase'],
  ['מה חסר בבית?', (a) => a[0].type === 'showStock'],
  ['יש קצת חלב', (a) => a[0].needId === 'MILK' && a[0].level === 'little'],
  ['לא אכפת לי מאיזה מותג של מרכך', (a) => a[0].needId === 'LAUNDRY_SOFTENER' && a[0].flexibility === 'category_flexible'],
];
for (const [text, ok] of cases) {
  test(text, () => {
    const a = parseMessage(text);
    assert.ok(ok(a), JSON.stringify(a));
  });
}
