# Perpl Arena API update

This document describes the backend additions for the mobile frontend. The
backend is an Express API; the local default is `http://localhost:8080`.
The current ngrok address is temporary and can change when its tunnel restarts.

## Request conventions

- Protected endpoints require the `Authorization` header containing the
  caller's Supabase access token; the client must not send a `userId`.
- JSON request bodies use `Content-Type: application/json`.
- Errors use `{ "error": { "code": "...", "message": "..." } }`.
- Protected API requests are rate-limited to 60 requests per user per minute.
- CORS currently allows every origin (`Access-Control-Allow-Origin: *`).
  This is intended for the current browser preview, not cookie-based auth.

## New and updated endpoints

### `GET /.well-known/assetlinks.json` — public

Returns the Android Digital Asset Links statement for the AUSD Wallet app.
This exact, singular `assetlinks.json` path is the Android-standard URL.
`GET /.well-known/assetslinks.json` (with an extra `s`) is also provided as a
compatibility alias.

```json
[
  {
    "relation": ["delegate_permission/common.get_login_creds"],
    "target": {
      "namespace": "android_app",
      "package_name": "com.pera.mobile",
      "sha256_cert_fingerprints": [
        "FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C"
      ]
    }
  }
]
```

After deploying the API to Aiven, verify that
`https://<deployed-api-host>/.well-known/assetlinks.json` returns HTTP 200
with `Content-Type: application/json`. Android associates the statement with
the exact web domain used by the app; if the app's sign-in origin is another
domain, serve the same file there too and configure that origin in the Android
app.

### `GET /meta/account-creation` — public

Proxies Perpl's public context and returns the current chain, exchange
instance, collateral token, and account funding minimums. Use this instead of
hardcoding token addresses, decimals, or minimum amounts.

Example response:

```json
{
  "chainId": 10143,
  "network": "Monad Testnet",
  "exchangeAddress": "0x1964c32f0be608e7d29302aff5e61268e72080cc",
  "collateralToken": {
    "id": 1,
    "address": "0xa9012a055bd4e0edff8ce09f960291c09d5322dc",
    "symbol": "AUSD",
    "name": "AUSD",
    "decimals": 6
  },
  "minAccountOpenAmount": {
    "raw": "100000000",
    "amount": 100
  },
  "minDepositAmount": {
    "raw": "10000000",
    "amount": 10
  }
}
```

`raw` is the integer token amount in its smallest units. `amount` is that value
divided by `10 ** collateralToken.decimals`; use raw units for contract calls
and the display amount for UI copy. The example reflects the testnet context
checked on 2026-10-13; values may change.

Errors:

- `502 account_metadata_unavailable` — Perpl context request failed.
- `502 account_metadata_invalid` — the returned context is missing required
  instance, token, or amount information.

### `GET /dashboard/` — authenticated

Returns the existing home-screen data and the wallet balance fields newly
mirrored from the worker's Perpl trading-WebSocket wallet snapshot.

```json
{
  "equity": 125.5,
  "equityAt": "2026-10-13T13:45:00.000Z",
  "balance": 100,
  "locked": 12.5,
  "walletAt": "2026-10-13T13:45:01.000Z",
  "positions": [],
  "activeCopySettings": [],
  "realizedPnlToday": 0,
  "unreadNotifications": []
}
```

- `balance`, `locked`, and `walletAt` are `null` until the worker has stored a
  wallet snapshot for an active enrolled key.
- `equity` is the latest worker-computed equity snapshot and can also be
  `null` until the worker records one.
- Balance amounts are USD-denominated values converted from Perpl's
  six-decimal collateral units.
- The backend currently aggregates mirrored balance and locked amounts across
  the caller's active enrolled keys.
- The API process alone does not refresh wallet state. Run the worker against
  the same database for live values.

### `POST /accounts/enroll` — authenticated

Completes the existing two-step API-key enrollment flow. Perpl failures now
preserve the status/code combinations the app needs:

| HTTP | `error.code` | Frontend action |
| --- | --- | --- |
| 404 | `no_account` | Route to the Fund/account-creation flow. |
| 409 | `key_taken` | Generate a fresh keypair and retry once. |
| 423 | `key_limit` | Ask the user to revoke an existing key at Perpl. |
| 502 | `enrollment_failed` | Show a generic enrollment/upstream failure. |

