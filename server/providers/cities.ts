// Loose Hebrew city matching. Price-transparency store files use CBS locality codes (e.g. 8600 = רמת גן),
// so we map common city names to codes and also fall back to matching the name in the store name/address.
const clean = (s: string) =>
  s.replace(/[֑-ׇ"'׳״\-–]/g, ' ').replace(/קריית/g, 'קרית').replace(/\s+/g, ' ').trim();

const CODES: Record<string, string> = {
  'ירושלים': '3000', 'תל אביב': '5000', 'תל אביב יפו': '5000', 'חיפה': '4000', 'ראשון לציון': '8300', 'פתח תקווה': '7900', 'פתח תקוה': '7900',
  'אשדוד': '70', 'נתניה': '7400', 'באר שבע': '9000', 'בני ברק': '6100', 'חולון': '6600', 'רמת גן': '8600', 'אשקלון': '7100',
  'רחובות': '8400', 'בת ים': '6200', 'בית שמש': '2610', 'כפר סבא': '6900', 'הרצליה': '6400', 'חדרה': '6500', 'מודיעין': '1200',
  'מודיעין מכבים רעות': '1200', 'לוד': '7000', 'רמלה': '8500', 'רעננה': '8700', 'גבעתיים': '6300', 'הוד השרון': '9700', 'ראש העין': '2640',
  'קרית גת': '2630', 'נהריה': '9100', 'עפולה': '7700', 'יבנה': '2660', 'אילת': '2600', 'קרית אתא': '6800', 'עכו': '7600',
  'קרית מוצקין': '8200', 'קרית ביאליק': '9500', 'קרית ים': '9600', 'נס ציונה': '7200', 'רמת השרון': '2650', 'טבריה': '6700',
  'אור יהודה': '2400', 'יהוד': '9400', 'קרית אונו': '2620', 'ביתר עילית': '3780', 'מעלה אדומים': '3616', 'מבשרת ציון': '1015',
  'באר יעקב': '2530', 'נשר': '2500', 'צפת': '8000', 'מגדל העמק': '874', 'שוהם': '1304', 'תל מונד': '154', 'קדימה צורן': '195',
  'נתיבות': '246', 'זכרון יעקב': '9300', 'פרדס חנה כרכור': '7800', 'מודיעין עילית': '3797', 'כרמיאל': '1139', 'דימונה': '2200',
};

const codeOf = (city: string) => CODES[clean(city)];

export function sameCity(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  if (/^\d+$/.test(a.trim())) return a.trim() !== '0' && codeOf(b) === a.trim();
  if (/^\d+$/.test(b.trim())) return b.trim() !== '0' && codeOf(a) === b.trim();
  const x = clean(a), y = clean(b);
  if (!x || !y) return false;
  return x === y || x.startsWith(y + ' ') || y.startsWith(x + ' ') || x.includes(y) || y.includes(x);
}

/** Store-file match: city code, or the city name appearing in the store name / address. */
export function storeInCity(store: { city: string; name: string; address?: string }, city: string): boolean {
  if (sameCity(store.city, city)) return true;
  const c = clean(city);
  return c.length > 1 && (clean(store.name).includes(c) || clean(store.address ?? '').includes(c));
}
