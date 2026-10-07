// Optional LLM interpretation layer. Claude only maps the message to typed actions (tool calls);
// application code executes them and writes the factual replies. Without ANTHROPIC_API_KEY the
// deterministic parser is used instead.
import Anthropic from '@anthropic-ai/sdk';
import type { Flexibility, Level } from '../../shared/types.ts';
import { allConcepts } from '../state.ts';
import { store } from '../db.ts';
import type { Action, InsightQuestion, StockLevel } from './actions.ts';
import { findNumber, normalize } from './parser.ts';
import type { ChatContext } from './context.ts';

export const llmEnabled = () => !!process.env.ANTHROPIC_API_KEY && process.env.KANITI_LLM !== '0';

let client: Anthropic | null = null;
const MODEL = process.env.KANITI_MODEL ?? 'claude-opus-5-5';

const need = { type: 'string', description: 'Concept id from the catalog, e.g. EGGS, TUNA' };
const tools: Anthropic.Beta.BetaTool[] = [
  { name: 'update_stock', description: 'User reports how much of something is at home ("יש 10 ביצים", "אין טונה", "יש מלא פסטה"). Use qty for exact numbers in stock units, else level.', input_schema: { type: 'object', properties: { need_id: need, qty: { type: 'number' }, level: { type: 'string', enum: ['none', 'little', 'some', 'lots'] } }, required: ['need_id'] } },
  { name: 'update_preference', description: 'A LASTING preference about a product ("לא אכפת לי איזה מרכך" → category_flexible; "רק קוקה קולה זירו" → exact_product + preferred brand; "אל תציע לי X" → never_suggest; "אני לא אוהב את הטונה הזאת" → dislike_current).', input_schema: { type: 'object', properties: { need_id: need, flexibility: { type: 'string', enum: ['exact_product', 'brand_flexible', 'category_flexible', 'exploratory'] }, preferred_brands: { type: 'array', items: { type: 'string' } }, forbidden_brands: { type: 'array', items: { type: 'string' } }, never_suggest: { type: 'boolean' }, deal_sensitivity: { type: 'string', enum: ['low', 'medium', 'high'] }, dislike_current: { type: 'boolean' }, variant: { type: 'string', description: 'A variant the user said that the product name must contain ("1%", "במים", "ללא לקטוז") — the user\'s exact words' }, about_current_item: { type: 'boolean', description: 'true when the user refers to "this brand/product" without naming it' } } } },
  { name: 'add_item', description: 'Add something to the current basket. only_if_good_price for "אם יש מבצע/מחיר טוב". Use new_label only if nothing in the catalog fits.', input_schema: { type: 'object', properties: { need_id: need, new_label: { type: 'string' }, quantity: { type: 'number', description: 'packs' }, variant: { type: 'string', description: 'A variant the user said that the product name must contain ("1%", "במים", "ללא לקטוז") — the user\'s exact words' }, only_if_good_price: { type: 'boolean' } } } },
  { name: 'remove_item', description: 'Remove from basket. temporary=true for "הפעם"/this shop only (the default); permanent dislikes go to update_preference.', input_schema: { type: 'object', properties: { need_id: need, temporary: { type: 'boolean' } }, required: ['need_id', 'temporary'] } },
  { name: 'set_quantity', description: 'Change quantity (packs) of a basket item: absolute quantity, or delta (+1/-1 for "עוד/פחות").', input_schema: { type: 'object', properties: { need_id: need, quantity: { type: 'number' }, delta: { type: 'number' } }, required: ['need_id'] } },
  { name: 'replace_item', description: 'Swap the chosen product for an alternative.', input_schema: { type: 'object', properties: { need_id: need }, required: ['need_id'] } },
  { name: 'build_basket', description: 'Build/rebuild the shopping basket ("תבנה לי קנייה לשבועיים").', input_schema: { type: 'object', properties: { horizon_days: { type: 'number' } }, required: ['horizon_days'] } },
  { name: 'compare_stores', description: 'Compare the current basket across stores ("איפה הכי משתלם להזמין?"), or the total at ONE store ("כמה ייצא ברמי לוי?" → provider_id).', input_schema: { type: 'object', properties: { provider_id: { type: 'string' } } } },
  { name: 'price_lookup', description: 'Where is X cheapest / how much does X cost. need_id for catalog items; query (the user\'s own words) for anything else ("חרדל"); category fish/meat/produce or sub_group chicken for "איזה דג זול".', input_schema: { type: 'object', properties: { need_id: need, variant: { type: 'string', description: 'A variant the user said that the product name must contain ("1%", "במים", "ללא לקטוז") — the user\'s exact words' }, query: { type: 'string' }, category: { type: 'string' }, sub_group: { type: 'string' } } } },
  { name: 'promotions', description: 'Is there a deal on X (need_id or query), general deals if neither; stock_up for "ששווה לעשות סטוק".', input_schema: { type: 'object', properties: { need_id: need, variant: { type: 'string', description: 'A variant the user said that the product name must contain ("1%", "במים", "ללא לקטוז") — the user\'s exact words' }, query: { type: 'string' }, stock_up: { type: 'boolean' } } } },
  { name: 'ask_insight', description: 'Questions about the household\'s own history: spend_month (כמה הוצאנו החודש), spend_last_month (בחודש שעבר), last_shop (כמה עלתה הקנייה האחרונה), top_category (על מה מוציאים), savings (כמה חסכתי), when_shop (מתי כדאי לקנות), fastest (מה נגמר מהר), overbuy (קונים יותר מדי), cheap_day (איזה יום זול), lasts (כמה זמן X מחזיק, with need_id).', input_schema: { type: 'object', properties: { question: { type: 'string', enum: ['spend_month', 'spend_last_month', 'last_shop', 'top_category', 'savings', 'when_shop', 'fastest', 'overbuy', 'cheap_day', 'lasts'] }, need_id: need }, required: ['question'] } },
  { name: 'explain', description: 'Why is X in the basket / why this quantity / why this store (about_store).', input_schema: { type: 'object', properties: { need_id: need, about_store: { type: 'boolean' } } } },
  { name: 'set_budget', description: 'Cap for this basket ("אל תעבור 650").', input_schema: { type: 'object', properties: { cap: { type: 'number' } }, required: ['cap'] } },
  { name: 'show_stock', description: 'What is probably missing / what do we have at home.', input_schema: { type: 'object', properties: {} } },
  { name: 'confirm_purchase', description: 'User says they bought/ordered.', input_schema: { type: 'object', properties: {} } },
  { name: 'this_time_only', description: 'A TEMPORARY instruction for the current shop only: "אל תקנה X הפעם" (mode skip) or "הפעם אני רוצה X" (mode include). Does not change habits.', input_schema: { type: 'object', properties: { need_id: need, mode: { type: 'string', enum: ['skip', 'include'] }, quantity: { type: 'number' } }, required: ['need_id', 'mode'] } },
  { name: 'prepare_cart', description: 'Prepare the real online cart at a supermarket ("תכין לי עגלה בשופרסל"). provider_id one of: shufersal, ramilevy, victory, ybitan, carrefour, tivtaam, keshet, quik. Omit to use the recommended store. Never places an order.', input_schema: { type: 'object', properties: { provider_id: { type: 'string' } } } },
  { name: 'clarify', description: 'When the message is genuinely unclear: ONE short Hebrew question, optionally with up to 4 short answer options. Never state prices, totals, stock or deals here.', input_schema: { type: 'object', properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } }, required: ['question'] } },
];