Other enrollment request validation errors remain `400 invalid_body`.
`POST /accounts/enroll/payload` has not received this status mapping: an
upstream error there remains `502 enrollment_failed`.

Request body:

```json
{
  "address": "0x...",
  "typedData": {},
  "mac": "...",
  "signature": "0x...",
  "popSignature": "0x...",
  "privateKey": "0x<64 hex characters>",
  "label": "mobile key",
  "builderBound": false
}
```

The `typedData` and `mac` come from `POST /accounts/enroll/payload`; the
wallet signature and Ed25519 proof-of-possession signature are produced by the
client. The private key is sent for encrypted server-side storage and must
never be logged or exposed in client diagnostics. On success, the API returns
`201 { "account": <non-secret account summary> }`.

### `PUT /users/me` — authenticated

Creates or updates the authenticated user's handle. Handles are trimmed,
3–24 characters, and limited to ASCII letters, digits, and underscore.

Request:

```json
{ "handle": "my_handle" }
```

Success: `{ "user": { "id": "...", "handle": "my_handle", ... } }`

Errors:

- `400 invalid_body` — invalid handle format or length.
- `409 conflict` — handle is already taken.

The existing `GET /users/me`, `GET /users/link-challenge`, and
`POST /users/link-wallet` endpoints remain available for profile reads and
wallet linking.

## CORS

The API responds to browser preflight `OPTIONS` requests without requiring
authentication. It currently allows all origins, the `GET`, `HEAD`, `POST`,
`PUT`, `DELETE`, and `OPTIONS` methods, and the `Authorization` and
`Content-Type` and `ngrok-skip-browser-warning` headers. The latter is needed
when web clients send ngrok's browser-warning bypass header, which causes a
CORS preflight. This is deliberately permissive for development. It does not
change the separate `APP_ORIGIN` header sent by the backend to Perpl during key
enrollment; that value must remain a Perpl-whitelisted origin.

## Supabase Realtime and database update

`sql/schema.sql` includes:

- Publication entries for `price_cache`, `positions`, `copy_orders`,
  `manual_orders`, `notifications`, `risk_events`, and
  `leaderboard_snapshots`.
- `authenticated` read policies: user-owned rows are scoped by `user_id =
  auth.uid()` (or the table's corresponding owner field); market data and
  public leaderboard data are readable to authenticated users.
- `REPLICA IDENTITY FULL` for `positions`, `copy_orders`, and `manual_orders`
  for complete update/delete payloads.
- Wallet mirror columns on `perpl_accounts` for balance, locked amount, and
  snapshot time.

Apply the schema/migration to the deployed Supabase database before using
dashboard wallet fields or subscribing to Realtime. Enable anonymous sign-in
in Supabase Auth; the client uses the resulting Supabase access token for API
requests and Realtime. The API and worker connect with the service-role
database connection and bypass RLS.

### Deploying the worker

The included `Dockerfile` builds the production image and `compose.yaml`
starts the API and worker together:

```powershell
Copy-Item .env.example .env
# Edit .env with deployment credentials before starting.
docker compose up --build -d
docker compose ps
docker compose logs -f api worker
```

Compose exposes the API only; the worker has no port. Both services share
`.env`, restart on failure, and connect to the same database. The worker's
`DRY_RUN` defaults to `true` in the Compose configuration; explicitly set
`DRY_RUN=false` only when live trading is intended. Keep `.env` out of source
control and the image build context.

For hosts without Compose, deploy the same image as **two long-running
services**:

| Service | Build command | Start command | Public HTTP port |
| --- | --- | --- | --- |
| API / web service | `pnpm install --frozen-lockfile && pnpm build` | `pnpm start` | Yes; set `PORT` if required by the host. |
| Worker / background service | `pnpm install --frozen-lockfile && pnpm build` | `pnpm start:worker` | No. |

The worker is `dist/worker.js`; it opens the Perpl market-data WebSocket and
trading sessions, persists snapshots, and runs copy/order processing. It does
not expose an HTTP server, so select the host's background-worker/process
service rather than a second web service. Configure both processes with the
same `SUPABASE_DB_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, `KEY_ENCRYPTION_KEY`, and `PERPL_*` values.
Production start scripts read platform-injected environment variables and
also load `.env` if it exists. Set `DRY_RUN=true` on the worker for safe
testing; leave it false only when you intend to submit live orders.
Each API/worker process limits its Postgres pool to five connections because
the Supabase session pooler has a shared connection cap. Run one API and one
worker instance unless the database connection budget is increased. Worker
position mirroring reuses its transaction connection for related queries to
avoid checking out additional pool connections while holding a transaction.

Enable automatic restart on process failure in the host. Check worker logs for
market-context load, market-data WebSocket connection, session registry
startup, and `worker running`. Run one worker instance initially; scaling out
multiple workers can cause duplicate processing unless worker coordination is
added. Do not deploy the worker with `pnpm dev:worker`, which is a watch-mode
development command.

### Applying and verifying Realtime configuration

For a brand-new database, run `sql/schema.sql` once. On an existing database,
do not blindly rerun it: policy creation and publication additions in the
initial schema are not all idempotent. Apply any missing wallet columns and
Realtime settings as a migration instead. The following is safe to run in the
Supabase SQL Editor for the worker wallet fields and Realtime publication:

```sql
alter table public.perpl_accounts
  add column if not exists wallet_balance_usd double precision,
  add column if not exists wallet_locked_usd double precision,
  add column if not exists wallet_updated_at timestamptz;

alter table public.positions replica identity full;
alter table public.copy_orders replica identity full;
alter table public.manual_orders replica identity full;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'price_cache',
    'positions',
    'copy_orders',
    'manual_orders',
    'notifications',
    'risk_events',
    'leaderboard_snapshots'
  ] loop
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = table_name
    ) then
      execute format(
        'alter publication supabase_realtime add table public.%I',
        table_name
      );
    end if;
  end loop;
