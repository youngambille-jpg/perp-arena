# Perpl Arena — backend

Express + TypeScript backend for **Perpl Arena**: follow proven Perpl
perp traders, copy their trades within your own risk limits, and compete
in risk-adjusted tournaments. Thin mobile client, backend trading brain,
Supabase Postgres as the source of truth, Supabase Realtime for live UI
updates. No Redis in v1.

Built against the Perpl API documented at
https://docs.perpl.xyz/resources/for-developers/api/typescript
(Ed25519 API keys, signed REST, market-data + trading WebSockets,
scaled-integer prices/sizes, builder codes).

## Processes

| Process | Entry | Does |
| ------- | ----- | ---- |
| API | `pnpm dev` → `src/index.ts` | Mobile REST API (auth, markets, accounts, leaders, copy, tournaments, dashboard) |
| Worker | `pnpm dev:worker` → `src/worker.ts` | Perpl market-data WS, per-key trading sessions, copy engine, leader stats, tournament scoring |

```
Mobile app ⇄ REST API ⇄ Postgres (+ Realtime → app)
                 ▲
                 │ reads settings / writes events
Perpl worker ────┘
   ├── market-data WS (prices, head block)
   ├── trading WS per enrolled key (positions, fills, orders)
   └── copy / risk / tournament engines
```

## Setup

1. **Supabase project.** Create a project, then apply the schema:
   ```bash
   export SUPABASE_DB_URL='postgresql://postgres:[password]@db.[ref].supabase.co:5432/postgres'
   pnpm db:push
   ```
2. **Environment.** Copy `.env.example` to `.env` and fill in:
   - `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
   - `KEY_ENCRYPTION_KEY` — `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   - Perpl network: testnet defaults are pre-filled; swap the four
     `PERPL_*` values for mainnet (`app.perpl.xyz`, chain `143`).
   - `PERPL_BUILDER_ID` — issued by Perpl out of band; `0` disables fees.
   - `APP_ORIGIN` — must be whitelisted by Perpl for key enrollment.
   - `DRY_RUN=true` on the worker to prevent real orders while testing.
3. **Install & run.**
   ```bash
   pnpm install
   pnpm dev          # API on :8080
   pnpm dev:worker   # trading brain (separate shell)
   pnpm dev:tunnel   # API with a public ngrok URL (requires NGROK_AUTHTOKEN)
   ```
   Development commands load environment variables from `.env`. Production
   start commands load `.env` if present, and also work with variables injected
   by the deployment platform.
   Set `NGROK_AUTHTOKEN` in `.env` before starting the tunnel. Optionally set
   `NGROK_DOMAIN` to use a reserved ngrok domain; for account enrollment, set
   `APP_ORIGIN` to that public origin and ensure it is whitelisted by Perpl.
   The API currently sends permissive `Access-Control-Allow-Origin: *` headers
   for browser previews; do not use cookie-based authentication with this policy.
   Keep `APP_ORIGIN` set to the origin Perpl has whitelisted; CORS does not
   change the origin sent to Perpl.

   For production, run `pnpm start` and `pnpm start:worker` as separate
   long-running processes against the same database. Configure both services
   with the required environment variables in the platform's secret manager.
   The worker needs no public port. The API alone does not maintain live
   prices, wallet balances, positions, or order processing. Each process
   limits its Postgres pool to 5 connections to leave capacity under Supabase
   session-pooler limits; run one API instance and one worker unless the
   database connection budget is adjusted.

### Deploy API and worker together with Docker Compose

The API and worker run as separate containers from separate Dockerfiles:
`Dockerfile` (API) and `Dockerfile.worker` (worker). From this directory:

```bash
Copy-Item .env.example .env   # PowerShell; edit .env and fill in credentials
docker compose up --build -d
docker compose ps
docker compose logs -f api worker
```

Compose publishes only the API port. The worker has no public port and is
restarted if it exits. Both containers use the same `.env` and database.
`DRY_RUN` defaults to `true` in the example config and Compose setup; set it to
`false` explicitly only when you intend the worker to submit live orders.
Keep `.env` out of source control and Docker build contexts. Stop the stack
with `docker compose down`; persisted state remains in Supabase Postgres.

### Deploy the worker separately

The API and the worker share no network link. They coordinate only through
Supabase Postgres: the API writes rows (`copy_settings`, `manual_orders`,
`leader_profiles`, enrolled `perpl_accounts`) and the worker polls them, and
both write state the app reads. The worker never calls the API, so **there is
no app URL to pass to it** — it needs the database, not the API's address.

Use `Dockerfile.worker` for the worker service on a host that is separate from
the API host:

```bash
docker build -f Dockerfile.worker -t perpl-arena-worker:local .
```

