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

### Preparing the real supermarket cart (V1.5)

Compare → **הכן עגלה ב…** (or in chat: "תכין לי עגלה בשופרסל").

1. Kaniti opens a real Chrome window **on the computer that runs Kaniti** (install Google Chrome; or set `KANITI_CHROME_PATH`).
2. If the supermarket needs you to log in — or shows a CAPTCHA / SMS code — you do it yourself in that window.
   Kaniti waits and continues on its own. It never sees or stores your password.
3. Kaniti puts every confidently-matched item into the supermarket's own cart, using the same cart calls the website
   makes, and stops at the cart page. Doubtful matches are **not** added — you'll see them listed.
4. You get "העגלה מוכנה" with the store's own total and a button to open the cart. **Checkout and payment happen only
   on the supermarket's site/app.** When logged in, the cart is in your account, so you can also finish on your phone.
5. "סיימתי להזמין" opens the purchase confirmation, pre-filled from the prepared cart.

Logins stay in a dedicated browser profile (`data/browser-profile/`, git-ignored), managed by Chrome itself.
On a computer without a screen, cart preparation that needs a login fails with a clear message.

Supported: Shufersal Online, Rami Levy Online, and the ZuZ chains (Victory, Yenot Bitan, Carrefour, Tiv Taam,
Keshet Teamim, Quik). Delete the profile folder to forget all supermarket sessions.

### Security boundary

- Kaniti has no payment form and never stores, sees, logs or transmits card numbers, CVV, payment tokens, bank or
  supermarket passwords, or OTP codes. It never clicks checkout or places an order.
- Supermarket session tokens are only used inside the supermarket's own page and are never returned to Kaniti.
- The server listens on your local network so your phone can reach it; there is no login, so run it only on a
  trusted home network. Dev endpoints are disabled with `npm start` (production).

### Checks

```bash
npm test                         # 100+ tests: parser, matching on real product names, learning, ranking, cart state machine, 2-cycle simulation
npm run live-check -- "רמת גן"    # real sites: delivery, search, promos, branch files, a real basket comparison
npm run cart-check -- tivtaam     # fills a real cart at the supermarket and reads it back (stops at the cart)
npm run rehearsal -- "רמת גן"     # two full shopping cycles on real data for the household profile
npm run match-report              # dumps real search results per household item (for matching regression tests)
```

All of these also run in GitHub Actions (`.github/workflows/live-check.yml`).

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

### What was verified against real data (Oct 2026, from a GitHub Actions runner)

- **Physical branches — working end to end.** Today's official files for Shufersal, Rami Levy, Osher Ad,
  Yochananof, Tiv Taam and Keshet were downloaded and parsed (5–14k items per branch, thousands of promotions).
  Stores are matched to your city (the files use CBS locality codes, e.g. רמת גן = 8600). A real 16-item basket
  was priced and compared across three Ramat Gan branches.
- **Online catalogs.** The ZuZ adapter returned live prices from Tiv Taam's online store. Shufersal, Rami Levy and
  the other ZuZ chains block datacenter IPs (Cloudflare / maintenance page), so they could **not** be verified from
  the cloud — they are expected to work from a home connection in Israel. Run `npm run live-check -- "<your city>"`
  at home to confirm; the table shows exactly which chains answered.
- If every online chain fails, the basket is still priced from branch files and labelled as such.

### Honest limitations

- **Delivery eligibility**: there's no public address-level API for most chains. Rami Levy and the ZuZ chains are
  checked against their branch lists by city; Shufersal Online is assumed to deliver (it covers most of the
  country) and says so. The onboarding lets you correct the list.
- **Delivery fees / minimum order** come from each chain's published price list, not from a real cart (carts need a
  logged-in account). The Compare screen says this.
- **"Live"** means the price came from the chain's online catalog at that moment — it is not a checkout.
- **Product matching** is rule-based (name fit, pack-size hints, look-alike exclusions). Branch files use terse,
  abbreviated names, so an occasional odd pick is possible — replace it once in the basket and the app remembers.
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