function systemPrompt() {
  const catalog = allConcepts().map((c) => `${c.id}: ${c.label}${c.brands.length ? ` (brands: ${c.brands.join(', ')})` : ''}`).join('\n');
  return `You interpret Hebrew messages for a private household grocery app. Never answer from your own knowledge about prices, stock or the basket — call tools; the app computes everything and writes the factual reply.
Call every tool the message implies (several in one turn is fine), using catalog ids. Distinguish temporary instructions ("הפעם", "בקנייה הזאת", "עזוב") from lasting ones ("מעכשיו", "אף פעם", "תמיד"). "Only if cheap" adds are add_item with only_if_good_price — never a preference. Words like "זה/אותו/בזה" refer to the item in focus. If it's genuinely unclear, call clarify with one question.

Catalog:
${catalog}`;
}

type In = Record<string, unknown>;
const s = (v: unknown) => (typeof v === 'string' ? v : undefined);
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

const inText = (text: string, v?: string) => !!v && normalize(text).includes(normalize(v));
/** A variant is kept only if the user actually said it. */
const said = (text: string, v: unknown) => (typeof v === 'string' && normalize(text).replace(/\s+/g, '').includes(normalize(v).replace(/\s+/g, '')) ? v : undefined);
/** Numbers the model returns must be numbers the user actually said (or obvious ±1). */
const saidNumber = (text: string, v?: number) => v === undefined || findNumber(text) === v || normalize(text).includes(String(v));

