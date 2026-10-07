// Optional LLM interpretation layer. Claude only maps the message to typed actions (tool calls);
// application code executes them and writes the factual replies. Without ANTHROPIC_API_KEY the
// deterministic parser is used instead.
import Anthropic from '@anthropic-ai/sdk';
import type { Flexibility, Level } from '../../shared/types.ts';
import { allConcepts } from '../state.ts';
import { store } from '../db.ts';
import type { Action, StockLevel } from './actions.ts';

export const llmEnabled = () => !!process.env.ANTHROPIC_API_KEY && process.env.KANITI_LLM !== '0';

let client: Anthropic | null = null;
const MODEL = process.env.KANITI_MODEL ?? 'claude-opus-5-5';

const need = { type: 'string', description: 'Concept id from the catalog, e.g. EGGS, TUNA' };
const tools: Anthropic.Beta.BetaTool[] = [
  { name: 'update_stock', description: 'User reports how much of something is at home ("יש 10 ביצים", "אין טונה", "יש מלא פסטה"). Use qty for exact numbers in stock units, else level.', input_schema: { type: 'object', properties: { need_id: need, qty: { type: 'number' }, level: { type: 'string', enum: ['none', 'little', 'some', 'lots'] } }, required: ['need_id'] } },
  { name: 'update_preference', description: 'A LASTING preference about a product ("לא אכפת לי איזה מרכך" → category_flexible; "רק קוקה קולה זירו" → exact_product + preferred brand; "אל תציע לי X" → never_suggest; "אני לא אוהב את הטונה הזאת" → dislike_current).', input_schema: { type: 'object', properties: { need_id: need, flexibility: { type: 'string', enum: ['exact_product', 'brand_flexible', 'category_flexible', 'exploratory'] }, preferred_brands: { type: 'array', items: { type: 'string' } }, forbidden_brands: { type: 'array', items: { type: 'string' } }, never_suggest: { type: 'boolean' }, deal_sensitivity: { type: 'string', enum: ['low', 'medium', 'high'] }, dislike_current: { type: 'boolean' } }, required: ['need_id'] } },
  { name: 'add_item', description: 'Add something to the current basket. only_if_good_price for "אם יש מבצע/מחיר טוב". Use new_label only if nothing in the catalog fits.', input_schema: { type: 'object', properties: { need_id: need, new_label: { type: 'string' }, quantity: { type: 'number', description: 'packs' }, only_if_good_price: { type: 'boolean' } } } },
  { name: 'remove_item', description: 'Remove from basket. temporary=true for "הפעם"/this shop only (the default); permanent dislikes go to update_preference.', input_schema: { type: 'object', properties: { need_id: need, temporary: { type: 'boolean' } }, required: ['need_id', 'temporary'] } },
  { name: 'set_quantity', description: 'Change quantity (packs) of a basket item.', input_schema: { type: 'object', properties: { need_id: need, quantity: { type: 'number' } }, required: ['need_id', 'quantity'] } },
  { name: 'replace_item', description: 'Swap the chosen product for an alternative.', input_schema: { type: 'object', properties: { need_id: need }, required: ['need_id'] } },
  { name: 'build_basket', description: 'Build/rebuild the shopping basket ("תבנה לי קנייה לשבועיים").', input_schema: { type: 'object', properties: { horizon_days: { type: 'number' } }, required: ['horizon_days'] } },
  { name: 'compare_stores', description: 'Compare the current basket across stores ("איפה הכי משתלם להזמין?").', input_schema: { type: 'object', properties: {} } },
  { name: 'price_lookup', description: 'Where is X cheapest / how much does X cost.', input_schema: { type: 'object', properties: { need_id: need }, required: ['need_id'] } },
  { name: 'promotions', description: 'Is there a deal on X, or general deals if no need_id.', input_schema: { type: 'object', properties: { need_id: need } } },
  { name: 'explain', description: 'Why is X in the basket / why this quantity / why this store (about_store).', input_schema: { type: 'object', properties: { need_id: need, about_store: { type: 'boolean' } } } },
  { name: 'set_budget', description: 'Cap for this basket ("אל תעבור 650").', input_schema: { type: 'object', properties: { cap: { type: 'number' } }, required: ['cap'] } },
  { name: 'show_stock', description: 'What is probably missing / what do we have at home.', input_schema: { type: 'object', properties: {} } },
  { name: 'confirm_purchase', description: 'User says they bought/ordered.', input_schema: { type: 'object', properties: {} } },
  { name: 'reply', description: 'Short Hebrew reply when no action fits (small talk, a clarifying question).', input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
];

function systemPrompt() {
  const catalog = allConcepts().map((c) => `${c.id}: ${c.label}${c.brands.length ? ` (brands: ${c.brands.join(', ')})` : ''}`).join('\n');
  return `You interpret Hebrew messages for a private household grocery app. Never answer from your own knowledge about prices, stock or the basket — call tools; the app computes everything and writes the factual reply.
Call every tool the message implies (several in one turn is fine), using catalog ids. Distinguish temporary instructions ("הפעם", "this shop") from lasting preferences. If nothing fits, call reply with one short Hebrew sentence.

Catalog:
${catalog}`;
}

type In = Record<string, unknown>;
const s = (v: unknown) => (typeof v === 'string' ? v : undefined);
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function toAction(name: string, i: In, text: string): Action | { say: string } | null {
  const id = s(i.need_id);
  const valid = id && allConcepts().some((c) => c.id === id) ? id : undefined;
  switch (name) {
    case 'update_stock': return valid ? { type: 'updateHouseholdStock', needId: valid, qty: n(i.qty), level: s(i.level) as StockLevel | undefined, raw: text } : null;
    case 'update_preference': return valid ? {
      type: 'updatePreference', needId: valid, flexibility: s(i.flexibility) as Flexibility | undefined,
      preferredBrands: Array.isArray(i.preferred_brands) ? (i.preferred_brands as string[]) : undefined,
      forbiddenBrands: Array.isArray(i.forbidden_brands) ? (i.forbidden_brands as string[]) : undefined,
      neverSuggest: i.never_suggest === true ? true : undefined, active: i.never_suggest === true ? false : undefined,
      dealSensitivity: s(i.deal_sensitivity) as Level | undefined, dislikeCurrent: i.dislike_current === true, statement: text,
    } : null;
    case 'add_item': return valid || s(i.new_label) ? { type: 'addBasketItem', needId: valid, newLabel: valid ? undefined : s(i.new_label), quantity: n(i.quantity), conditional: i.only_if_good_price ? 'good_price' : undefined } : null;
    case 'remove_item': return valid ? { type: 'removeBasketItem', needId: valid, temporary: i.temporary !== false } : null;
    case 'set_quantity': return valid && n(i.quantity) !== undefined ? { type: 'updateBasketQuantity', needId: valid, quantity: n(i.quantity)! } : null;
    case 'replace_item': return valid ? { type: 'replaceBasketItem', needId: valid } : null;
    case 'build_basket': return { type: 'generateBasket', horizonDays: Math.min(30, Math.max(3, n(i.horizon_days) ?? 14)) };
    case 'compare_stores': return { type: 'compareProviders' };
    case 'price_lookup': return valid ? { type: 'searchProductPrices', needId: valid, query: valid } : null;
    case 'promotions': return { type: 'searchPromotions', needId: valid };
    case 'explain': return { type: 'explainDecision', needId: valid, about: i.about_store ? 'store' : undefined };
    case 'set_budget': return n(i.cap) ? { type: 'setBudget', cap: n(i.cap)! } : null;
    case 'show_stock': return { type: 'showStock' };
    case 'confirm_purchase': return { type: 'confirmPurchase' };
    case 'reply': return s(i.text) ? { say: s(i.text)! } : null;
  }
  return null;
}

export async function interpretWithLlm(text: string): Promise<{ actions: Action[]; say?: string }> {
  client ??= new Anthropic();
  const basket = store.basket();
  const context = basket?.status === 'building' && basket.items.length
    ? `Current basket: ${basket.items.map((i) => `${i.needId}×${i.quantity}`).join(', ')}`
    : 'No basket in progress.';
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
  for (const block of response.content) {
    if (block.type !== 'tool_use') continue;
    const a = toAction(block.name, (block.input ?? {}) as In, text);
    if (!a) continue;
    if ('say' in a) say = a.say;
    else actions.push(a);
  }
  return { actions, say };
}
