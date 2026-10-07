// Types shared by server and client. Kept deliberately small.

export type Address = { city: string; street?: string };

export type Household = {
  id: string;
  adults: number;
  children: { age: number }[];
  kosher: boolean;
  allergies: string[];
  dietNotes: string[]; // e.g. "צמחוני", free text from "אחר"
  homeAddress: Address;
  driveSavingsThresholdNis: number;
  onlineProviders: string[]; // provider ids the household chose
  physicalStores: { chainId: string; storeId: string; name: string }[];
  flexibilityStyle: 'strict' | 'balanced' | 'adventurous';
  shopEveryDays: number;
  onboardedAt?: string;
  deliveryStatus?: Record<string, DeliveryStatus>; // legacy city-level onboarding check — never treated as confirmed
  childDairyAllergy?: boolean;
};

export type Flexibility = 'exact_product' | 'brand_flexible' | 'category_flexible' | 'exploratory';
export type Level = 'low' | 'medium' | 'high';

export type HouseholdNeed = {
  id: string;
  label: string;
  emoji: string;
  active: boolean; // part of the household's regular shop
  flexibility: Flexibility;
  preferredBrands: string[];
  forbiddenBrands: string[];
  hardConstraints: string[];
  typical14DayQty: number; // in stock units (e.g. eggs, cans, kg)
  qtySource: 'default' | 'learned' | 'user';
  currentStockEstimate?: number; // stock units at stockAsOf
  stockAsOf?: string;
  stockConfidence: number; // 0..1 at stockAsOf
  dealSensitivity: Level;
  wasteRisk: Level;
  lastPurchasedAt?: string;
  lastPurchasedQty?: number; // stock units
  lastProductName?: string;
  neverSuggest?: boolean;
  staple?: 'always' | 'sometimes'; // "don't want to run out" — separate from how often it is bought
  removedCount: number; // removed from generated baskets (learning)
  dismissedDeals: number;
  flexConfidence: number; // 0..1: how sure we are about flexibility
  lastAskedAt?: string; // last check-in question about stock
};

export type BasketStatus = 'need' | 'opportunity' | 'discovery';

export type ResolvedProduct = {
  providerId: string;
  productId: string;
  name: string; // raw provider name — also the matching key for the household's usual product
  brand?: string;
  sizeText?: string;
  byWeight?: boolean;
  price: number; // effective price per pack, after promo if applicable
  regularPrice?: number;
  unitPriceText?: string;
  promoText?: string;
  promoMinQty?: number;
  promoEndsAt?: string;
  live: boolean;
};

export type BasketItem = {
  needId: string;
  label: string;
  emoji: string;
  quantity: number; // packs
  unit: string; // pack label
  status: BasketStatus;
  reason: string;
  source: 'baseline' | 'stock_gap' | 'promotion' | 'user_request' | 'discovery';
  lockedByUser?: boolean;
  accepted: boolean; // discovery items start as false (suggestion only)
  product?: ResolvedProduct;
  usualProductName?: string; // set when we substituted
  substitutedFrom?: string; // label of the need this item stands in for (e.g. חזה עוף → פרגיות)
  uncertain?: boolean; // product match isn't clear — the user should pick
  condition?: { kind: 'good_price'; met: boolean | null; note?: string };
};

export type SkippedItem = { needId: string; label: string; emoji: string; reason: string };

export type CheckInQuestion = {
  id: string;
  needId: string;
  text: string;
  options: { label: string; value: string }[];
};

export type Basket = {
  id: string;
  createdAt: string;
  horizonDays: number;
  status: 'building' | 'ready' | 'purchased';
  items: BasketItem[];
  skipped: SkippedItem[];
  tempSkips: string[]; // needIds skipped for this basket only
  budgetCap?: number;
  notes: string[];
  priced: boolean;
  priceSourceNote?: string;
};

export type LearningEvent = {
  id?: number;
  type:
    | 'accepted_product'
    | 'replaced_product'
    | 'removed_product'
    | 'stock_report'
    | 'preference_statement'
    | 'purchase_confirmed'
    | 'quantity_changed'
    | 'deal_dismissed'
    | 'deal_accepted'
    | 'quantity_feedback';
  needId?: string;
  fromProductId?: string;
  toProductId?: string;
  value?: unknown;
  createdAt: string;
};

