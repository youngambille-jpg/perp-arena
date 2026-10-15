// Perpl wire types. Field names match the wire format exactly;
// see docs.perpl.xyz/resources/for-developers/api/websocket.md.

// Message types (mt)
export const MT = {
  PING: 1,
  PONG: 2,
  STATUS_RESPONSE: 3,
  SUBSCRIPTION_REQUEST: 5,
  SUBSCRIPTION_RESPONSE: 6,
  MARKET_CONFIG_UPDATE: 8,
  MARKET_STATE_UPDATE: 9,
  CANDLES_SNAPSHOT: 11,
  CANDLES_UPDATE: 12,
  L2_BOOK_SNAPSHOT: 15,
  L2_BOOK_UPDATE: 16,
  TRADES_SNAPSHOT: 17,
  TRADES_UPDATE: 18,
  WALLET_SNAPSHOT: 19,
  WALLET_UPDATE: 20,
  ACCOUNT_UPDATE: 21,
  ORDER_REQUEST: 22,
  ORDERS_SNAPSHOT: 23,
  ORDERS_UPDATE: 24,
  FILLS_UPDATE: 25,
  POSITIONS_SNAPSHOT: 26,
  POSITIONS_UPDATE: 27,
  ACCOUNT_STATS_UPDATE: 28,
  API_KEY_SIGN_IN: 29,
  HEARTBEAT: 100,
} as const;

export enum OrderType {
  OpenLong = 1,
  OpenShort = 2,
  CloseLong = 3,
  CloseShort = 4,
  Cancel = 5,
  IncreasePositionCollateral = 6,
  Change = 7,
}

export enum OrderFlags {
  GTC = 0,
  PostOnly = 1,
  FillOrKill = 2,
  ImmediateOrCancel = 4,
}

export enum OrderStatus {
  Pending = 1,
  Open = 2,
  PartiallyFilled = 3,
  Filled = 4,
  Canceled = 5,
  Expired = 6,
  Failed = 7,
  Untriggered = 8,
  Triggered = 9,
  Executed = 10,
}

/** Selected OrderStatusReason values; the full enum spans 0-68. */
export const OrderStatusReason = {
  AmountExceedsAvailableBalance: 1,
  CrossesBook: 13,
  ExceedsLastExecutionBlock: 14,
  ForwardingReverted: 15,
  OrderDescIdTooLow: 32,
  OrderSizeExceedsAvailableSize: 38,
  PerpetualInsolvent: 53,
} as const;

export enum LiquiditySide {
  Maker = 1,
  Taker = 2,
}

export enum PositionType {
  Long = 1,
  Short = 2,
}

// ---- REST payloads -------------------------------------------------------

export interface MarketConfig {
  id: number;
  symbol: string;
  price_decimals: number;
  size_decimals: number;
  initial_margin?: number; // hundredths; 1000 = 10% margin = 10x max
  min_size?: number; // scaled
  order_ttl_blocks?: number;
  [key: string]: unknown;
}

/**
 * Wire shape of a market inside GET /v1/pub/context. Scaling and
 * margin fields live under `config`, not top-level — the
 * registry normalizes them into MarketConfig on ingest.
 */
