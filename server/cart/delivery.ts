// Delivery to the household's exact address, as the supermarket's own page shows it.
// Pure logic: drivers read the page (inside the user's own browser session) into a DeliveryRead; this file decides
// the status. "confirmed" only when the site shows the selected address AND accepts delivery to it — never from a
// city or a branch list. Only a display-safe address (street, number, city) is ever stored.
import type { Address, DeliveryStatus, ProviderDelivery } from '../../shared/types.ts';
import { kvGet, kvSet } from '../db.ts';
import { nowIso } from '../clock.ts';

/** Raw facts a driver read from the supermarket page. Never persisted as-is. */
export type DeliveryRead = {
  pageOk: boolean; // found something we know how to read (false = the page changed / didn't load)
  addressText?: string; // the delivery address as the site shows it
  address?: { street?: string; number?: string; city?: string }; // when the site exposes it structured
  addressSelected?: boolean; // false = the site asks to choose an address
  available?: boolean; // true = the site accepts delivery to that address; false = it refuses
  fee?: number;
  windows?: string[];
  minOrder?: number;
  restriction?: string;
  notTied?: string; // the site accepts the address, but the cart is set up for something else (other area / pickup)
};

const amount = (s?: string) => {
  if (!s) return undefined;
  const n = parseFloat(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : undefined;
};
const NIS = String.raw`(?:₪\s*([\d,]+(?:\.\d+)?)|([\d,]+(?:\.\d+)?)\s*(?:₪|ש"ח|ש״ח|שח))`;

const UNAVAILABLE = /(אין משלוחים|אין אפשרות משלוח|לא (?:מבצעים|מבצעת|מגיעים|ניתן לבצע|ניתן לשלוח|ניתן להזמין משלוח|נמצא אזור)[^\n]{0,20}(?:משלוח|לכתובת|לאזור)?|מחוץ לאזור (?:ה)?(?:חלוקה|משלוח|השירות)|אינ[הו] (?:נמצאת? )?באזור (?:ה)?(?:חלוקה|משלוח|השירות)|לא מצאנו אזור משלוח|הכתובת אינה באזור)/;
const ASK_ADDRESS = /(בחר(?:ו|י)? כתובת|הזינו כתובת|הזן כתובת|הוסיפו כתובת|הוסף כתובת|לאן (?:לשלוח|נשלח)|בחר(?:ו)? אזור משלוח|הכניסו כתובת)/;
const ACCEPTED = /((?:ה)?משלוח (?:זמין|אפשרי|מגיע) (?:ל|אל )?(?:כתובת|הכתובת|אזור)|יש משלוחים (?:ל|אל )?(?:כתובת|הכתובת|אזור)|אנחנו מגיעים אליך)/;
const ADDRESS = /(?:כתובת (?:ה)?משלוח|כתובת למשלוח|משלוח ל(?:כתובת)?|המשלוח יגיע ל|נשלח ל|שולחים ל)\s*:?\s*([^\n]{4,90})/;
const WINDOW = /\d{1,2}:\d{2}\s*[-–]\s*\d{1,2}:\d{2}/;

/** Reads delivery facts from the visible text of a supermarket cart / checkout-entry page (no checkout is submitted). */
export function parseDeliveryText(text: string): DeliveryRead {
  const lines = text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const all = lines.join('\n');
  const read: DeliveryRead = { pageOk: /משלוח|כתובת/.test(all) };
  const un = all.match(UNAVAILABLE);
  if (un) { read.available = false; read.restriction = lines.find((l) => l.includes(un[1]))?.slice(0, 140) ?? un[1]; }
  const addr = all.match(ADDRESS);
  if (addr && /[א-ת]{2}/.test(addr[1]) && /\d|,/.test(addr[1]) && !ASK_ADDRESS.test(addr[1])) { read.addressText = addr[1].trim(); read.addressSelected = true; }
  else if (ASK_ADDRESS.test(all)) read.addressSelected = false;
  const fee = all.match(new RegExp(String.raw`דמי משלוח\s*:?\s*(?:${NIS}|(חינם))`));
  if (fee) read.fee = fee[3] ? 0 : amount(fee[1] ?? fee[2]);
  const min = all.match(new RegExp(String.raw`מינימום(?: ה?הזמנה| לקנייה| להזמנה| למשלוח| הזמנה למשלוח)?\s*:?\s*${NIS}`));
  if (min) read.minOrder = amount(min[1] ?? min[2]);
  const windows = [...new Set(lines.filter((l) => WINDOW.test(l)).map((l) => l.slice(0, 60)))];
  if (windows.length) read.windows = windows.slice(0, 6);
  if (read.available !== false && read.addressSelected && (windows.length || ACCEPTED.test(all))) read.available = true;
  return read;
}

// ---------- ZuZ / Stor.ai sites (Tiv Taam, Victory, Yenot Bitan, Carrefour, Keshet, Quik) ----------

/** Raw state read inside a ZuZ page: the cart's chosen delivery area, the site's own lookup of the household
 *  address (geocoded against the chain's delivery polygons), and the free slots for the cart's area. */
export type ZuzRaw = {
  query?: string; // the household address the site was asked about
  minOrder?: number;
  cartArea?: { id: number; name: string; deliveryTypeId?: number; fee?: number } | null;
  lookup?: { status: number; error?: string; areas: { id: number; name: string; branchId?: number; price?: number; min?: number | null }[]; components: { name: string; types: string[] }[] };
  slots?: { from: string; to: string; price?: number }[];
  cartDeliveryCost?: number;
};

const slotText = (from: string, to: string) => {
  const f = new Date(from), t = new Date(to);
  const day = f.toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem', weekday: 'short', day: 'numeric', month: 'numeric' });
  const hm = (d: Date) => d.toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hour12: false });
  return `${day} ${hm(f)}–${hm(t)}`;
};