export type PurchaseItem = {
  needId: string; label: string; emoji: string; quantity: number; unit: string; productName?: string; price?: number; status: BasketStatus;
  brand?: string; sizeText?: string; providerId?: string; productId?: string;
  regularPrice?: number; promoMinQty?: number; promoEndsAt?: string; // promo actually used
  usualProductName?: string; usualPrice?: number; // substitution vs the usual product (same scan)
  stockBefore?: number; // estimated stock units at purchase time
};

export type Purchase = {
  id: string;
  createdAt: string;
  storeName: string;
  providerId?: string;
  total: number;
  items: PurchaseItem[];
  deliveryFee?: number;
  deliveryFeeEstimated?: boolean;
  priceSource?: PriceSource;
  /** The comparison that was on screen when buying — used only for measured savings. */
  atPurchase?: { fresh: boolean; chosenTotal: number; chosenCompleteness: number; nextBest?: { providerId: string; providerName: string; total: number; completeness: number } };
  dealsUsed: number;
  substitutions: number;
  removed?: { needId: string; label: string }[]; // suggested but not bought
  stockUps?: string[]; // labels bought as stock-up opportunities
  viaCart?: boolean; // seeded from a prepared supermarket cart
  feedback?: Record<string, 'too_much' | 'right' | 'ran_out'>;
};

// ---------- providers ----------

export type PriceSource = 'live' | 'branch_data' | 'estimate' | 'demo';

export type ProductSearchResult = {
  providerId: string;
  productId: string;
  name: string;
  brand?: string;
  price: number; // regular shelf price
  promoPrice?: number; // effective per-unit price when promo applies
  promoText?: string;
  promoMinQty?: number;
  unitPriceText?: string;
  sizeText?: string;
  available: boolean;
  source: PriceSource;
  fetchedAt: string;
  byWeight?: boolean;
  promoEndsAt?: string; // ISO date, when the provider publishes it
};

/** One observed price for a household need at a provider on a date — for learning cheap weekdays. */
export type PriceSnapshot = {
  localDate: string; // YYYY-MM-DD, Asia/Jerusalem
  weekday: number; // 0=Sunday
  weekKey: string; // ISO week, e.g. 2026-W41
  providerId: string;
  needId: string;
  unitPrice: number;
  regularPrice?: number;
  deliveryFee?: number;
  deliveryFeeKnown: boolean;
  source: PriceSource;
};

/** Delivery to the household's address, as the supermarket's own page shows it. Never inferred from city/branch. */
export type DeliveryStatus = 'confirmed' | 'unavailable' | 'user_action_required' | 'unknown';

/** What the supermarket page itself showed about delivery to the selected address. */
export type ProviderDelivery = {
  providerId: string;
  deliveryStatus: DeliveryStatus;
  confirmedAddressText?: string; // display-safe: street, number, city only
  deliveryFee?: number; // as shown by the site
  deliveryWindows?: string[];
  minimumOrder?: number;
  restrictionMessage?: string;
  cartTotal?: number;
  basketCompleteness?: number;
  source: 'provider_page';
  checkedAt: string;
  addressKey?: string; // which stored household address this was checked against
};

export type DeliveryAvailability = {
  providerId: string;
  status?: DeliveryStatus;
  needsLogin?: boolean; // exact-address verification needs the household's own login on the site
  addressText?: string; // display-safe address as the site resolved it
  delivers: boolean | null; // null = could not determine
  note: string;
  deliveryFee?: number;
  minOrder?: number;
  checkedLive: boolean;
};

export type QuoteLine = {
  needId: string;
  label: string;
  quantity: number;
  product?: ProductSearchResult;
  lineTotal: number;
  substituted?: boolean;
  missing?: boolean;
  uncertain?: boolean; // a candidate exists but doesn't clearly match — not counted as found
};

