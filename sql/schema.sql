-- Perpl Arena v1 schema — Supabase Postgres
-- Run: psql "$SUPABASE_DB_URL" -f sql/schema.sql
-- The worker connects with the service role and bypasses RLS; the mobile app
-- connects directly with the anon key under these policies.

begin;

-- ---------------------------------------------------------------- users
create table if not exists public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  handle text not null,
  -- mera wallet bound via a wallet signature (one wallet per user).
  -- Null until the user unlocks their passkey wallet and links it.
  wallet_address text,
  created_at timestamptz not null default now(),
  unique (handle)
);
create unique index if not exists users_wallet_address_uidx
  on public.users (wallet_address);

-- One-time link challenges: app requests a nonce, wallet signs
-- "Perpl Arena wallet link\nuser: <uuid>\naddress: <0x…>\nnonce:
-- <hex>\nexpiry: <ms>", server ecrecover-verifies and consumes it.
-- Service-role only (no client RLS policies by design).
create table if not exists public.link_challenges (
  user_id uuid primary key references public.users(id) on delete cascade,
  nonce text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------- perpl API key material
-- The opaque X-API-Key token and the Ed25519 private key are stored encrypted
-- (AES-256-GCM, key from KEY_ENCRYPTION_KEY). scope_mask: 1=read, 2=trade, 3=both.
create table if not exists public.perpl_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  address text not null,                       -- wallet address that owns the key
  api_key_token text not null,                 -- encrypted
  api_key_secret text not null,                -- encrypted Ed25519 private key (hex)
  public_key text,                             -- 0x-hex, for display and revocation checks
  scope_mask integer not null check (scope_mask in (1, 2, 3)),
  label text not null default '',
  expires_at bigint not null default 0,        -- ms epoch, 0 = never
  builder_id integer,                          -- set when enrolled bound to a builder code
  max_builder_fee_per_100k integer not null default 0,  -- user-signed ceiling
  account_id bigint,                           -- on-chain exchange account id (from wallet snapshot)
  wallet_balance_usd double precision,
  wallet_locked_usd double precision,
  wallet_updated_at timestamptz,
  status text not null default 'active' check (status in ('active', 'revoked', 'error')),
  last_error text,
  connected_at timestamptz,
  created_at timestamptz not null default now()
);
-- Expression unique constraint lives in an index (Postgres forbids
-- expressions in table-level UNIQUE). The enroll/import upserts
-- reference it as ON CONFLICT (user_id, lower(address), label).
create unique index if not exists perpl_accounts_user_address_label_uidx
  on public.perpl_accounts (user_id, lower(address), label);
create index if not exists perpl_accounts_user_idx on public.perpl_accounts (user_id);
alter table public.perpl_accounts
  add column if not exists wallet_balance_usd double precision,
  add column if not exists wallet_locked_usd double precision,
  add column if not exists wallet_updated_at timestamptz;

-- ------------------------------------------------------------- leaders
-- A leader is a platform user who opted into a public profile. The worker
-- streams their account over their own enrolled key and records activity.
create table if not exists public.leader_profiles (
  user_id uuid primary key references public.users(id) on delete cascade,
  is_public boolean not null default false,
  styles text[] not null default '{}',         -- scalper, swing, funding-farmer, long-only, ...
  bio text not null default '',
  total_pnl_usd double precision not null default 0,
  pnl_24h_usd double precision not null default 0,
  win_rate double precision not null default 0,
  max_drawdown double precision not null default 0,
  sharpe double precision not null default 0,
  followers_count integer not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.follows (
  follower_id uuid not null references public.users(id) on delete cascade,
  leader_id uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, leader_id)
);
create index if not exists follows_leader_idx on public.follows (leader_id);

