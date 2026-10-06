# קניתי · Kaniti

A small, private, Hebrew/RTL, chat-first household shopping agent for one family.
It learns how the household shops, estimates what's left at home, scans real supermarket prices and
promotions, builds a biweekly basket, compares the chains that deliver to you (and a physical branch),
and learns from what you actually bought.

Not a product. No accounts, billing, admin, analytics or multi-tenancy — by design.

## Run it

```bash
npm install
npm run build          # builds the web app into dist/
npm start              # http://localhost:8787  (serves app + API, data in data/kaniti.db)
```

Development (hot reload): `npm run dev` → http://localhost:5173

Optional environment variables:

| var | what |
|---|---|
| `ANTHROPIC_API_KEY` | Enables Claude to interpret chat messages into typed actions. Without it a deterministic Hebrew rule parser is used (covers all the V1 intents). Either way, the **app code** owns state and decisions. |
| `KANITI_MODEL` | Override model (default `claude-opus-5-5`). |
| `KANITI_DEMO=1` | Offline demo prices for development. Everything is labelled **דמו** in the UI. Never on by default. |
| `PORT`, `KANITI_DB` | Port / DB path. |

To use it from your phone: run it on a home machine and open `http://<machine-ip>:8787`, then "Add to Home Screen" (it's a PWA).

### Checks

```bash
npm test                         # parser, providers, transparency parsing (real published files), two-cycle learning simulation
npm run live-check -- "רמת גן"    # hits the real supermarket sites: delivery, search, promos, branch files, a real basket comparison
```

`live-check` also runs in GitHub Actions (`.github/workflows/live-check.yml`, manual or on provider changes).

## How it's built (and why it's small)

```
server/
  catalog.ts        household "needs" (EGGS, TUNA, COLA_ZERO…) with units, pack sizes, synonyms, brands
  state.ts          onboarding, stock estimation, learning rules (deterministic)
  engine/basket.ts  NEED / OPPORTUNITY / DISCOVERY basket engine + "why" explanations
  engine/match.ts   picks a product per need honouring flexibility (exact / brand / category / exploratory)
  engine/compare.ts one-store comparison: completeness first, then total incl. delivery, physical-store threshold
  chat/parser.ts    Hebrew rule parser → typed actions
  chat/llm.ts       optional Claude tool-use → the same typed actions
  chat/execute.ts   executes actions, writes factual replies + rich chat cards
  providers/        GroceryProvider adapters (see below)
src/                React UI: Chat · Basket · Deals · Compare · Household (+ onboarding, purchase confirm)
```

Chat is never the database: every statement becomes a typed action that changes SQLite state
(`node:sqlite`, no native deps). Temporary instructions ("אל תקנה גבינת שמנת הפעם") only touch the current
basket; lasting ones ("לא אכפת לי איזה מרכך") change the household need and are logged as learning events.

### Price sources

| source | chains | data | label in UI |
|---|---|---|---|
| Online catalog JSON (the same endpoints the sites use) | Shufersal Online, Rami Levy Online, and the shared Stor.ai/"ZuZ" platform: Victory, Yenot Bitan, Carrefour, Tiv Taam, Keshet Teamim, Quik | current online price, promotions (incl. multi-buy), availability | **חי** |
| Price-transparency law files | Shufersal (prices.shufersal.co.il), Cerberus chains: Rami Levy, Osher Ad, Yochananof, Tiv Taam, Keshet | branch-level price + promos, cached once a day | **נתוני סניף** |
| Demo (dev only) | — | fake | **דמו** |

Endpoints and file formats were taken from maintained open-source projects (OpenIsraeliSupermarkets
scrapers/parsers, SuperMarketScraping docs) rather than reverse-engineered from scratch. Parsers are tested
against real published files in `tests/fixtures/`.

### Honest limitations

- **Delivery eligibility**: there's no public address-level API for most chains. Rami Levy and the ZuZ chains are
  checked live against their branch lists by city; Shufersal Online is assumed to deliver (it covers most of the
  country) and says so. The onboarding lets you correct the list.
- **Delivery fees / minimum order** come from each chain's published price list, not from a real cart (carts need a
  logged-in account). The Compare screen says this.
- **"Live"** means the price came from the chain's online catalog at that moment — it is not a checkout.
- The online sites may block non-Israeli or datacenter IPs; run the app from home.
- Yochananof online (Magento GraphQL), Hazi Hinam and Osher Ad online are not implemented. Osher Ad and
  Yochananof are covered as physical branches.

## Implementation plan (as built)

**Sprint 1 — skeleton + household memory.** App shell, bottom nav (Chat/Basket/Deals/Compare/Household), 6-step
tap-first onboarding, household + needs model with flexibility, SQLite persistence, chat rendering with quick-choice
components. "יש 10 ביצים" / "לא אכפת לי איזה מרכך" / "רק קוקה קולה זירו" update state and show on the Household screen.

**Sprint 2 — smart basket + chat actions.** Typed action layer (rule parser + optional LLM), estimated stock and
consumption, NEED/OPPORTUNITY/DISCOVERY, deal sensitivity and waste risk, short pre-shop check-in (≤3 questions),
conditional items ("אם המחיר טוב"), budget cap, explanations, basket controls that emit learning events.

**Sprint 3 — real prices.** `GroceryProvider` interface; online adapters; delivery check; transparency-file branch
adapter; one-store comparison with live/branch/estimate labels; per-provider failure isolation.

**Sprint 4 — learning loop + polish.** Deals screen (now/stock/maybe), restrained discovery (max 2–3, never auto-added),
"what I learned about you" with confidence and inline editors, purchase confirmation + history, quantity feedback,
learning from removals/replacements/quantity changes, loading/empty/error states, mobile pass.