function toAction(name: string, i: In, text: string): Action | { say: string; options?: string[] } | null {
  const id = s(i.need_id);
  const valid = id && allConcepts().some((c) => c.id === id) ? id : undefined;
  switch (name) {
    case 'update_stock': return valid ? { type: 'updateHouseholdStock', needId: valid, qty: n(i.qty), level: s(i.level) as StockLevel | undefined, raw: text } : null;
    case 'update_preference': return valid || i.about_current_item ? {
      type: 'updatePreference', needId: valid ?? 'FOCUS', flexibility: s(i.flexibility) as Flexibility | undefined,
      preferredBrands: Array.isArray(i.preferred_brands) ? (i.preferred_brands as string[]) : undefined,
      forbiddenBrands: Array.isArray(i.forbidden_brands) ? (i.forbidden_brands as string[]) : undefined,
      neverSuggest: i.never_suggest === true ? true : undefined, active: i.never_suggest === true ? false : undefined,
      dealSensitivity: s(i.deal_sensitivity) as Level | undefined, dislikeCurrent: i.dislike_current === true, variant: said(text, i.variant), statement: text,
    } : null;
    case 'add_item': {
      const label = valid ? undefined : s(i.new_label);
      if (!valid && !inText(text, label)) return null; // an unknown product must be the user's own words
      return { type: 'addBasketItem', needId: valid, variant: valid ? said(text, i.variant) : undefined, newLabel: label, quantity: saidNumber(text, n(i.quantity)) ? n(i.quantity) : undefined, conditional: i.only_if_good_price ? 'good_price' : undefined };
    }
    case 'remove_item': return valid ? { type: 'removeBasketItem', needId: valid, temporary: i.temporary !== false } : null;
    case 'set_quantity': {
      const q = n(i.quantity), d = n(i.delta);
      if (!valid || (q === undefined && d === undefined) || (q !== undefined && !saidNumber(text, q))) return null;
      return { type: 'updateBasketQuantity', needId: valid, quantity: q, delta: q === undefined ? Math.sign(d!) : undefined };
    }
    case 'replace_item': return valid ? { type: 'replaceBasketItem', needId: valid } : null;
    case 'build_basket': return { type: 'generateBasket', horizonDays: Math.min(30, Math.max(3, n(i.horizon_days) ?? 14)) };
    case 'compare_stores': return { type: 'compareProviders', providerId: s(i.provider_id) };
    case 'price_lookup': {
      if (valid) return { type: 'searchProductPrices', needId: valid, variant: said(text, i.variant), query: valid };
      const cat = s(i.category), sub = s(i.sub_group), q = s(i.query);
      if (cat || sub) return { type: 'searchProductPrices', query: q && inText(text, q) ? q : cat === 'fish' ? 'פילה דג' : sub === 'chicken' ? 'עוף' : (cat ?? ''), category: cat, subGroup: sub };
      return q && inText(text, q) ? { type: 'searchProductPrices', query: q } : null;
    }
    case 'promotions': return { type: 'searchPromotions', needId: valid, variant: valid ? said(text, i.variant) : undefined, query: !valid && inText(text, s(i.query)) ? s(i.query) : undefined, stockUp: i.stock_up === true || undefined };
    case 'ask_insight': return s(i.question) ? { type: 'askInsight', q: s(i.question) as InsightQuestion, needId: valid } : null;
    case 'explain': return { type: 'explainDecision', needId: valid, needIds: Array.isArray(i.need_ids) ? (i.need_ids as string[]) : undefined, about: i.about_store ? 'store' : undefined };
    case 'set_budget': return n(i.cap) && saidNumber(text, n(i.cap)) ? { type: 'setBudget', cap: n(i.cap)! } : null;
    case 'show_stock': return { type: 'showStock' };
    case 'confirm_purchase': return { type: 'confirmPurchase' };
    case 'this_time_only': return valid ? { type: 'setTemporaryInstruction', needId: valid, mode: i.mode === 'include' ? 'include' : 'skip', quantity: n(i.quantity) } : null;
    case 'prepare_cart': return { type: 'prepareProviderCart', providerId: s(i.provider_id) };
    case 'clarify': {
      const q = s(i.question);
      // A question only — never figures (prices/totals/stock must come from the app).
      if (!q || /[₪\d]/.test(q)) return null;
      return { say: q, options: Array.isArray(i.options) ? (i.options as unknown[]).filter((o): o is string => typeof o === 'string' && !/[₪\d]/.test(o)).slice(0, 4) : undefined };
    }
  }
  return null;
}

export async function interpretWithLlm(text: string, ctx: ChatContext | null = null): Promise<{ actions: Action[]; say?: string; options?: string[] }> {
  client ??= new Anthropic();
  const basket = store.basket();
  const recent = store.chat().slice(-4).map((m) => `${m.role === 'user' ? 'User' : 'App'}: ${m.text.slice(0, 160)}`).join('\n');
  const context = [
    basket?.status === 'building' && basket.items.length ? `Current basket: ${basket.items.map((i) => `${i.needId}×${i.quantity}`).join(', ')}` : 'No basket in progress.',
    ctx?.focusNeedId ? `Item in focus (for "זה/אותו/בזה"): ${ctx.focusNeedId}` : ctx?.focusLabel ? `Item in focus: ${ctx.focusLabel}` : '',
    recent ? `Recent conversation:\n${recent}` : '',
  ].filter(Boolean).join('\n');
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 2000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low' },
    system: [{ type: 'text', text: systemPrompt(), cache_control: { type: 'ephemeral' } }],
    tools,
    tool_choice: { type: 'auto' },
    messages: [{ role: 'user', content: `${context}\n\nMessage: ${text}` }],
  });
  if (response.stop_reason === 'refusal') return { actions: [] };
  const actions: Action[] = [];
  let say: string | undefined;
  let options: string[] | undefined;
  for (const block of response.content) {
    if (block.type !== 'tool_use') continue;
    const a = toAction(block.name, (block.input ?? {}) as In, text);
    if (!a) continue; // failed validation → dropped (the rule parser takes over if nothing is left)
    if ('say' in a) { say = a.say; options = a.options; }
    else actions.push(a);
  }
  return { actions, say, options };
}