-- ---------------------------------------------------------- copy settings
-- Risk limits per (follower, leader) pair. All money values are USD.
create table if not exists public.copy_settings (
  user_id uuid not null references public.users(id) on delete cascade,
  leader_id uuid not null references public.users(id) on delete cascade,
  allocation_usd double precision not null check (allocation_usd > 0),
  max_leverage double precision not null default 3,
  max_notional_per_trade_usd double precision not null default 5000,
  daily_loss_limit_usd double precision not null default 50,
  weekly_drawdown_limit_bps double precision not null default 1000,  -- 10%
  market_allowlist integer[] not null default '{}',  -- empty = all allowed
  market_blacklist integer[] not null default '{}',
  slippage_bps integer not null default 50,          -- ms field on market orders
  copy_delay_ms integer not null default 1500,       -- anti-frontrun delay
  reduce_only boolean not null default false,        -- only reduce copied exposure
  stop_loss_bps integer not null default 2000,       -- 20% adverse move closes
  enabled boolean not null default true,
  paused_reason text,
  kill_switch_requested_at timestamptz,              -- set by the API, consumed by the worker
  updated_at timestamptz not null default now(),
  primary key (user_id, leader_id)
);
create index if not exists copy_settings_leader_idx on public.copy_settings (leader_id);
create index if not exists copy_settings_updated_idx on public.copy_settings (updated_at);

-- ------------------------------------------------------------- activity
-- Every leader fill the worker observes, newest-first queries by (leader, at).
create table if not exists public.leader_fills (
  leader_user_id uuid not null references public.users(id) on delete cascade,
  market_id integer not null,
  order_type integer not null,               -- Perpl OrderType
  liquidity integer,                         -- 1 maker, 2 taker
  price_scaled bigint,
  size_scaled bigint not null,
  fee text,
  builder_fee text,                          -- bfa, when the key is builder-bound
  at timestamptz not null,
  ingested_at timestamptz not null default now()
);
create index if not exists leader_fills_recent_idx
  on public.leader_fills (leader_user_id, at desc);

-- Copy orders the engine submitted on a follower's behalf. request_id is the
-- Perpl rq (idempotency key) used to correlate fills back to this row.
create table if not exists public.copy_orders (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  leader_id uuid not null references public.users(id),
  market_id integer not null,
  order_type integer not null,               -- 1 OpenLong, 2 OpenShort, 3 CloseLong, 4 CloseShort
  size_scaled bigint not null,
  price_scaled bigint not null default 0,    -- 0 = market
  leverage_hundredths integer not null default 0,
  notional_usd double precision not null default 0,
  request_id bigint,                         -- perpl rq
  perpl_order_id bigint,                     -- perpl order id, once known
  status text not null default 'submitted'
    check (status in ('submitted', 'open', 'partial', 'filled', 'canceled', 'failed', 'rejected')),
  status_reason integer,                     -- perpl sr, when rejected
  filled_size_scaled bigint not null default 0,  -- accumulated fill size
  dry_run boolean not null default false,    -- simulated order, never submitted
  builder_fee_per_100k integer not null default 0,
  error text,
  created_at timestamptz not null default now()
);
create index if not exists copy_orders_user_idx on public.copy_orders (user_id, created_at desc);
create index if not exists copy_orders_request_idx on public.copy_orders (request_id);
create index if not exists copy_orders_pending_idx
  on public.copy_orders (status) where status = 'submitted';

-- Manual orders: user-initiated tickets executed by the worker through
-- the same sessions, rq counters, and lifecycle as copy orders.
-- Submitted via POST /trading/orders as an intent (status pending),
-- consumed by the worker loop (FOR UPDATE SKIP LOCKED), then tracked
-- submitted → open → partial → filled like copy_orders.
create table if not exists public.manual_orders (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  idempotency_key uuid not null,
  market_id integer not null,
  order_type integer not null,               -- 1 OpenLong, 2 OpenShort, 3 CloseLong, 4 CloseShort, 5 Cancel
  size_scaled bigint not null,
  price_scaled bigint not null default 0,    -- 0 = market
  leverage_hundredths integer not null default 0,
  notional_usd double precision not null default 0,
  perpl_order_id bigint,                     -- cancel target oid (cancel intents)
  slippage_bps integer not null default 50,
  request_id bigint,                         -- perpl rq, once submitted
  result_order_id bigint,                    -- perpl order id, once known
  status text not null default 'pending'
    check (status in ('pending', 'submitted', 'open', 'partial', 'filled', 'canceled', 'failed', 'rejected')),
  status_reason integer,                     -- perpl sr, when rejected
  filled_size_scaled bigint not null default 0,
  dry_run boolean not null default false,
  builder_fee_per_100k integer not null default 0,
  error text,
  created_at timestamptz not null default now(),
  unique (idempotency_key)
);
create index if not exists manual_orders_user_idx on public.manual_orders (user_id, created_at desc);
create index if not exists manual_orders_request_idx on public.manual_orders (request_id);

