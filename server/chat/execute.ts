import { per14Text, qtyText } from '../../shared/product.ts';
// Runs typed actions against app state and produces chat replies (text + rich components).
// The wording here is deterministic; the LLM (if any) only chooses actions.
import type { ChatComponent, ChatMessage, Flexibility } from '../../shared/types.ts';
import { store, kvGet, kvSet } from '../db.ts';
import { nowIso, uid } from '../clock.ts';
import { allConcepts, ensureNeed, estimateStock, fuzzyStock, getConcept, logEvent, setStock, updateNeed } from '../state.ts';
import { checkInQuestions, explainItem, flexText, fmt } from '../engine/basket.ts';
import { compareBasket, explainStoreChoice } from '../engine/compare.ts';
import * as svc from '../service.ts';
import type { Action } from './actions.ts';
import { loadContext, saveContext } from './context.ts';
import { productLine } from '../../shared/product.ts';
import { providerName } from '../providers/index.ts';

type Out = { lines: string[]; components: ChatComponent[]; changes: string[] };
type Pending = { horizon: number; needIds: string[] };

const FLEX_LABEL: Record<Flexibility, string> = {
  exact_product: 'רק המוצר הקבוע',
  brand_flexible: 'מותג מועדף, מחליף אם משתלם',
  category_flexible: 'המותג לא חשוב — לפי מחיר',
  exploratory: 'פתוחים לגיוון',
};