export type BasketQuote = {
  providerId: string;
  providerName: string;
  kind: 'online' | 'physical';
  ok: boolean;
  error?: string;
  lines: QuoteLine[];
  subtotal: number;
  deliveryFee: number;
  minOrderIssue?: string;
  total: number;
  completeness: number; // 0..1
  unavailableCount: number;
  substitutionsCount: number;
  source: PriceSource;
  fetchedAt: string;
  uncertainCount?: number;
  cartSupported?: boolean; // Kaniti can prepare this provider's real online cart
  deliveryStatus?: DeliveryStatus;
  deliveryFeeEstimated?: boolean; // true = the chain's list fee, not read from the supermarket page
  delivery?: ProviderDelivery; // last delivery state read from the supermarket's own page (same address)
};

export type Comparison = {
  createdAt: string;
  basketKey?: string;
  itemsCount: number;
  quotes: BasketQuote[];
  recommendation: { text: string; winnerId?: string; kind: 'online' | 'physical' | 'none' };
};

export type Deal = {
  id: string;
  kind: 'now' | 'stock' | 'discovery';
  needId: string;
  label: string;
  emoji: string;
  product: ProductSearchResult;
  discountPct: number;
  why: string;
  suggestQty: number;
  unit: string;
};

// ---------- chat ----------

export type ChatComponent =
  | { type: 'quick_replies'; options: { label: string; send: string }[] }
  | { type: 'stock_confirm'; rows: { needId: string; emoji: string; label: string; text: string; value: number; unit: string }[] }
  | { type: 'question'; question: CheckInQuestion }
  | { type: 'basket_summary'; items: number; total?: number; deals: number; substitutions: number; discoveries: number }
  | { type: 'deal'; deal: Deal }
  | { type: 'learning'; needId: string; text: string; options: { label: string; send: string }[] }
  | { type: 'prices'; title: string; rows: { provider: string; name: string; price: number; promoText?: string; source: PriceSource }[]; failures: string[] }
  | { type: 'state_change'; changes: string[] }
  | { type: 'progress'; stages: string[] };

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  components?: ChatComponent[];
  createdAt: string;
};

export type AppState = {
  household: Household | null;
  needs: HouseholdNeed[];
  basket: Basket | null;
  nextShopInDays: number | null;
  purchasesCount: number;
  llm: boolean;
  demoPrices: boolean;
  now: string;
};

// ---------- cart handoff ----------

export type CartJobStatus =
  | 'starting'
  | 'verification_required' // CAPTCHA / bot check — the user completes it in the supermarket window
  | 'login_required' // the user logs in (incl. OTP) in the supermarket window
  | 'address_required' // the user selects / confirms the delivery address in the supermarket window
  | 'adding'
  | 'ready' // every planned item is in the supermarket cart
  | 'partial' // some items couldn't be added
  | 'failed'
  | 'unsupported';

export type CartJobLine = {
  needId: string;
  label: string;
  productId?: string;
  productName?: string;
  quantity: number;
  price?: number;
  byWeight?: boolean; // sold per kg — quantity is kilograms
  state: 'pending' | 'added' | 'failed' | 'skipped';
  reason?: string;
};

export type CartJob = {
  id: string;
  providerId: string;
  providerName: string;
  status: CartJobStatus;
  message: string;
  startedAt: string;
  updatedAt: string;
  lines: CartJobLine[];
  cartUrl?: string;
  cartTotal?: number; // as the supermarket shows it
  cartItemCount?: number;
  preexistingItems?: number; // items that were already in the site's cart before Kaniti added its lines
  plannedTotal?: number; // Kaniti's quote for the same lines
  deliveryFee?: number;
  deliveryFeeEstimated?: boolean; // the fee is the chain's list price, not what the site showed
  deliveryWindow?: string;
  delivery?: ProviderDelivery; // read from the supermarket page after the cart was prepared
  verifyOnly?: boolean; // only check delivery to the address — no items added
  substitutions: number;
  loginRequired: boolean;
  userAction?: string;
  anonymous?: boolean; // cart lives only in the automation browser (not in the account)
  demo?: boolean;
  paymentBoundary: 'stopped_before_checkout';
};