-- Realized PnL ledger for copied positions (written when a copy is closed out).
create table if not exists public.copy_pnl_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  leader_id uuid not null references public.users(id),
  market_id integer not null,
  realized_usd double precision not null,
  created_at timestamptz not null default now()
);
create index if not exists copy_pnl_user_idx on public.copy_pnl_events (user_id, created_at desc);

-- Live position mirror per user. leader_id is set for positions the copy engine
-- opened (attribution by active copy setting — see README caveats).
create table if not exists public.positions (
  user_id uuid not null references public.users(id) on delete cascade,
  market_id integer not null,
  perpl_position_id bigint,
  side integer not null check (side in (1, 2)),   -- 1 long, 2 short
  size_scaled bigint not null,
  entry_price_scaled bigint not null default 0,
  leverage_hundredths integer not null default 0,
  leader_id uuid references public.users(id),
  updated_at timestamptz not null default now(),
  primary key (user_id, market_id)
);

-- --------------------------------------------------------------- risk
create table if not exists public.risk_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  type text not null,                    -- daily_loss_limit, drawdown_limit, stop_loss, kill_switch, ...
  leader_id uuid references public.users(id),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists risk_events_user_idx on public.risk_events (user_id, created_at desc);

-- ------------------------------------------------------------ equity curve
-- Every enrolled account's balance snapshot, ~1/min, written by the worker.
-- Drives leader stats, tournament scoring, and drawdown checks.
create table if not exists public.equity_snapshots (
  user_id uuid not null references public.users(id) on delete cascade,
  at timestamptz not null default now(),
  equity double precision not null,
  primary key (user_id, at)
);
create index if not exists equity_snapshots_recent_idx
  on public.equity_snapshots (user_id, at desc);