export async function executeActions(actions: Action[], extraText?: string): Promise<ChatMessage> {
  const out: Out = { lines: [], components: [], changes: [] };
  if (extraText) out.lines.push(extraText);
  let stateTouched = false;
  let basketHandled = false;

  // "המותג הזה" / "אותו" refer to what the conversation was just about.
  const ctx = loadContext();
  for (const a of actions) if (a.type === 'updatePreference' && a.needId === 'FOCUS') {
    if (ctx?.focusNeedId) a.needId = ctx.focusNeedId; else { out.lines.push('על איזה מוצר מדובר? למשל: "אל תציע את המרכך הזה".'); a.needId = ''; }
  }
  const focusIds = actions.map((a) => ('needId' in a ? a.needId : undefined)).filter((x): x is string => !!x && x !== 'FOCUS');
  let focusLabel: string | undefined;

  for (const a of actions) {
    if (a.type === 'updatePreference' && !a.needId) continue;
    switch (a.type) {
      case 'setTemporaryInstruction': {
        if (a.mode === 'skip' && a.needId) {
          const c = getConcept(a.needId);
          svc.removeItem(a.needId, true);
          out.changes.push(`${c.emoji} ${c.label}: לא בקנייה הזאת (רק הפעם — ההרגלים לא משתנים)`);
        } else if (a.mode === 'include') {
          const { item } = await svc.addItem({ needId: a.needId, newLabel: a.newLabel, quantity: a.quantity });
          out.changes.push(`${item.emoji} ${item.label}: נכנס לקנייה הזאת (רק הפעם)${item.product ? ` · ₪${item.product.price}` : ''}`);
        }
        basketHandled = true;
        break;
      }
      case 'prepareProviderCart': {
        try {
          const job = await svc.prepareProviderCart(a.providerId);
          out.lines.push(job.status === 'unsupported' ? job.message : `מכין את העגלה ב${job.providerName}. אם צריך להתחבר — יפתח חלון של הרשת במחשב. התשלום נשאר אצלם.`);
          out.components.push({ type: 'quick_replies', options: [{ label: 'מעקב אחרי העגלה', send: '@open:cart' }] });
        } catch (e) {
          out.lines.push((e as Error).message);
          out.components.push({ type: 'quick_replies', options: [{ label: 'השווה רשתות', send: '#compare' }] });
        }
        break;
      }
      case 'updateHouseholdStock': {
        const n = ensureNeed(a.needId);
        const c = getConcept(a.needId);
        let qty: number, conf: number;
        if (a.qty !== undefined) { qty = a.qty; conf = 0.95; }
        else { const f = fuzzyStock(n, a.level ?? 'some'); qty = f.qty; conf = f.confidence; }
        setStock(a.needId, qty, conf, a.raw);
        if (!n.active && qty === 0) updateNeed(a.needId, { active: true });
        out.changes.push(`${c.emoji} ${c.label}: ${a.level === 'none' || qty === 0 ? 'נגמר' : a.level === 'lots' ? `יש הרבה (${qtyText(qty, c.stockUnit)})` : `${qtyText(qty, c.stockUnit)}`}`);
        resolvePending(a.needId);
        stateTouched = true;
        break;
      }
      case 'updatePreference': {
        const n = ensureNeed(a.needId);
        const c = getConcept(a.needId);
        const patch: Parameters<typeof updateNeed>[1] = {};
        if (a.flexibility) { patch.flexibility = a.flexibility; patch.flexConfidence = 0.95; }
        if (a.preferredBrands) patch.preferredBrands = a.preferredBrands;
        if (a.forbiddenBrands) patch.forbiddenBrands = [...new Set([...n.forbiddenBrands, ...a.forbiddenBrands])];
        if (a.dealSensitivity) patch.dealSensitivity = a.dealSensitivity;
        if (a.neverSuggest !== undefined) patch.neverSuggest = a.neverSuggest;
        if (a.active !== undefined) patch.active = a.active;
        if (a.dislikeCurrent) {
          const current = store.basket()?.items.find((i) => i.needId === a.needId)?.product;
          const name = current?.name ?? n.lastProductName;
          const brand = current?.brand ?? c.brands.find((b) => name?.includes(b));
          if (brand) patch.forbiddenBrands = [...new Set([...n.forbiddenBrands, brand])];
          if (n.lastProductName === name) patch.lastProductName = undefined;
          out.changes.push(`${c.emoji} ${c.label}: לא להציע ${brand ?? name ?? 'את המוצר הזה'}`);
          if (current) { try { svc.replaceItem(a.needId); } catch { /* nothing to replace */ } }
        }
        updateNeed(a.needId, patch, a.statement);
        const updated = store.need(a.needId)!;
        if (a.neverSuggest) {
          out.changes.push(`${c.emoji} ${c.label}: לא להציע יותר (קבוע)`);
          if (store.basket()?.items.some((i) => i.needId === a.needId)) svc.removeItem(a.needId, false);
        } else if (a.flexibility || a.preferredBrands) {
          out.changes.push(`${c.emoji} ${c.label}: ${FLEX_LABEL[updated.flexibility]}${updated.preferredBrands.length ? ` (${updated.preferredBrands.join(', ')})` : ''}${updated.forbiddenBrands.length ? ` · בלי ${updated.forbiddenBrands.join(', ')}` : ''} — קבוע`);
        } else if (a.dealSensitivity) {
          out.changes.push(`${c.emoji} ${c.label}: אראה לכם כשיש מחיר טוב`);
        }
        stateTouched = true;
        break;
      }
      case 'setBudget': {
        svc.setBudget(a.cap);
        out.changes.push(a.cap ? `💰 תקרה לסל הזה: ₪${a.cap}` : '💰 הסרתי את התקרה');
        stateTouched = true;
        break;
      }
      case 'removeBasketItem': {
        const c = getConcept(a.needId);
        svc.removeItem(a.needId, a.temporary);
        out.changes.push(`${c.emoji} ${c.label}: ${a.temporary ? 'לא בקנייה הזאת (רק הפעם)' : 'הוסר'}`);
        const n = store.need(a.needId);
        if (n && n.removedCount >= 2 && !n.neverSuggest) {
          out.components.push({
            type: 'learning', needId: a.needId, text: `שמתי לב שאתם מורידים ${c.label} כבר ${n.removedCount} פעמים. להפסיק להכניס את זה?`,
            options: [{ label: 'כן, תפסיק', send: `#never ${a.needId}` }, { label: 'לא, רק הפעם', send: '#noop' }],
          });
        }
        basketHandled = true;
        break;
      }
      case 'generateBasket': {
        const pending = kvGet<Pending>('pendingCheckin');
        if (!a.skipCheckin) {
          const qs = checkInQuestions(a.horizonDays, store.basket()?.status === 'building' ? store.basket()!.tempSkips : []);
          if (qs.length) {
            for (const q of qs) updateNeed(q.needId, { lastAskedAt: nowIso() });
            kvSet('pendingCheckin', { horizon: a.horizonDays, needIds: qs.map((q) => q.needId) } satisfies Pending);
            out.lines.push(qs.length === 1 ? 'רגע לפני שאני בונה — שאלה אחת:' : `רגע לפני שאני בונה — ${qs.length} שאלות קצרות:`);
            for (const q of qs) out.components.push({ type: 'question', question: q });
            out.components.push({ type: 'quick_replies', options: [{ label: 'פשוט תבנה', send: `#build ${a.horizonDays} force` }] });
            basketHandled = true;
            break;
          }
        }
        if (pending) kvSet('pendingCheckin', null);
        await build(out, a.horizonDays);
        basketHandled = true;
        break;
      }
      case 'addBasketItem': {
        // Unknown product ("שים גם חרדל"): look it up first — never add a name we can't find without asking.
        if (!a.needId && a.newLabel && !a.force) {
          const r = await svc.searchProducts(a.newLabel);
          focusLabel = a.newLabel;
          if (r.concept) { a.needId = r.concept.id; }
          else if (!r.results.length) {
            out.lines.push(r.failures.length && r.failures.length >= 2 ? `לא הצלחתי לבדוק את "${a.newLabel}" כרגע (${r.failures.join(', ')} לא ענו).` : `לא מצאתי "${a.newLabel}" ברשתות שלכם.`);
            out.components.push({ type: 'quick_replies', options: [{ label: 'להוסיף לרשימה בכל זאת', send: `#addlabel ${a.newLabel}` }, { label: 'לא, עזוב', send: '#noop' }] });
            break;
          } else {
            const best = [...r.results].filter((x) => !x.ambiguous).sort((x, y) => (x.promoPrice ?? x.price) - (y.promoPrice ?? y.price))[0] ?? r.results[0];
            const { item } = await svc.addItem({ newLabel: a.newLabel, quantity: a.quantity, conditional: a.conditional, product: { providerId: best.providerId, productId: best.productId } });
            out.changes.push(`${item.emoji} ${item.label}: ${item.quantity} × ${productLine(best)} · ₪${best.promoPrice ?? best.price} ב${best.providerName}`);
            out.components.push({ type: 'quick_replies', options: [{ label: 'לבחור מוצר אחר', send: `@open:add:${a.newLabel}` }] });
            focusIds.push(item.needId);
            basketHandled = true;
            break;
          }
        }
        const { item } = await svc.addItem(a);
        const price = item.product ? ` · ${productLine(item.product)} · ₪${item.product.price}${item.product.promoText ? ` (${item.product.promoText})` : ''}` : '';
        if (item.condition) {
          out.changes.push(`${item.emoji} ${item.label}: ${item.condition.met ? `${item.quantity} × ${item.unit} נכנסו לסל — ${item.condition.note}` : item.condition.met === false ? `מחכה למחיר טוב — ${item.condition.note}` : 'נכנס בתנאי שיהיה מחיר טוב (אבדוק כשיהיו מחירים)'}`);
        } else out.changes.push(`${item.emoji} ${item.label}: ${item.quantity} × ${item.unit}${price}`);
        focusIds.push(item.needId);
        basketHandled = true;
        break;
      }
      case 'updateBasketQuantity': {
        const c = getConcept(a.needId);
        const cur = store.basket()?.items.find((i) => i.needId === a.needId);
        const target = a.quantity ?? Math.max(0, (cur?.quantity ?? 0) + (a.delta ?? 0));
        if (target <= 0) {
          svc.removeItem(a.needId, true);
          out.changes.push(`${c.emoji} ${c.label}: הורד מהסל (רק הפעם)`);
        } else if (cur) {
          svc.setQuantity(a.needId, target);
          out.changes.push(`${c.emoji} ${c.label}: ${fmt(target)} × ${c.packLabel}`);
        } else {
          const { item } = await svc.addItem({ needId: a.needId, quantity: target });
          out.changes.push(`${item.emoji} ${item.label}: ${item.quantity} × ${item.unit}`);
        }
        basketHandled = true;
        break;
      }
      case 'replaceBasketItem': {
        const c = getConcept(a.needId);
        try {
          const r = svc.replaceItem(a.needId);
          if (!r.product) out.lines.push(`לא מצאתי חלופה ל${c.label} כרגע.`);
          else {
            out.changes.push(`${c.emoji} ${c.label}: הוחלף ל־${r.product.name}`);
            maybeFlexCard(out, a.needId, r.replacements);
          }
        } catch {
          // Not in the basket: show the options instead of a dead end.
          const r = await svc.searchProducts(c.label);
          const rows = [...r.results].sort((x, y) => (x.promoPrice ?? x.price) - (y.promoPrice ?? y.price)).slice(0, 5);
          if (rows.length) {
            out.lines.push(`${c.label} לא בסל כרגע — הנה אפשרויות:`);
            out.components.push({ type: 'prices', title: c.label, rows: rows.map((x) => ({ provider: x.providerName, name: productLine(x), price: x.promoPrice ?? x.price, promoText: x.promoText, source: x.source })), failures: r.failures });
            out.components.push({ type: 'quick_replies', options: [{ label: 'לבחור מוצר', send: `@open:add:${c.label}` }] });
          } else out.lines.push(`${c.label} לא בסל כרגע, ולא מצאתי חלופות.`);
        }
        basketHandled = true;
        break;
      }
      case 'searchProductPrices': {
        if (a.needId) {
          const r = await svc.priceLookup(a.needId);
          if (!r.rows.length) out.lines.push(r.failures.length ? `לא הצלחתי לקבל מחירים ל${r.concept.label} (${r.failures.join(', ')} לא זמינות כרגע).` : `לא מצאתי ${r.concept.label} ברשתות שלכם.`);
          else {
            out.lines.push(`${r.concept.emoji} הכי זול ${r.concept.label} כרגע: ${r.rows[0].name} ב${r.rows[0].provider} — ₪${r.rows[0].price}`);
            out.components.push({ type: 'prices', title: r.concept.label, rows: r.rows, failures: r.failures });
            out.components.push({ type: 'quick_replies', options: [{ label: `תוסיף ${r.concept.label}`, send: `#add ${a.needId}` }] });
          }
          break;
        }
        // A category ("איזה דג זול", "איזה עוף הכי משתלם"): the cheapest of each known need in it.
        if (a.category || a.subGroup) {
          const ids = allConcepts().filter((c) => (a.category && c.category === a.category) || (a.subGroup && c.subGroup === a.subGroup)).map((c) => c.id).slice(0, 5);
          const found = (await Promise.all(ids.map((id) => svc.priceLookup(id)))).filter((r) => r.rows.length);
          if (found.length) {
            const rows = found.map((r) => ({ ...r.rows[0], name: `${r.concept.emoji} ${r.concept.label}: ${r.rows[0].name}` })).sort((x, y) => x.price - y.price);
            out.lines.push(`${a.category === 'fish' ? 'דגים' : a.subGroup === 'chicken' ? 'עוף' : 'המוצרים'} — הכי זול כרגע בכל סוג (המחיר לאריזה / לק״ג):`);
            out.components.push({ type: 'prices', title: 'הכי זול לפי סוג', rows, failures: found[0].failures });
            out.components.push({ type: 'quick_replies', options: found.slice(0, 3).map((r) => ({ label: `תוסיף ${r.concept.label}`, send: `#add ${r.concept.id}` })) });
            break;
          }
        }
        // Free text ("תחפש לי חרדל").
        const q = a.query || 'מוצר';
        const r = await svc.searchProducts(q);
        const rows = [...r.results].sort((x, y) => (x.promoPrice ?? x.price) - (y.promoPrice ?? y.price)).slice(0, 6);
        focusLabel = r.concept ? undefined : q;
        if (r.concept) focusIds.push(r.concept.id);
        if (!rows.length) {
          out.lines.push(r.failures.length >= 2 ? `לא הצלחתי לבדוק כרגע (${r.failures.join(', ')} לא ענו).` : `לא מצאתי "${q}" ברשתות שלכם.`);
          break;
        }
        out.lines.push(`${a.category || a.subGroup ? 'הכי זולים כרגע' : `מצאתי ${r.results.length} מוצרים ל"${q}"`} — המחיר לאריזה, אז שימו לב לגודל:`);
        out.components.push({ type: 'prices', title: r.concept?.label ?? q, rows: rows.map((x) => ({ provider: x.providerName, name: productLine(x), price: x.promoPrice ?? x.price, promoText: x.promoText, source: x.source })), failures: r.failures });
        out.components.push({ type: 'quick_replies', options: [
          { label: r.concept ? `תוסיף ${r.concept.label}` : `תוסיף ${q} (הכי משתלם)`, send: r.concept ? `#add ${r.concept.id}` : `שים ${q}` },
          { label: 'לבחור בעצמי', send: `@open:add:${q}` },
        ] });
        break;
      }
      case 'searchPromotions': {
        if (a.needId) {
          const r = await svc.priceLookup(a.needId);
          const promos = r.rows.filter((x) => x.promoText);
          if (promos.length) {
            out.lines.push(`יש מבצע על ${r.concept.label}:`);
            out.components.push({ type: 'prices', title: r.concept.label, rows: promos, failures: r.failures });
            out.components.push({ type: 'quick_replies', options: [{ label: 'תוסיף לסל', send: `#add ${a.needId}` }] });
          } else if (r.rows.length) {
            out.lines.push(`אין כרגע מבצע על ${r.concept.label}. הכי זול: ${r.rows[0].name} ב${r.rows[0].provider} — ₪${r.rows[0].price}.`);
          } else out.lines.push(`לא הצלחתי לבדוק את ${r.concept.label} כרגע.`);
        } else if (a.query) {
          const r = await svc.searchProducts(a.query);
          const promos = r.results.filter((x) => x.promoPrice || x.promoText).slice(0, 6);
          focusLabel = a.query;
          if (promos.length) {
            out.lines.push(`יש מבצעים על "${a.query}":`);
            out.components.push({ type: 'prices', title: a.query, rows: promos.map((x) => ({ provider: x.providerName, name: productLine(x), price: x.promoPrice ?? x.price, promoText: x.promoText, source: x.source })), failures: r.failures });
          } else out.lines.push(r.results.length ? `אין כרגע מבצע על "${a.query}".` : `לא מצאתי "${a.query}" ברשתות שלכם.`);
        } else {
          const { deals, failures } = await svc.getDeals();
          const list = a.stockUp ? deals.filter((d) => d.kind === 'stock') : deals;
          if (!list.length) out.lines.push(failures.length ? 'לא הצלחתי למשוך מבצעים כרגע.' : a.stockUp ? 'אין כרגע מבצע ששווה להצטייד בו — אין מוצר עמיד שאתם קונים במחיר חריג.' : 'אין כרגע מבצעים ששווים משהו בשבילכם.');
          else {
            out.lines.push(a.stockUp ? 'ששווה להצטייד בהם:' : 'הנה מה שבאמת שווה בשבילכם:');
            for (const d of list.slice(0, 3)) out.components.push({ type: 'deal', deal: d });
            out.components.push({ type: 'quick_replies', options: [{ label: `לכל המבצעים (${deals.length})`, send: '@open:deals' }] });
          }
        }
        break;
      }
      case 'compareProviders': {
        const b = store.basket();
        if (!b || b.status !== 'building' || !b.items.length) { out.lines.push('אין עדיין סל להשוות. לבנות אחד?'); out.components.push({ type: 'quick_replies', options: [{ label: 'בנה קנייה', send: '#build 14' }] }); break; }
        const cmp = await compareBasket(b);
        if (a.providerId) {
          const q = cmp.quotes.find((x) => x.providerId === a.providerId);
          const name = q?.providerName ?? providerName(a.providerId);
          if (!q) out.lines.push(`${name} לא ברשימת הרשתות שלכם — אפשר להוסיף אותה במסך "הבית".`);
          else if (!q.ok) out.lines.push(`לא הצלחתי לתמחר את הסל ב${name} כרגע${q.error ? ` (${q.error})` : ''}.`);
          else {
            const missing = q.lines.filter((l) => l.missing).length;
            out.lines.push(`ב${name} הסל יוצא ~₪${Math.round(q.total)}${q.kind === 'online' ? ` כולל משלוח ${q.deliveryFeeEstimated ? '~' : ''}₪${q.deliveryFee}${q.deliveryFeeEstimated ? ' (הערכה)' : ''}` : ''}, ${Math.round(q.completeness * 100)}% מהסל${missing ? ` (חסרים ${missing})` : ''}.`);
            const best = cmp.quotes.find((x) => x.providerId === cmp.recommendation.winnerId);
            if (best && best.providerId !== q.providerId) out.lines.push(`לשם השוואה, ${best.providerName}: ~₪${Math.round(best.total)}.`);
          }
        } else out.lines.push(cmp.recommendation.text);
        out.components.push({ type: 'quick_replies', options: [{ label: 'לפירוט ההשוואה', send: '@open:compare' }, { label: 'קניתי — לאשר', send: '@open:confirm' }] });
        saveContext({ lastIntent: 'compare', focusProviderId: a.providerId });
        break;
      }
      case 'askInsight': {
        out.lines.push(svc.insightAnswerFor(a.q, a.needId));
        out.components.push({ type: 'quick_replies', options: [{ label: 'לכל התובנות', send: '@open:insights' }] });
        break;
      }
      case 'clarify': {
        out.lines.push(a.question);
        const opts = a.options.length ? a.options : (store.basket()?.items ?? []).slice(0, 4).map((i) => ({ label: `${i.emoji} ${i.label}`, send: `${i.label}` }));
        if (opts.length) out.components.push({ type: 'quick_replies', options: opts });
        break;
      }
      case 'explainDecision': {
        if (a.about === 'store') out.lines.push(explainStoreChoice());
        else if (a.needId) {
          const b = store.basket();
          // "למה החלפת חזה עוף בפרגיות?" → explain the item that's actually in the basket.
          const inBasket = (a.needIds ?? [a.needId]).find((id) => b?.items.some((i) => i.needId === id && i.substitutedFrom)) ?? (a.needIds ?? [a.needId]).find((id) => b?.items.some((i) => i.needId === id)) ?? a.needId;
          out.lines.push(explainItem(inBasket, b));
        }
        else out.lines.push('על מה להסביר? אפשר לשאול "למה שמת טונה?" או "למה בחרת ברשת הזאת?"');
        break;
      }
      case 'showStock': {
        if (a.needId) {
          // A question ("יש לנו חלב?") — answer from the estimate, change nothing.
          const n = store.need(a.needId), c = getConcept(a.needId);
          const e = n ? estimateStock(n) : null;
          if (!n || !e?.known || e.confidence < 0.2) out.lines.push(`אין לי מספיק מידע על ${c.label} בבית. אם תגידו לי ("יש 2" / "נגמר"), אעדכן.`);
          else out.lines.push(e.qty <= 0.05 ? `לפי ההערכה שלי ${c.label} כנראה נגמר.` : `לפי ההערכה שלי נשאר ${qtyText(e.qty, c.stockUnit)} ${c.label}${e.confidence < 0.5 ? ' (הערכה גסה)' : ''}.`);
          out.components.push({ type: 'quick_replies', options: [{ label: 'נגמר', send: `נגמר ${c.label}` }, { label: 'יש קצת', send: `יש קצת ${c.label}` }, { label: 'יש הרבה', send: `יש הרבה ${c.label}` }] });
          break;
        }
        const rows = store.needs().filter((n) => n.active).map((n) => {
          const c = getConcept(n.id);
          const e = estimateStock(n);
          const text = !e.known ? 'לא יודע' : e.qty <= 0.01 ? 'נגמר' : e.qty > n.typical14DayQty * 1.2 ? `הרבה (${qtyText(e.qty, c.stockUnit)})` : `${qtyText(e.qty, c.stockUnit)}`;
          return { needId: n.id, emoji: c.emoji, label: c.label, text, value: e.qty, unit: c.stockUnit, conf: e.confidence };
        }).sort((x, y) => x.value / (store.need(x.needId)!.typical14DayQty || 1) - y.value / (store.need(y.needId)!.typical14DayQty || 1));
        out.lines.push('אני מעריך שנשאר:');
        out.components.push({ type: 'stock_confirm', rows: rows.slice(0, 10).map(({ conf: _c, ...r }) => r) });
        break;
      }
      case 'confirmPurchase': {
        out.lines.push('מעולה! בוא נסמן מה בפועל נקנה, כדי שאלמד לפעם הבאה.');
        out.components.push({ type: 'quick_replies', options: [{ label: 'לאישור הקנייה', send: '@open:confirm' }] });
        break;
      }
      case 'help': {
        out.lines.push('לא בטוח שהבנתי 🙂 אפשר למשל:');
        out.components.push({ type: 'quick_replies', options: [
          { label: 'בנה קנייה', send: '#build 14' }, { label: 'מה חסר בבית?', send: 'מה חסר בבית?' },
          { label: 'מבצעים', send: '#deals' }, { label: 'איפה הכי זול?', send: '#compare' },
        ] });
        break;
      }
    }
  }

  // Stock/preference changes while a basket is open → rebuild so Basket always reflects state.
  const b = store.basket();
  if (stateTouched && !basketHandled && b?.status === 'building' && b.items.length) {
    await build(out, b.horizonDays, true);
  }
  // Answered the last check-in question → build.
  const pending = kvGet<Pending>('pendingCheckin');
  if (pending && pending.needIds.length === 0) {
    kvSet('pendingCheckin', null);
    await build(out, pending.horizon);
  } else if (pending && actions.every((x) => x.type === 'updateHouseholdStock')) {
    out.components.push({ type: 'quick_replies', options: [{ label: 'פשוט תבנה', send: `#build ${pending.horizon} force` }] });
  }

  // Remember what we just talked about, for "זה" / "אותו" / "תוסיף 2" next turn.
  const lastNeed = focusIds[focusIds.length - 1];
  if (lastNeed || focusLabel) saveContext({ focusNeedId: lastNeed, focusLabel, lastIntent: actions[actions.length - 1]?.type });
  if (out.changes.length) out.components.unshift({ type: 'state_change', changes: out.changes });
  if (!out.lines.length && out.changes.length) out.lines.push(pick(['רשמתי ✓', 'עודכן ✓', 'סגור ✓']));
  return { id: uid('m_'), role: 'assistant', text: out.lines.join('\n'), components: out.components, createdAt: nowIso() };
}

