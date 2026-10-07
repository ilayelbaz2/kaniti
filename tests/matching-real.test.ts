// Matching safety on REAL product names collected from Tiv Taam online and three Ramat Gan branches (Oct 2026).
// Adversarial: each candidate in turn is made the cheapest. A wrong product may never be picked with confidence —
// the allowed outcomes are: a right product, nothing, or a match flagged as uncertain (shown to the user, never auto-bought).
process.env.KANITI_DB = ':memory:';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const { chooseProduct } = await import('../server/engine/match.ts');
const { conceptById } = await import('../server/catalog.ts');
const { newNeed } = await import('../server/state.ts');

const real: Record<string, Record<string, string[]>> = JSON.parse(fs.readFileSync(new URL('./fixtures/real-names.json', import.meta.url), 'utf8'));

// What a correct pick looks like (pos) and what it must never be (neg).
const RULES: Record<string, { pos: RegExp; neg?: RegExp; constraints?: string[] }> = {
  EGGS: { pos: /^\s*\d*\s*ביצי?ם/, neg: /אטריות|פתיתי|פסטה|חותך|פורס|ליקר|עוגי|נודלס/ },
  BREAD: { pos: /^לחם/, neg: /פירורי/ },
  TUNA: { pos: /טונה/, neg: /סלט|פיצה/ },
  CREAM_CHEESE: { pos: /גבינ.? ?שמנת|גב\.? ?שמנת|פילדלפיה|שמנת למריחה|גבינה לבנה/, neg: /טילון|להקצפה|חמוצה|מתוקה|בישול/ },
  YELLOW_CHEESE: { pos: /גבינה|עמק/, neg: /שמנת|מגורד/ },
  MILK: { pos: /^(קרטון )?חלב/, neg: /שוקו|ביסקוויט|משקה|יוגורט|אבקה/ },
  DAIRY_FREE_DESSERT: { pos: /(מעדן|פודינג|קינוח).*(סויה|פרווה|שקדים|שיבולת|אלפרו|קוקוס)|(סויה|פרווה).*(מעדן|פודינג)/, neg: /וחלב|חלבי|גבינ/ },
  COLA_ZERO: { pos: /(קולה|פפסי).*(זירו|zero|מקס)/i, neg: /ספרייט|פאנטה|נטול/ },
  SODA: { pos: /סודה/, neg: /לשתי|נוזל|פירות/ },
  PEANUT_BUTTER: { pos: /חמאת בוטנ|ח\. ?בוטנים/, neg: /סניקרס|עדשי|M&M|חט\.|מצופ/ },
  CHOCO_SPREAD: { pos: /(ממרח|נוטלה).*(שוקו|קקאו|השחר|נוטלה|לוז|נוגט)|השחר|נוטלה/, neg: /חלבי/, constraints: ['ללא חלב'] },
  PASTA: { pos: /פסטה|ספגטי|פנה|פוסילי/, neg: /ניוקי|רוטב/ },
  PTITIM: { pos: /פתיתים/ },
  BAMBA: { pos: /במבה/ },
  COFFEE: { pos: /קפה נמס|נס ?קפה|טסטרס|נמס/, neg: /עוגי|לאטה|טורקי|קר |אייס/ },
  GROUND_MEAT: { pos: /טחון/, neg: /קציצ/ },
  CHICKEN_BREAST: { pos: /חזה/, neg: /הודו|נקניק|מעושן|פסטרמה/ },
  CHICKEN_THIGHS: { pos: /פרגי/, neg: /פסטרמה|נקניק/ },
  SALMON: { pos: /סלמון/, neg: /מעושן|שימור|בשמן|מובחר|פרוס/ },
  TOMATOES: { pos: /^עגבני/, neg: /קצוצ|חתוכ|מרוסק|רסק|מיץ|שימור|מקולפ/ },
  ONIONS: { pos: /^בצל/, neg: /ירוק|פנינה|מטוגן|אבקת/ },
  CABBAGE: { pos: /^כרוב/, neg: /כבוש|סלט|ניצני/ },
  LETTUCE: { pos: /^חס[הת]/, neg: /סלט|רוטב/ },
  KOHLRABI: { pos: /קולרבי/ },
  CUCUMBERS: { pos: /מלפפון/, neg: /חומץ|חמוץ|כבוש|במלח|תחליב/ },
  LAUNDRY_DETERGENT: { pos: /כביסה|כבי\./, neg: /מרכך|וניש|קליה|מסיר|אסטוניש/ },
  LAUNDRY_SOFTENER: { pos: /מרכך/, neg: /שיער/ },
  VANISH: { pos: /וניש|קליה/, neg: /אסטוניש/ },
  TOILET_PAPER: { pos: /נייר טואלט|נ\.? ?טואלט/, neg: /דאק|אסלה/ },
  BANANAS: { pos: /^בננ/, neg: /ציפס|משקה|פונץ|פקק|מיובש|דגני|שייק/ },
  FRUIT_FOR_CHILD: { pos: /תפוח|אגס|ענבים|תותים|קלמנטינ|אפרסק/, neg: /מיובש|צלול|מיץ|מ"ל|רסק|ציפס/ },
};

const mk = (name: string, price: number) => ({ providerId: 'x', productId: name, name, price, available: true, source: 'live' as const, fetchedAt: '' });

for (const [id, rule] of Object.entries(RULES)) {
  test(`real names: ${id}`, () => {
    const c = conceptById.get(id)!;
    assert.ok(c, id);
    const need = { ...newNeed(c, 2, 1), flexibility: 'category_flexible' as const, hardConstraints: rule.constraints ?? (c.dairyFree ? ['ללא חלב'] : []) };
    const sources = real[id] ?? {};
    assert.ok(Object.keys(sources).length, `no real fixture for ${id}`);
    for (const [prov, names] of Object.entries(sources)) {
      for (let cheap = -1; cheap < names.length; cheap++) {
        const cands = names.map((n, i) => mk(n, i === cheap ? 1 : 10 + i));
        const ch = chooseProduct(c, need, cands);
        if (!ch || ch.uncertain) continue;
        const name = ch.product.name;
        assert.ok(rule.pos.test(name) && !(rule.neg?.test(name)), `${id} @ ${prov}: confidently picked "${name}" (cheapest: "${names[cheap] ?? '-'}")`);
      }
    }
  });
}

test('strict Coca-Cola Zero never becomes another cola', () => {
  const c = conceptById.get('COLA_ZERO')!;
  const need = { ...newNeed(c, 2, 1), flexibility: 'exact_product' as const, preferredBrands: ['קוקה קולה'] };
  for (const names of Object.values(real.COLA_ZERO)) {
    for (let cheap = 0; cheap < names.length; cheap++) {
      const ch = chooseProduct(c, need, names.map((n, i) => mk(n, i === cheap ? 1 : 10)));
      if (ch && !ch.uncertain) assert.match(ch.product.name, /קוקה.?קולה.*(זירו|zero)/i, ch.product.name);
    }
  }
});

test('dairy-free desserts never pick a dairy dessert', () => {
  const c = conceptById.get('DAIRY_FREE_DESSERT')!;
  const need = { ...newNeed(c, 2, 1), hardConstraints: ['ללא חלב'] };
  const names = ['מעדן שיבולת שועל וחלב 2% 150 גר', 'מעדן מילקי שוקולד', 'מעדן סויה וניל 125 גר', 'פודינג חלבי וניל'];
  for (let cheap = 0; cheap < names.length; cheap++) {
    const ch = chooseProduct(c, need, names.map((n, i) => mk(n, i === cheap ? 1 : 10)));
    assert.equal(ch?.product.name, 'מעדן סויה וניל 125 גר');
  }
});
