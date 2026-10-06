import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import type { AppState, ChatMessage } from '../shared/types.ts';
import { store } from './db.ts';
import { advanceDays, nowIso, uid } from './clock.ts';
import { completeOnboarding, estimateStock, getConcept, learnFromQtyFeedback, nextShopInDays, updateNeed, type OnboardingInput } from './state.ts';
import { CONCEPTS } from './catalog.ts';
import { parseMessage } from './chat/parser.ts';
import { ACTION_ORDER } from './chat/actions.ts';
import { executeActions, executeCommand } from './chat/execute.ts';
import { interpretWithLlm, llmEnabled } from './chat/llm.ts';
import * as svc from './service.ts';
import { compareBasket } from './engine/compare.ts';
import { explainItem } from './engine/basket.ts';
import { DEMO, onlineCatalog } from './providers/index.ts';
import { PHYSICAL_CHAINS, listStores } from './providers/transparency.ts';
import { withTimeout } from './providers/types.ts';
import { sameCity } from './providers/cities.ts';

const app = express();
app.use(express.json({ limit: '1mb' }));

const wrap = (fn: (req: express.Request, res: express.Response) => Promise<unknown> | unknown) =>
  async (req: express.Request, res: express.Response) => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) res.json(out === undefined ? { ok: true } : out);
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: (e as Error).message });
    }
  };

function appState(): AppState {
  return {
    household: store.household(),
    needs: store.needs().map((n) => ({ ...n, currentStockEstimate: estimateStock(n).qty, stockConfidence: estimateStock(n).confidence })),
    basket: store.basket(),
    nextShopInDays: nextShopInDays(),
    purchasesCount: store.purchases().length,
    llm: llmEnabled(),
    demoPrices: DEMO,
    now: nowIso(),
  };
}

app.get('/api/state', wrap(() => appState()));
app.get('/api/catalog', wrap(() => CONCEPTS.map((c) => ({ id: c.id, label: c.label, emoji: c.emoji, staple: !!c.staple, category: c.category }))));

// ---------- onboarding ----------

app.get('/api/providers', wrap(() => ({
  online: onlineCatalog().map((p) => ({ id: p.id, name: p.name, deliveryFee: p.deliveryFee, minOrder: p.minOrder })),
  physicalChains: PHYSICAL_CHAINS.map((c) => ({ id: c.id, name: c.name })),
})));

app.post('/api/delivery-check', wrap(async (req) => {
  const address = { city: String(req.body.city ?? ''), street: req.body.street };
  return Promise.all(onlineCatalog().map(async (p) => {
    try { return { ...(await withTimeout(p.checkDelivery(address), 15000, p.name)), name: p.name }; } catch (e) {
      return { providerId: p.id, name: p.name, delivers: null, checkedLive: false, note: `לא הצלחתי לבדוק כרגע (${(e as Error).message})`, deliveryFee: p.deliveryFee };
    }
  }));
}));

app.get('/api/stores/:chainId', wrap(async (req) => {
  const chain = PHYSICAL_CHAINS.find((c) => c.id === req.params.chainId);
  if (!chain) throw new Error('unknown chain');
  const city = String(req.query.city ?? '');
  if (DEMO) return [{ storeId: '1', name: `סניף ${city || 'מרכזי'} (דמו)`, city }];
  const all = await withTimeout(listStores(chain), 60000, chain.name);
  const local = city ? all.filter((s) => sameCity(s.city, city)) : all;
  return (local.length ? local : all).slice(0, 40);
}));

app.post('/api/onboarding', wrap((req) => {
  completeOnboarding(req.body as OnboardingInput);
  const welcome: ChatMessage = {
    id: uid('m_'), role: 'assistant', createdAt: nowIso(),
    text: 'אני כבר יודע את הבסיס.\nרוצה שאנסה לבנות את הקנייה הראשונה שלכם?',
    components: [{ type: 'quick_replies', options: [{ label: 'בנה קנייה', send: '#build 14' }, { label: 'קודם נראה מבצעים', send: '#deals' }] }],
  };
  store.addChat(welcome);
  return appState();
}));

app.patch('/api/household', wrap((req) => {
  const h = store.household();
  if (!h) throw new Error('no household');
  store.saveHousehold({ ...h, ...req.body });
  return appState();
}));

// ---------- chat ----------

app.get('/api/chat', wrap(() => store.chat()));

