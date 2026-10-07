// Demo prices for offline development ONLY (KANITI_DEMO=1). Results are labelled source:'demo'
// and the UI says so loudly. Never enabled by default.
import type { DeliveryAvailability, ProductSearchResult } from '../../shared/types.ts';
import { CONCEPTS } from '../catalog.ts';
import { nowIso } from '../clock.ts';
import type { GroceryProvider } from './types.ts';

const BASE: Record<string, [string, number][]> = {
  EGGS: [['ביצים L תבנית 12', 13.9], ['ביצים M תבנית 12 משק', 12.5]],
  BREAD: [['לחם אחיד פרוס אנג\'ל 750 גרם', 8.9], ['לחם מחמצת ברמן', 14.9]],
  TUNA: [['טונה בשמן סטארקיסט 4*160 גרם', 32.9], ['טונה בשמן ויליגר 4*160 גרם', 24.9]],
  CREAM_CHEESE: [['גבינת שמנת תנובה 5% 225 גרם', 7.9], ['גבינת שמנת פילדלפיה 250 גרם', 13.5]],
  YELLOW_CHEESE: [['גבינה צהובה עמק פרוסות 200 גרם', 15.9], ['גבינה צהובה גד פרוסות 200 גרם', 13.9]],
  MILK: [['חלב 3% תנובה קרטון 1 ליטר', 7.1]],
  COTTAGE: [['קוטג\' תנובה 5% 250 גרם', 6.2]],
  KIDS_DAIRY: [['מעדן מילקי שטראוס 4 יח', 12.9], ['מעדן דני וניל 4 יח', 11.9]],
  COLA_ZERO: [['קוקה קולה זירו 6*1.5 ליטר', 39.9], ['פפסי מקס זירו 6*1.5 ליטר', 29.9]],
  SODA: [['סודה מי עדן 6*1.5 ליטר', 15.9]],
  PEANUT_BUTTER: [['חמאת בוטנים ביגי 500 גרם', 19.9]],
  CHOCO_SPREAD: [['ממרח שוקולד השחר העולה 400 גרם', 16.9], ['נוטלה ממרח 350 גרם', 22.9]],
  PASTA: [['פסטה פנה אסם 500 גרם', 6.9], ['ספגטי ברילה 500 גרם', 8.9]],
  PTITIM: [['פתיתים אסם אפויים 500 גרם', 6.5]],
  RICE: [['אורז פרסי סוגת 1 ק"ג', 11.9]],
  BAMBA: [['במבה אסם 4*80 גרם', 14.9]],
  COFFEE: [['קפה נמס עלית 200 גרם', 29.9], ['נסקפה טסטרס צ\'ויס 200 גרם', 44.9]],
  CHICKEN_BREAST: [['חזה עוף טרי עוף טוב לק"ג', 49.9]],
  CHICKEN_THIGHS: [['פרגיות עוף טריות לק"ג', 54.9]],
  GROUND_MEAT: [['בשר בקר טחון טרי 500 גרם', 34.9]],
  SALMON: [['פילה סלמון נורבגי 500 גרם', 54.9]],
  SCHNITZEL_FROZEN: [['שניצל תירס מאמא עוף 1 ק"ג', 29.9]],
  HUMMUS: [['חומוס צבר 400 גרם', 9.9]],
  TOMATOES: [['עגבניות לק"ג', 7.9]],
  CUCUMBERS: [['מלפפון לק"ג', 6.9]],
  BANANAS: [['בננה לק"ג', 8.9]],
  FRUIT_FOR_CHILD: [['תפוח עץ פינק ליידי לק"ג', 12.9], ['תותים סלסלה 500 גרם', 14.9]],
  OIL: [['שמן קנולה מזרע 1 ליטר', 11.9]],
  BUTTER: [['חמאה תנובה 200 גרם', 9.9]],
  CEREAL: [['דגני בוקר קורנפלקס תלמה 750 גרם', 19.9]],
  SNACK_ROTATING: [['חטיף ביסלי גריל 200 גרם', 7.9], ['עוגיות פתי בר 500 גרם', 9.9]],
  TOILET_PAPER: [['נייר טואלט לילי 32 גלילים', 49.9]],
  LAUNDRY_DETERGENT: [['ג\'ל כביסה סנו מקסימה 3 ליטר', 39.9], ['ג\'ל כביסה אריאל 2.5 ליטר', 54.9]],
  LAUNDRY_SOFTENER: [['מרכך כביסה בדין 4 ליטר', 24.9], ['מרכך כביסה סנו מקסימה 4 ליטר', 21.9]],
  VANISH: [['וניש קליה אבקה 1 ק"ג', 34.9]],
  DISH_SOAP: [['סבון כלים פיירי 750 מ"ל', 11.9]],
};

// Deterministic per provider + week "promotions" so the deal logic has something to chew on.
function variant(providerId: string, i: number, name: string) {
  let h = 7;
  for (const ch of providerId + name) h = (h * 31 + ch.charCodeAt(0)) % 9973;
  const week = Math.floor(Date.now() / (7 * 86400000));
  const priceFactor = 0.92 + ((h + i) % 17) / 100;
  const promo = (h + week) % 5 === 0;
  const missing = (h + i) % 23 === 0;
  return { priceFactor, promo, missing };
}

export function demoProvider(id: string, name: string, fee: number): GroceryProvider {
  return {
    id, name, kind: 'online', deliveryFee: fee, minOrder: 150, freeDeliveryFrom: 400,
    async checkDelivery(): Promise<DeliveryAvailability> {
      return { providerId: id, status: 'likely', delivers: true, note: 'דמו — לא נבדק מול הרשת', deliveryFee: fee, minOrder: 150, checkedLive: false };
    },
    async searchProducts(query: string): Promise<ProductSearchResult[]> {
      const concept = CONCEPTS.find((c) => c.query === query || c.label === query || c.synonyms.some((s) => query.includes(s)));
      const rows = concept ? BASE[concept.id] ?? [] : [];
      return rows.map(([n, p], i) => {
        const v = variant(id, i, n);
        const price = Math.round(p * v.priceFactor * 10) / 10;
        return {
          providerId: id, productId: `${id}-${concept!.id}-${i}`, name: n, price,
          promoPrice: v.promo ? Math.round(price * 0.7 * 10) / 10 : undefined,
          promoText: v.promo ? 'מבצע דמו' : undefined,
          available: !v.missing, source: 'demo' as const, fetchedAt: nowIso(),
        };
      });
    },
  };
}
