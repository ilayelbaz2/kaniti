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
  removedCount: number; // removed from generated baskets (learning)
  dismissedDeals: number;
  flexConfidence: number; // 0..1: how sure we are about flexibility
  lastAskedAt?: string; // last check-in question about stock
};

export type BasketStatus = 'need' | 'opportunity' | 'discovery';

export type ResolvedProduct = {
  providerId: string;
  productId: string;
  name: string;
  brand?: string;
  price: number; // effective price per pack, after promo if applicable
  regularPrice?: number;
  unitPriceText?: string;
  promoText?: string;
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

export type Purchase = {
  id: string;
  createdAt: string;
  storeName: string;
  providerId?: string;
  total: number;
  items: { needId: string; label: string; emoji: string; quantity: number; unit: string; productName?: string; price?: number; status: BasketStatus }[];
  dealsUsed: number;
  substitutions: number;
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
};

export type DeliveryAvailability = {
  providerId: string;
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
};

export type Comparison = {
  createdAt: string;
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
