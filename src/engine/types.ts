// Engine-facing row types (Postgres rows as they come back from pg).

export interface CopySettings {
  user_id: string;
  leader_id: string;
  allocation_usd: number;
  max_leverage: number;
  max_notional_per_trade_usd: number;
  daily_loss_limit_usd: number;
  weekly_drawdown_limit_bps: number;
  market_allowlist: number[];
  market_blacklist: number[];
  slippage_bps: number;
  copy_delay_ms: number;
  reduce_only: boolean;
  stop_loss_bps: number;
  enabled: boolean;
  paused_reason: string | null;
  kill_switch_requested_at: string | null;
  updated_at: string;
}

export interface PerplAccountRow {
  id: string;
  user_id: string;
  address: string;
  api_key_token: string; // encrypted
  api_key_secret: string; // encrypted
  public_key: string | null;
  scope_mask: number;
  label: string;
  expires_at: number;
  builder_id: number | null;
  max_builder_fee_per_100k: number;
  account_id: string | null;
  status: string;
}

export interface CopyOrderRow {
  id: string;
  user_id: string;
  leader_id: string;
  market_id: number;
  order_type: number;
  size_scaled: string;
  price_scaled: string;
  leverage_hundredths: number;
  notional_usd: number;
  request_id: string | null;
  perpl_order_id: string | null;
  status: string;
  status_reason: number | null;
  builder_fee_per_100k: number;
  filled_size_scaled: string;
  dry_run: boolean;
  error: string | null;
  created_at: string;
}

export interface ManualOrderRow {
  id: string;
  user_id: string;
  idempotency_key: string;
  market_id: number;
  order_type: number;
  size_scaled: string;
  price_scaled: string;
  leverage_hundredths: number;
  notional_usd: number;
  perpl_order_id: string | null; // cancel target oid
  slippage_bps: number;
  request_id: string | null;
  result_order_id: string | null;
  status: string;
  status_reason: number | null;
  filled_size_scaled: string;
  dry_run: boolean;
  builder_fee_per_100k: number;
  error: string | null;
  created_at: string;
}

export interface PositionRow {
  user_id: string;
  market_id: number;
  perpl_position_id: string | null;
  side: number;
  size_scaled: string;
  entry_price_scaled: string;
  leverage_hundredths: number;
  leader_id: string | null;
  updated_at: string;
}

export interface TournamentRow {
  id: string;
  name: string;
  metric: string;
  status: string;
  starts_at: string;
  ends_at: string;
  entry_fee_usd: number;
  prize_pool_usd: number;
  created_at: string;
}

export interface TournamentEntryRow {
  tournament_id: string;
  user_id: string;
  joined_at: string;
  equity_start: number;
  equity_peak: number;
  equity_low: number;
  net_pnl: number;
  max_drawdown: number;
  score: number;
  rank: number | null;
}