end
$$;
```

In the Supabase dashboard, also verify **Database → Publications →
`supabase_realtime`** contains those seven tables. In **Authentication →
Sign In / Providers**, enable anonymous sign-ins. Anonymous Supabase users
receive JWTs with the `authenticated` Postgres role; the user's JWT `sub`
must match `public.users.id` for owner-scoped policies to expose their rows.

The schema defines authenticated read policies for the app's subscriptions:
owner filters for `positions`, `copy_orders`, `manual_orders`, `notifications`,
and `risk_events`; public authenticated reads for `price_cache` and
`leaderboard_snapshots`. Verify the deployed DB has these policies after the
migration. Keep table grants and RLS policies aligned; publication membership
alone does not grant the client access to rows.

### Frontend subscription example

Use the Supabase client with the signed-in user's access token. Subscribe to
the user's own rows on private tables; `price_cache` and public leaderboard
updates can be consumed without a `user_id` filter (or filtered client-side):

```ts
const channel = supabase
  .channel(`arena:${userId}`)
  .on(
    'postgres_changes',
    {
      event: '*',
      schema: 'public',
      table: 'positions',
      filter: `user_id=eq.${userId}`,
    },
    (payload) => onPositionsChanged(payload),
  )
  .on(
    'postgres_changes',
    {
      event: '*',
      schema: 'public',
      table: 'copy_orders',
      filter: `user_id=eq.${userId}`,
    },
    (payload) => onCopyOrderChanged(payload),
  )
  .on(
    'postgres_changes',
    {
      event: '*',
      schema: 'public',
      table: 'price_cache',
    },
    (payload) => onPriceChanged(payload),
  )
  .subscribe();

// When leaving the screen/session:
await supabase.removeChannel(channel);
```

Repeat the user-filtered subscription for `manual_orders`, `notifications`,
and `risk_events`. Subscribe to `leaderboard_snapshots` for tournament ranks.
Realtime is an update stream, not the initial state: fetch the relevant REST
snapshot first, then subscribe and reconcile incoming events. Realtime events
do not count against this API's 60-request/minute REST rate limit.

## Operations / integration notes

- Set `APP_ORIGIN` to the origin whitelisted with Perpl. It is sent on enroll
  requests and is independent from API CORS.
- Run both `pnpm start` and `pnpm start:worker` against the same database.
  Without the worker, wallet balance, equity, live prices, positions, and
  order processing will not stay current.
- For testing, set `DRY_RUN=true` on the worker if copied orders must be
  simulated rather than submitted.
- `GET /markets/` and `GET /markets/:id/candles` are existing public endpoints.
  `GET /health/` reports API/database health and the loaded Perpl market count.