async function handleChat(text: string): Promise<ChatMessage> {
  const t = text.trim();
  const cmd = t.match(/^#(\w+)\s*(.*)$/);
  if (cmd) {
    const direct = await executeCommand(cmd[1], cmd[2].split(/\s+/).filter(Boolean));
    if (direct) return direct;
    return executeActions(parseMessage(t));
  }
  if (llmEnabled()) {
    try {
      const { actions, say } = await interpretWithLlm(t);
      if (actions.length || say) return executeActions(actions.sort((a, b) => ACTION_ORDER.indexOf(a.type) - ACTION_ORDER.indexOf(b.type)), say);
    } catch (e) {
      console.warn('LLM failed, using rule parser:', (e as Error).message);
    }
  }
  return executeActions(parseMessage(t));
}

app.post('/api/chat', wrap(async (req) => {
  const text = String(req.body.text ?? '');
  const label = String(req.body.label ?? text);
  const userMsg: ChatMessage = { id: uid('m_'), role: 'user', text: label, createdAt: nowIso() };
  store.addChat(userMsg);
  const reply = await handleChat(text);
  store.addChat(reply);
  return { messages: [userMsg, reply], state: appState() };
}));

// ---------- basket ----------

app.post('/api/basket/build', wrap(async (req) => {
  const { failures } = await svc.buildBasket(Number(req.body.horizonDays ?? 14));
  return { state: appState(), failures };
}));
app.post('/api/basket/:needId/qty', wrap((req) => { svc.setQuantity(String(req.params.needId), Number(req.body.quantity)); return appState(); }));
app.post('/api/basket/:needId/remove', wrap((req) => { svc.removeItem(String(req.params.needId), req.body.temporary !== false); return appState(); }));
app.post('/api/basket/:needId/accept', wrap((req) => { svc.acceptItem(String(req.params.needId)); return appState(); }));
app.post('/api/basket/:needId/lock', wrap((req) => { svc.lockItem(String(req.params.needId), !!req.body.locked); return appState(); }));
app.get('/api/basket/:needId/alternatives', wrap((req) => svc.alternatives(String(req.params.needId))));
app.post('/api/basket/:needId/replace', wrap((req) => {
  const r = svc.replaceItem(String(req.params.needId), req.body.productId);
  return { state: appState(), replacements: r.replacements };
}));
app.get('/api/basket/:needId/why', wrap((req) => ({ text: explainItem(String(req.params.needId), store.basket()) })));
app.post('/api/basket/add', wrap(async (req) => { await svc.addItem(req.body); return appState(); }));

// ---------- needs / preferences ----------

app.patch('/api/needs/:id', wrap((req) => {
  const id = String(req.params.id);
  const patch = { ...req.body };
  if (patch.typical14DayQty !== undefined) patch.qtySource = 'user';
  if (patch.flexibility) patch.flexConfidence = 0.95;
  updateNeed(id, patch, 'עריכה במסך הבית');
  return appState();
}));
app.post('/api/needs/:id/stock', wrap(async (req) => {
  await executeActions([{ type: 'updateHouseholdStock', needId: String(req.params.id), qty: Number(req.body.qty) }]);
  return appState();
}));
app.get('/api/events', wrap(() => store.events(undefined, 50).map((e) => ({ ...e, label: e.needId ? getConcept(e.needId).label : undefined }))));

// ---------- deals / compare / purchase ----------

app.get('/api/deals', wrap(() => svc.getDeals()));
app.post('/api/deals/dismiss', wrap((req) => { svc.dismissDeal(req.body.dealId, req.body.needId); return { ok: true }; }));
app.post('/api/deals/always', wrap((req) => { updateNeed(req.body.needId, { dealSensitivity: 'high' }, 'תמיד תראה לי אם זול'); return { ok: true }; }));

app.get('/api/compare', wrap(() => store.comparison()));
app.post('/api/compare', wrap(async () => {
  const b = store.basket();
  if (!b || b.status !== 'building' || !b.items.length) throw new Error('אין סל פעיל');
  return compareBasket(b);
}));

app.post('/api/purchase', wrap((req) => ({ purchase: svc.confirmPurchase(req.body), state: appState() })));
app.get('/api/purchases', wrap(() => store.purchases()));
app.post('/api/purchases/:id/feedback', wrap((req) => {
  const p = store.purchases().find((x) => x.id === req.params.id);
  if (!p) throw new Error('not found');
  const { needId, value } = req.body as { needId: string; value: 'too_much' | 'right' | 'ran_out' };
  p.feedback = { ...(p.feedback ?? {}), [needId]: value };
  store.savePurchase(p);
  learnFromQtyFeedback(needId, value);
  return p;
}));

// ---------- dev helpers (never in production) ----------

if (process.env.NODE_ENV !== 'production') {
  app.post('/api/dev/advance', wrap((req) => { advanceDays(Number(req.body.days ?? 14)); return appState(); }));
  app.post('/api/dev/reset', wrap(() => { store.reset(); return appState(); }));
}

// ---------- static client ----------

const dist = path.resolve('dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => console.log(`kaniti on http://localhost:${port}${DEMO ? ' (DEMO prices)' : ''}${llmEnabled() ? ' (LLM on)' : ' (rule parser)'}`));