async function build(out: Out, horizon: number, quiet = false) {
  const { basket, failures } = await svc.buildBasket(horizon);
  const s = svc.basketSummary(basket);
  if (quiet) {
    out.lines.push(`עדכנתי את הסל (${s.items} פריטים${s.total ? `, ~₪${s.total}` : ''}).`);
    for (const n of basket.notes.filter((x) => x.includes('תקרה'))) out.lines.push(n);
    return;
  }
  out.lines.push(s.items ? `בניתי סל ל־${horizon} ימים 👇` : 'נראה שיש לכם הכול בבית כרגע 🙂');
  if (failures.length) out.lines.push(failures.map((f) => `${f.name} לא החזירה מחיר כרגע.`).join(' ') + ' המשכתי עם שאר הרשתות.');
  if (!basket.priced) out.lines.push('בלי מחירים כרגע — בניתי לפי צריכה ומלאי.');
  for (const n of basket.notes.filter((x) => !x.includes('לא החזירה'))) out.lines.push(n);
  out.components.push({ type: 'basket_summary', ...s });
  out.components.push({ type: 'quick_replies', options: [{ label: 'פתח סל', send: '@open:basket' }, { label: 'השווה רשתות', send: '#compare' }] });
}

function resolvePending(needId: string) {
  const p = kvGet<Pending>('pendingCheckin');
  if (p && p.needIds.includes(needId)) kvSet('pendingCheckin', { ...p, needIds: p.needIds.filter((x) => x !== needId) });
}