-- ----------------------------------------------------------- tournaments
create table if not exists public.tournaments (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  metric text not null default 'risk_adjusted_pnl',  -- Score = NetPnL / (1 + MaxDrawdown)
  status text not null default 'scheduled'
    check (status in ('scheduled', 'active', 'settled', 'canceled')),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  entry_fee_usd double precision not null default 0,
  prize_pool_usd double precision not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.tournament_entries (
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  equity_start double precision not null default 0,
  equity_peak double precision not null default 0,
  equity_low double precision not null default 0,
  net_pnl double precision not null default 0,
  max_drawdown double precision not null default 0,
  score double precision not null default 0,
  rank integer,
  primary key (tournament_id, user_id)
);
create index if not exists tournament_entries_active_idx
  on public.tournament_entries (tournament_id, score desc);

-- Periodic ranking snapshot; the mobile app reads the latest row per user.
create table if not exists public.leaderboard_snapshots (
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  at timestamptz not null default now(),
  equity double precision not null default 0,
  net_pnl double precision not null default 0,
  max_drawdown double precision not null default 0,
  score double precision not null default 0,
  primary key (tournament_id, user_id, at)
);

-- ------------------------------------------------------------- caches
-- Worker-owned caches, refreshed from GET /v1/pub/context and the market-data WS.
create table if not exists public.market_cache (
  market_id integer primary key,
  symbol text not null,
  price_decimals integer not null,
  size_decimals integer not null,
  initial_margin integer not null default 1000,   -- hundredths; 1000 = 10% = max 10x
  min_size_scaled bigint not null default 1,
  order_ttl_blocks integer not null default 100,
  updated_at timestamptz not null default now()
);

create table if not exists public.price_cache (
  market_id integer primary key,
  oracle_price bigint,
  mark_price bigint,
  last_price bigint,
  mid_price bigint,
  bid bigint,
  ask bigint,
  price_24h_ago bigint,
  daily_volume text,
  open_interest bigint,
  at timestamptz not null default now()
);

-- --------------------------------------------------------- notifications
-- In-app alerts fanned out to mobile clients over Supabase Realtime.
create table if not exists public.notifications (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  kind text not null,                  -- copy_started, copy_paused, risk_limit, tournament, fill, ...
  payload jsonb not null default '{}'::jsonb,
  read boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);

-- ----------------------------------------------------------------- RLS
alter table public.users enable row level security;
alter table public.perpl_accounts enable row level security;
alter table public.leader_profiles enable row level security;
alter table public.follows enable row level security;
alter table public.copy_settings enable row level security;
alter table public.leader_fills enable row level security;
alter table public.copy_orders enable row level security;
alter table public.copy_pnl_events enable row level security;
alter table public.positions enable row level security;
alter table public.risk_events enable row level security;
alter table public.equity_snapshots enable row level security;
alter table public.tournaments enable row level security;
alter table public.tournament_entries enable row level security;
alter table public.leaderboard_snapshots enable row level security;
alter table public.market_cache enable row level security;
alter table public.price_cache enable row level security;
alter table public.notifications enable row level security;
alter table public.manual_orders enable row level security;
-- link_challenges: service-role only by design (no policies = deny all
-- for client roles; service_role bypasses RLS). Challenges must never
-- be readable or writable by clients.
alter table public.link_challenges enable row level security;

-- users: anyone authenticated may read profiles; users write their own row.
create policy "users are readable" on public.users
  for select to authenticated using (true);
create policy "users insert own" on public.users
  for insert to authenticated with check (id = auth.uid());
create policy "users update own" on public.users
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- perpl_accounts: own rows only; the token/secret are never selected by clients
-- (the API masks them; clients use the REST endpoints instead).
create policy "perpl_accounts are own" on public.perpl_accounts
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- leader_profiles: public read; owners manage their own profile.
create policy "leader_profiles are readable" on public.leader_profiles
  for select to authenticated using (true);
create policy "leader_profiles are own" on public.leader_profiles
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "follows are own" on public.follows
  for all to authenticated using (follower_id = auth.uid()) with check (follower_id = auth.uid());

create policy "copy_settings are own" on public.copy_settings
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "leader_fills are readable" on public.leader_fills
  for select to authenticated using (true);

create policy "copy_orders are own" on public.copy_orders
  for select to authenticated using (user_id = auth.uid());

create policy "manual_orders are own" on public.manual_orders
  for select to authenticated using (user_id = auth.uid());

create policy "copy_pnl_events are own" on public.copy_pnl_events
  for select to authenticated using (user_id = auth.uid());

create policy "positions are own" on public.positions
  for select to authenticated using (user_id = auth.uid());

create policy "risk_events are own" on public.risk_events
  for select to authenticated using (user_id = auth.uid());

create policy "equity_snapshots are readable" on public.equity_snapshots
  for select to authenticated using (true);

create policy "tournaments are readable" on public.tournaments
  for select to authenticated using (true);

create policy "tournament_entries are readable" on public.tournament_entries
  for select to authenticated using (true);
create policy "tournament_entries insert own" on public.tournament_entries
  for insert to authenticated with check (user_id = auth.uid());

create policy "leaderboard_snapshots are readable" on public.leaderboard_snapshots
  for select to authenticated using (true);

create policy "market_cache is readable" on public.market_cache
  for select to authenticated using (true);
create policy "price_cache is readable" on public.price_cache
  for select to authenticated using (true);

create policy "notifications are own" on public.notifications
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ------------------------------------------------------- Realtime tables
-- Mobile clients subscribe to postgres_changes on these tables.
alter publication supabase_realtime add table public.positions;
alter publication supabase_realtime add table public.copy_orders;
alter publication supabase_realtime add table public.manual_orders;
alter publication supabase_realtime add table public.notifications;
alter publication supabase_realtime add table public.leaderboard_snapshots;
alter publication supabase_realtime add table public.price_cache;
alter publication supabase_realtime add table public.risk_events;
alter table public.positions replica identity full;
alter table public.copy_orders replica identity full;
alter table public.manual_orders replica identity full;

-- --------------------------------------------------------------- grants
grant usage on schema public to anon, authenticated, service_role;
grant select on all tables in schema public to anon, authenticated;
grant all on all tables in schema public to service_role;

commit;