export function fromZuz(raw: ZuzRaw | null | undefined): DeliveryRead {
  if (!raw || !raw.lookup) return { pageOk: false };
  const comp = (type: string) => raw.lookup!.components.find((c) => c.types.includes(type))?.name;
  const address = raw.lookup.components.length ? { street: comp('route'), number: comp('street_number'), city: comp('locality') } : undefined;
  const read: DeliveryRead = { pageOk: true, address, minOrder: raw.minOrder };
  const { status, areas } = raw.lookup;
  if (status === 404 || (status === 200 && !areas.length)) {
    return { ...read, addressText: address ? undefined : raw.query, addressSelected: true, available: false, restriction: 'לפי האתר, הכתובת מחוץ לאזורי המשלוח של הרשת.' };
  }
  if (status !== 200) return { ...read, address: undefined, addressSelected: false, restriction: status === 400 ? 'האתר לא זיהה את הכתובת השמורה.' : `האתר לא החזיר תשובה לכתובת (${status}).` };
  read.addressSelected = true;
  const area = raw.cartArea;
  const match = area ? areas.find((a) => a.id === area.id) : undefined;
  if (!area) read.notTied = `העגלה באתר עוד לא משויכת לאזור משלוח. בחרו באתר את הכתובת/האזור שלכם (${areas[0].name}).`;
  else if (area.deliveryTypeId === 2) read.notTied = 'בעגלה באתר נבחר איסוף עצמי ולא משלוח.';
  else if (!match) read.notTied = `העגלה באתר משויכת לאזור "${area.name}", אבל לפי האתר הכתובת שלכם שייכת ל"${areas[0].name}". בחרו באתר את הכתובת הנכונה.`;
  const priced = match ?? areas[0];
  read.fee = raw.cartDeliveryCost && raw.cartDeliveryCost > 0 ? raw.cartDeliveryCost : area?.fee ?? priced.price;
  if (priced.min) read.minOrder = priced.min;
  if (match) {
    read.available = true;
    const windows = (raw.slots ?? []).map((s) => slotText(s.from, s.to));
    if (windows.length) read.windows = [...new Set(windows)].slice(0, 6);
    else read.restriction = 'אין כרגע חלונות משלוח פנויים לאזור הזה.';
  }
  return read;
}