export interface RawMarketConfig {
  id: number;
  symbol: string;
  order_ttl_blocks?: number;
  config?: {
    price_decimals?: number;
    size_decimals?: number;
    initial_margin?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface Context {
  chain: {
    id?: number;
    chain_id?: number;
    name?: string;
    [key: string]: unknown;
  };
  instances: Array<{
    id: number;
    address?: string;
    collateral_token_id?: number;
    min_account_open_amount?: string | number;
    min_deposit_amount?: string | number;
    [key: string]: unknown;
  }>;
  tokens: Array<{
    id: number;
    address?: string;
    symbol?: string;
    name?: string;
    decimals?: number;
    [key: string]: unknown;
  }>;
  markets: RawMarketConfig[];
}

export interface Page<T> {
  d: T[]; // newest to oldest
  np?: string; // next-page cursor; absent/empty at the end
}

export interface Fill {
  at: { t: number; [key: string]: unknown };
  mkt: number;
  acc: number;
  oid: number;
  t: number; // OrderType
  l?: number; // LiquiditySide
  p?: number; // fill price (scaled)
  s: number; // filled size (scaled)
  f?: string; // gross fee (protocol + builder)
  bfa?: string; // builder-fee portion, omitted when zero
  rq?: number; // request id, when echoed
  [key: string]: unknown;
}

export interface Position {
  id: number;
  mkt: number;
  acc: number;
  t?: number; // PositionType 1 long / 2 short
  s?: number; // size (scaled)
  p?: number; // entry price (scaled)
  lv?: number; // leverage hundredths
  [key: string]: unknown;
}

export interface Order {
  id: number;
  mkt: number;
  acc: number;
  t: number; // OrderType
  rq?: number; // request id
  st?: number; // OrderStatus
  sr?: number; // OrderStatusReason
  p?: number; // price (scaled)
  s?: number; // size (scaled)
  lv?: number; // leverage hundredths
  r?: boolean; // remove from open view
  [key: string]: unknown;
}

export interface Account {
  in: number; // instance id
  id: number; // account id
  fr: boolean; // frozen
  fw: boolean; // forwarding allowed
  ft: number; // fee tier
  lfr: number; // last forwarded request id
  b: string; // balance (decimal string)
  lb: string; // locked balance (decimal string)
}

export interface WalletSnapshot {
  mt: number;
  sn?: number; // sequence — seeds trading-WS tracking
  addr?: string;
  as?: Account[];
  sts?: unknown; // account stats
  [key: string]: unknown;
}

export interface AccountEvent {
  at: { t: number };
  et: number; // AccountEventType
  m?: number;
  a?: string;
  b?: string;
  f?: string;
  bfa?: string;
  [key: string]: unknown;
}

// ---- WebSocket frames ----------------------------------------------------

export interface ApiKeySignInFrame {
  mt: typeof MT.API_KEY_SIGN_IN;
  chain_id: number;
  api_key: string;
  timestamp: string;
  nonce: string;
  signature: string;
}

export interface SubscriptionRequestFrame {
  mt: typeof MT.SUBSCRIPTION_REQUEST;
  subs: Array<{ stream: string; subscribe: boolean }>;
}

export interface SubscriptionResponseFrame {
  mt: typeof MT.SUBSCRIPTION_RESPONSE;
  subs: Array<{
    stream: string;
    sid?: number;
    status?: { code: number; error?: string };
  }>;
}

export interface MarketState {
  at?: { t: number };
  orl?: number; // oracle price
  mrk?: number; // mark price
  lst?: number; // last price
  mid?: number; // mid price
  bid?: number; // best bid
  ask?: number; // best ask
  prv?: number; // price 24h ago
  dv?: number; // daily volume (size)
  dva?: string; // daily volume (amount)
  oi?: number; // open interest
  tvl?: string;
  [key: string]: unknown;
}

export interface MarketStateUpdateFrame {
  mt: typeof MT.MARKET_STATE_UPDATE;
  d: Record<number, MarketState | undefined>;
}

export interface HeartbeatFrame {
  mt: typeof MT.HEARTBEAT;
  sn: number; // strictly +1 from the previous heartbeat
  h: number; // head block
}

export interface OrderRequestFrame {
  mt: typeof MT.ORDER_REQUEST;
  sn: number; // correlation id — echoed as cid on the mt:3 status
  rq: number; // idempotency key, strictly increasing per account
  mkt: number;
  acc: number;
  oid?: number; // order id (cancel/modify)
  t: number; // OrderType
  p: number; // scaled price; 0 = market
  s: number; // scaled size
  ms?: number; // max market slippage, bps
  fl: number; // OrderFlags
  lp?: number; // linked position id (closes)
  lv: number; // leverage hundredths
  lb: number; // last valid block
  bf?: number; // builder fee, per_100k — builder-bound keys only
}

export interface StatusResponseFrame {
  mt: typeof MT.STATUS_RESPONSE;
  sid: number; // 100 = command status stream
  sn: number;
  cid?: number; // echoes our sn; omitted when sn was 0
  status: { code: number; error?: string };
}

export interface WalletFrame {
  mt: number;
  at?: { t: number };
  sn?: number;
  d?: unknown;
  [key: string]: unknown;
}