The worker exposes no port and needs no inbound access; it makes outbound
connections to Supabase and Perpl only. Run it as a background/worker service
(not a web service) and restart-on-exit.

Inject the **same** Supabase and Perpl values the API uses:

- `SUPABASE_DB_URL` — must be the same database the API writes to.
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` — required at
  boot by `src/config.ts` for both processes.
- `KEY_ENCRYPTION_KEY` — **must be byte-for-byte identical to the API's.**
  Keys enrolled through the API are AES-256-GCM encrypted with it; a different
  value makes the worker fail to decrypt stored key material.
- `PERPL_API_URL`, `PERPL_WS_URL`, `PERPL_CHAIN_ID`, `PERPL_BUILDER_ID`,
  `PERPL_BUILDER_FEE_PER_100K` — the same network (testnet vs mainnet) as the API.
- `DRY_RUN` — worker-only; `true` simulates orders.

`APP_ORIGIN` is only the origin sent to Perpl during key enrollment; it is the
API's public origin, not an address the worker dials.

`docker compose up --build -d` is for a single Docker host that supports
Compose and is the quickest way to run both together. For managed platforms
that accept only one Dockerfile per service, deploy two services: the API from
`Dockerfile` (`node dist/index.js`) with the HTTP port exposed, and the worker
from `Dockerfile.worker` (`node dist/worker.js`) with no port. Inject the same
environment variables into both.

## Key enrollment (mobile flow)

1. App generates an Ed25519 key pair locally.
2. `POST /accounts/enroll/payload` → EIP-712 `typedData` + `mac`
   (server injects `builder_id` + `max_builder_fee_per_100k` so the
   user signs the fee ceiling in their wallet prompt).
3. User signs with their wallet; app also produces the
   Ed25519 proof-of-possession signature.
4. `POST /accounts/enroll` → Perpl enrolls the key, server stores
   the token + private key **AES-256-GCM encrypted** and returns a
   non-secret summary. (Or `POST /accounts/import` for keys made in
   the Perpl web UI.)

**Local alternative:** `scripts/enroll-testnet.sh` enrolls a key
directly against Perpl testnet from your own machine (useful where
the backend host is geo-blocked from the enrollment endpoint with
HTTP 451). It prints an import command for `/accounts/import` at
the end. Testnet wallets only.

Enrollment errors preserve the Perpl cases the app needs to route:
`404 no_account`, `409 key_taken`, and `423 key_limit`; other upstream
failures return `502 enrollment_failed`.

`GET /meta/account-creation` returns the current chain, exchange,
collateral-token, and minimum account-open/deposit values from Perpl's
public context endpoint. `GET /dashboard` includes the latest mirrored
`balance`, `locked`, and `walletAt`; those remain `null` until the worker
receives a wallet snapshot for an active enrolled key. `PUT /users/me`
creates or updates the authenticated user's handle.

## Copy engine

Risk translation, not mirroring — `src/engine/risk.ts` is pure and
unit-tested (`pnpm test:smoke`):

```
fraction       = leaderNotional / leaderEquity
targetNotional = allocation × fraction
targetNotional = min(targetNotional, allocation × leverage, maxPerTrade)
leverage       = min(implied, maxLeverage)
```

Guardrails: market allow/blacklists, per-trade + exposure caps,
daily loss limit (realized + unrealized), 7-day drawdown cutoff,
per-position stop-loss, anti-frontrun copy delay, IOC market orders
with slippage cap, reduce-only mode, one-tap kill switch
(`POST /copy/kill-switch`, consumed by the worker in ~1s).

Fills correlate back to `copy_orders` via the Perpl `rq`
idempotency key; stale `submitted` rows are finalized by the
reconciler from REST order-history. Builder fees (`bf`) go only on
opening/increasing orders, capped by each key's signed ceiling;
`bfa` on fills is the builder portion of the gross fee (never added).

Known v1 limitation: a follower position on a market is attributed
to the first active copy setting whose leader holds that market —
single-leader-per-market is the supported shape.

## Tournaments

Weekly risk-adjusted contests. `Score = NetPnL / (1 + MaxDrawdown)`
rewards profit without blowups. `TournamentEngine` scores active
tournaments from entrants' equity curves, writes ranks to
`tournament_entries` + `leaderboard_snapshots` (Realtime-enabled),
and settles on wall clock with winner notifications.

## API reference

Auth: `Authorization: Bearer <supabase access token>`, 60 req/min
per user. Errors: `{ error: { code, message } }`.

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET | `/health` | liveness, DB + market-context status (public) |
| GET | `/markets` | cached configs + live prices (public) |
| GET | `/markets/:id/candles?resolution=&hours=` | OHLCV, human units (public) |
| POST | `/accounts/enroll/payload` | EIP-712 enrollment payload (+ builder terms) |
| POST | `/accounts/enroll` | complete enrollment, store encrypted key |
| POST | `/accounts/import` | store an existing enrolled key pair |
| GET/DELETE | `/accounts`, `/accounts/:id` | list / revoke (revoke also pauses copying) |
| GET | `/leaders?...` | filter by winRate, drawdown, Sharpe, style; sort by PnL/followers |
| GET | `/leaders/follows` | leaders the caller follows + copy status |
| GET | `/leaders/:id` | profile, live positions, 50 recent fills |
| PUT | `/leaders/me` | publish/update own leader profile |
| POST/DELETE | `/leaders/:id/follow` | follow / unfollow |
| PUT/GET/DELETE | `/copy/:leaderId`, `/copy` | risk-limited copy settings |
| POST | `/copy/kill-switch` | close all copied positions, pause copying |
| GET | `/copy/orders`, `/copy/risk-events` | audit trail, guardrail history |
| GET | `/tournaments`, `/tournaments/:id` | list, detail + standings |
| GET | `/tournaments/me/entries` | caller's entries |
| POST | `/tournaments/:id/join` | enter (requires enrolled key) |
| GET | `/dashboard` | equity, positions, active copies, today's PnL, notifications |
| POST | `/dashboard/notifications/read` | mark read |

Mobile realtime: subscribe with the Supabase client to
`postgres_changes` on `positions`, `copy_orders`, `notifications`,
`leaderboard_snapshots`, `price_cache`, `risk_events`.

## Testing

- `pnpm typecheck` — strict `tsc`, must be clean.
- `pnpm test:smoke` — 16 checks: scaling math, risk translation,
  stop-loss, drawdown, tournament score, encrypt round-trip, app
  boot, auth gating. No DB or network needed.
- `pnpm test:integration` — tournament scoring + leader stats
  against a real Postgres (schema validated on Postgres 16:
  constraints, case-insensitive enroll upsert, realtime tables).
- `pnpm test:lifecycle` — fill accumulation (partial → filled, no
  double-count on duplicates), reconciler behavior, and a DRY_RUN
  copy cycle against local Postgres + live testnet context.
- `pnpm test:e2e` — 20 checks against the running API + live
  Supabase (creates and deletes its own auth users).
- `pnpm build` / `pnpm start`, `pnpm start:worker` for production.

Supabase deployment checklist:
- Enable anonymous sign-ins in **Authentication → Sign In / Providers**.
- Apply `sql/schema.sql`. Its `authenticated` policies scope private Realtime
  rows to `auth.uid()`; `price_cache` and public rankings intentionally allow
  authenticated reads.
- Verify `positions`, `copy_orders`, `manual_orders`, `notifications`,
  `risk_events`, `leaderboard_snapshots`, and `price_cache` are in the
  `supabase_realtime` publication. `positions`, `copy_orders`, and
  `manual_orders` use `REPLICA IDENTITY FULL` for update/delete payloads.

Set `DRY_RUN=true` on the worker to simulate copying without
submitting orders; simulated rows are flagged `dry_run` and the
reconciler skips them.

## Troubleshooting

- **DB host resolves to IPv6 only.** If `SUPABASE_DB_URL` uses
  `db.<ref>.supabase.co` and your host has no IPv6 route, direct
  Postgres connections fail with `ENOTFOUND`. Switch to the
  Supavisor pooler URL from the Supabase dashboard (Settings →
  Database → Connection pooling, port `6543`, user
  `postgres.<ref>`). The API and worker both degrade gracefully
  without a DB (health reports `db:false`, public market routes
  that don't need Postgres keep working), but enrollment,
  copying, and tournaments need it.
- **Market-data socket closed with 1008 ~10s after connect.**
  The server closes connections that never subscribe. The client
  (re)subscribes the full set on every `onopen` — a delta-only
  resubscribe after reconnect silently drops the subscription
  and reproduces this cycle.
- **Wire shape vs docs.** `GET /v1/pub/context` nests scaling and
  margin fields under `market.config` (`price_decimals`,
  `size_decimals`, `initial_margin`) with `order_ttl_blocks`
  top-level. `MarketRegistry` normalizes this into the flat
  internal shape; always read `initial_margin` (testnet BTC is
  1500 = ~6.6x max, not 10x) and `order_ttl_blocks` (testnet BTC
  is 20) live.
- **Port 8080 shadowed.** On Replit, something answers on 8080
  before your server (HTML proxy 404s). Run on another port
  (`PORT=8099 pnpm dev`) — the JSON 404 envelope distinguishes
  your server from the proxy.