// ---------- address handling ----------

const ALIASES: [RegExp, string][] = [[/ת"א|ת״א|תל-אביב/g, 'תל אביב'], [/פ"ת|פ״ת/g, 'פתח תקווה'], [/ר"ג|ר״ג/g, 'רמת גן'], [/ראשל"צ|ראשל״צ/g, 'ראשון לציון'], [/ב"ש|ב״ש/g, 'באר שבע']];
export function norm(s: string): string {
  let t = s;
  for (const [re, to] of ALIASES) t = t.replace(re, to);
  t = ` ${t.replace(/[֑-ׇ"'׳״`.,()\-–/]/g, ' ').replace(/\s+/g, ' ')} `;
  t = t.replace(/ (?:רחוב|רח|שד|שדרות|דרך)(?= )/g, ' ');
  return t.replace(/קריית/g, 'קרית').replace(/תקוה/g, 'תקווה').replace(/\s+/g, ' ').trim();
}
const words = (s: string) => norm(s).split(' ').filter((w) => w && !/^\d+$/.test(w));
const houseNumber = (s: string) => norm(s).match(/(?:^|\s)(\d{1,4})(?=\s|$)/)?.[1];

export const addressKey = (home?: Address) => (home ? norm(`${home.city}|${home.street ?? ''}`) : '');
export const homeLabel = (home: Address) => [home.street, home.city].filter(Boolean).join(', ');

/** Only street + house number + city — no names, phone numbers, apartment/floor or notes. */
export function safeAddress(read: Pick<DeliveryRead, 'address' | 'addressText'>, home?: Address): string | undefined {
  const a = read.address;
  if (a && (a.street || a.city)) return [[a.street, a.number].filter(Boolean).join(' '), a.city].filter(Boolean).join(', ').slice(0, 60) || undefined;
  if (!read.addressText) return undefined;
  const parts = read.addressText
    .replace(/0\d{1,2}[-\s]?\d{3}[-\s]?\d{4}/g, ' ') // phone numbers
    .replace(/(?:דירה|קומה|כניסה|ד'|ק'|דיר')\s*:?\s*[^\s,|]+/g, ' ')
    .split(/[,|\n·]/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const keep = parts.filter((p) => (/[א-ת]{2}/.test(p) && /\d/.test(p) && p.length <= 40) || (home && norm(p).includes(norm(home.city))) || (home?.street && words(home.street).some((w) => norm(p).includes(w))));
  const out = keep.join(', ').slice(0, 60);
  return out || undefined;
}

/** Does the address the site shows match the household's stored address (street, number and city)? */
export function addressMatchesHome(text: string, home: Address): boolean {
  const t = ` ${norm(text)} `;
  if (!words(home.city).every((w) => t.includes(` ${w} `) || t.includes(w))) return false;
  if (!home.street) return false;
  if (!words(home.street).every((w) => t.includes(w))) return false;
  const n = houseNumber(home.street);
  return !n || t.includes(` ${n} `);
}

// ---------- the decision ----------

export type AssessOpts = { previousAddressText?: string; cartTotal?: number; basketCompleteness?: number };

export function assessDelivery(providerId: string, read: DeliveryRead, home: Address | undefined, opts: AssessOpts = {}): ProviderDelivery {
  const shown = safeAddress(read, home);
  const base = {
    providerId, source: 'provider_page' as const, checkedAt: nowIso(), addressKey: addressKey(home),
    deliveryFee: read.fee, deliveryWindows: read.windows?.length ? read.windows.slice(0, 6) : undefined, minimumOrder: read.minOrder,
    cartTotal: opts.cartTotal, basketCompleteness: opts.basketCompleteness,
  };
  const out = (deliveryStatus: DeliveryStatus, restrictionMessage?: string, confirmedAddressText?: string): ProviderDelivery =>
    ({ ...base, deliveryStatus, restrictionMessage, confirmedAddressText });

  if (!read.pageOk) return out('unknown', 'לא הצלחתי לקרוא את מצב המשלוח מהאתר — ייתכן שהעמוד השתנה או לא נטען.');
  if (!home) return out('unknown', 'אין כתובת בית שמורה לבדוק מולה.');
  if (!home.street) return out('unknown', 'בפרופיל שמורה רק עיר. כדי לאמת משלוח לכתובת מדויקת צריך רחוב ומספר בית.');
  const siteText = read.addressText ?? (read.address ? [read.address.street, read.address.number, read.address.city].filter(Boolean).join(' ') : '');
  if (!siteText) {
    return out('user_action_required', read.addressSelected === false ? 'האתר מבקש לבחור כתובת משלוח.' : read.restriction ?? 'האתר לא מציג כתובת משלוח לעגלה.');
  }
  if (!addressMatchesHome(siteText, home)) {
    return out('user_action_required', `באתר נבחרה כתובת אחרת${shown ? ` (${shown})` : ''} — לא ${homeLabel(home)}.`);
  }
  if (opts.previousAddressText && norm(opts.previousAddressText) !== norm(shown ?? siteText)) {
    return out('user_action_required', 'כתובת המשלוח באתר השתנתה בזמן הכנת העגלה — אשרו אותה שוב.');
  }
  if (read.available === false) return out('unavailable', read.restriction ?? 'האתר לא מאפשר משלוח לכתובת הזו.', shown);
  if (read.notTied) return out('user_action_required', read.notTied);
  if (read.available !== true) return out('unknown', 'האתר מציג את הכתובת אבל לא הראה אם יש אליה משלוח (למשל חלונות משלוח).', shown);
  const minIssue = read.minOrder && opts.cartTotal !== undefined && opts.cartTotal < read.minOrder
    ? `מינימום הזמנה ₪${read.minOrder} — בעגלה ₪${Math.round(opts.cartTotal)}. חסרים ₪${Math.ceil(read.minOrder - opts.cartTotal)}.` : undefined;
  return out('confirmed', minIssue ?? read.restriction, shown);
}

// ---------- storage (display-safe results only) ----------

const KEY = 'providerDelivery';
const MAX_AGE_MS = 14 * 86400000;

export function recordDelivery(d: ProviderDelivery) {
  const all = kvGet<Record<string, ProviderDelivery>>(KEY) ?? {};
  all[d.providerId] = d;
  kvSet(KEY, all);
}

/** The last result for this provider, only if it was checked against the current stored address and is recent. */
export function verifiedDelivery(providerId: string, home: Address | undefined, now = Date.now()): ProviderDelivery | undefined {
  const d = (kvGet<Record<string, ProviderDelivery>>(KEY) ?? {})[providerId];
  if (!d || !home || d.addressKey !== addressKey(home)) return undefined;
  if (now - new Date(d.checkedAt).getTime() > MAX_AGE_MS) return undefined;
  return d;
}

/** A delivery result shown later (e.g. on a prepared cart) — flags it if the stored address changed since. */
export function stillValid(d: ProviderDelivery | undefined, home: Address | undefined): ProviderDelivery | undefined {
  if (!d) return d;
  if (d.addressKey !== addressKey(home)) return { ...d, deliveryStatus: 'user_action_required', restrictionMessage: 'הכתובת בפרופיל השתנתה מאז שהעגלה הוכנה — צריך לאשר את הכתובת באתר מחדש.', confirmedAddressText: undefined };
  return d;
}