function maybeFlexCard(out: Out, needId: string, replacements: number) {
  const n = store.need(needId);
  if (!n || replacements < 1 || n.flexConfidence >= 0.9) return;
  const c = getConcept(needId);
  out.components.push({
    type: 'learning', needId,
    text: `שמתי לב שהחלפת את ה${c.label} שבחרתי. ב${c.label}, מה יותר חשוב לך?`,
    options: [
      { label: 'הכי זול', send: `#flex ${needId} category_flexible` },
      { label: 'יש כמה מותגים שאני אוהב', send: `#flex ${needId} brand_flexible` },
      { label: 'אלמד בהמשך', send: '#noop' },
    ],
  });
}

/** Commands from UI cards that bypass parsing. */
export async function executeCommand(cmd: string, args: string[]): Promise<ChatMessage | null> {
  const [a, b] = args;
  switch (cmd) {
    case 'stock': {
      if (b === 'unknown') {
        resolvePending(a);
        logEvent({ type: 'stock_report', needId: a, value: 'unknown' });
        return executeActions([]);
      }
      return executeActions([{ type: 'updateHouseholdStock', needId: a, level: b as never }]);
    }
    case 'setstock': return executeActions([{ type: 'updateHouseholdStock', needId: a, qty: parseFloat(b) }]);
    case 'never': return executeActions([{ type: 'updatePreference', needId: a, neverSuggest: true, active: false, statement: 'כרטיס למידה: להפסיק להציע' }]);
    case 'flex': {
      const n = updateNeed(a, { flexibility: b as Flexibility, flexConfidence: 0.95 }, `כרטיס למידה: ${b}`);
      return { id: uid('m_'), role: 'assistant', text: `הבנתי. ${flexText(n)}`, components: [{ type: 'state_change', changes: [`${n.emoji} ${n.label}: ${FLEX_LABEL[n.flexibility]} — קבוע`] }], createdAt: nowIso() };
    }
    case 'noop': return { id: uid('m_'), role: 'assistant', text: 'סבבה 👍', createdAt: nowIso() };
    case 'stockok': {
      for (const n of store.needs().filter((x) => x.active)) {
        const e = estimateStock(n);
        if (e.known) setStock(n.id, e.qty, Math.max(e.confidence, 0.7), 'אישור הערכה');
      }
      return { id: uid('m_'), role: 'assistant', text: 'מעולה, אישרתי את ההערכה ✓', createdAt: nowIso() };
    }
    case 'deal': {
      // #deal take NEED QTY | #deal skip DEALID NEED
      if (a === 'take') return executeActions([{ type: 'addBasketItem', needId: b, quantity: parseFloat(args[2] ?? '1') }]);
      if (a === 'skip') { svc.dismissDeal(b, args[2]); return { id: uid('m_'), role: 'assistant', text: 'הבנתי, פחות כאלה 👍', createdAt: nowIso() }; }
      return null;
    }
  }
  return null;
}

const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
