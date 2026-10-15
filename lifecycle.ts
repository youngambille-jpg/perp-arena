// Lifecycle test: partial-fill accumulation, no double-count,
// reconciler dry-run skip, and DRY_RUN order simulation.
// Needs local Postgres :55433 with fresh schema + Perpl testnet
// (for market context). Run: pnpm exec tsx lifecycle.ts

process.env.SUPABASE_DB_URL =
  'postgresql://runner@/postgres?host=/tmp/opencode/pgsock&port=55433';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
process.env.KEY_ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DRY_RUN = 'true';

const { pool } = await import('./src/lib/db.js');
const { marketRegistry } = await import('./src/perpl/context.js');
const { CopyEngine } = await import('./src/engine/copyEngine.js');
const { MarketDataClient } = await import('./src/perpl/marketDataWs.js');

let failures = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) console.log(`ok   ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name}`, JSON.stringify(extra)?.slice(0, 300) ?? '');
  }
};

await marketRegistry.refresh();
const btc = marketRegistry.market(16)!;
check('btc context normalized live', btc.price_decimals === 1, btc);

const alice = '11111111-1111-1111-1111-111111111111';
const leader = '22222222-2222-2222-2222-222222222222';
await pool.query(`insert into auth.users (id) values ($1), ($2)`, [
  alice,
  leader,
]);
await pool.query(
  `insert into public.users (id, handle) values ($1, 'alice'), ($2, 'bob')`,
  [alice, leader],
);

// Sessions stub: leader equity $20k; follower session "ready".
// Market data stub: BTC last price = live mark.
const marketData = new MarketDataClient();
const live = await import('./src/perpl/rest.js').then((m) =>
  m.fetchTickers(),
);
const btcLast = live.d[16]?.lst ?? live.d[16]?.mrk ?? 0;
(marketData as unknown as { stateFor: (id: number) => unknown }).stateFor =
  (id: number) => (id === 16 ? { lst: btcLast } : undefined);

const sessions = {
  sessionFor: (_u: string) => ({ ready: true }) as never,
  restFor: (_u: string) => undefined,
  equityOf: (u: string) => (u === leader ? 20000 : 1000),
};
const engine = new CopyEngine(sessions as never, marketData);

await pool.query(
  `insert into copy_settings
     (user_id, leader_id, allocation_usd, max_leverage,
      max_notional_per_trade_usd, daily_loss_limit_usd,
      weekly_drawdown_limit_bps, enabled)
   values ($1, $2, 1000, 3, 5000, 50000, 5000, true)`,
  [alice, leader],
);

// --- DRY_RUN: leader opens $10k BTC long on $20k equity ---------------
// fraction 0.5 -> $500 target on $1k allocation.
await engine.onLeaderPositions(leader, [
  { id: 7, mkt: 16, acc: 9, t: 1, s: 117600, p: 850000 } as never,
]);
const { rows: dryRows } = await pool.query(
  `select * from copy_orders where user_id = $1`,
  [alice],
);
check(
  'dry-run writes flagged row, submits nothing real',
  dryRows.length === 1 &&
    dryRows[0].dry_run === true &&
    Number(dryRows[0].request_id) < 0 &&
    dryRows[0].status === 'submitted',
  dryRows[0],
);

// --- fill accumulation: real (non-dry) close order --------------------
await pool.query(
  `insert into positions
     (user_id, market_id, perpl_position_id, side, size_scaled,
      entry_price_scaled, leverage_hundredths, leader_id)
   values ($1, 16, '42', 1, '10000', '830000', 500, $2)`,
  [alice, leader],
);
await pool.query(
  `insert into copy_orders
     (user_id, leader_id, market_id, order_type, size_scaled,
      price_scaled, leverage_hundredths, notional_usd, request_id,
      status, dry_run)
   values ($1, $2, 16, 3, '10000', '0', 0, 500, '9001', 'open', false)`,
  [alice, leader],
);

const fill1 = { mkt: 16, acc: 5, oid: 111, t: 3, s: 4000, p: 840000 };
await engine.onFollowerFill(alice, fill1 as never, 9001);
let { rows: r1 } = await pool.query(
  `select status, filled_size_scaled from copy_orders where request_id = '9001'`,
);
check(
  'partial fill -> status partial, filled 4000',
  r1[0]?.status === 'partial' && r1[0]?.filled_size_scaled === '4000',
  r1[0],
);

const fill2 = { mkt: 16, acc: 5, oid: 111, t: 3, s: 6000, p: 840000 };
await engine.onFollowerFill(alice, fill2 as never, 9001);
let { rows: r2 } = await pool.query(
  `select status, filled_size_scaled from copy_orders where request_id = '9001'`,
);
check(
  'second fill completes -> filled 10000',
  r2[0]?.status === 'filled' && r2[0]?.filled_size_scaled === '10000',
  r2[0],
);

await engine.onFollowerFill(alice, fill2 as never, 9001); // duplicate
const { rows: pnl } = await pool.query(
  `select count(*)::int as n, coalesce(sum(realized_usd),0) as total
     from copy_pnl_events where user_id = $1`,
  [alice],
);
// Each close fill records its own share: (840000-830000)/1e1/1e5 * size.
const unit = (840000 - 830000) / 10 / 100000; // per scaled unit
const expected = unit * 4000 + unit * 6000;
check(
  'no double-count on duplicate fill (2 events, exact total)',
  pnl[0]?.n === 2 && Math.abs(Number(pnl[0]?.total) - expected) < 1e-9,
  { ...pnl[0], expected },
);

// --- reconciler: dry-run rows skipped, stale real rows failed --------
await pool.query(
  `insert into copy_orders
     (user_id, leader_id, market_id, order_type, size_scaled, status,
      dry_run, created_at)
   values ($1, $2, 16, 1, '100', 'submitted', true, now() - interval '30 minutes'),
          ($1, $2, 16, 1, '100', 'submitted', false, now() - interval '30 minutes')`,
  [alice, leader],
);
await engine.reconcileOnce(); // restFor -> undefined: both untouched
let { rows: rr } = await pool.query(
  `select status, dry_run from copy_orders where size_scaled = '100' order by dry_run`,
);
check(
  'reconciler leaves young rows alone without REST',
  rr.length === 2 && rr.every((r) => r.status === 'submitted'),
  rr,
);

await pool.end();
if (failures > 0) {
  console.log(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\nall lifecycle tests passed');
