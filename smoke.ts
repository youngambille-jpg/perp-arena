// Smoke test: pure engine math + app boot. Run with:
//   pnpm exec tsx smoke.ts
// No DB or network required (except the candle test, skipped offline).

process.env.SUPABASE_DB_URL = 'postgresql://localhost:5432/test';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
process.env.KEY_ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const { translateOrder, stopLossBreached, maxDrawdownBps } = await import(
  './src/engine/risk.js'
);
const {
  notionalToScaledSize,
  scaledSizeToNotional,
  rawToUsd,
  leverageToHundredths,
} = await import('./src/perpl/scaling.js');
const { tournamentScore } = await import('./src/engine/tournaments.js');
const { encrypt, decrypt } = await import('./src/lib/crypto.js');
const { enrollmentError } = await import('./src/api/routes/accounts.js');
const { privateKeyFromHex } = await import('./src/perpl/rest.js');
const ed = await import('@noble/ed25519');

let failures = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) console.log(`ok   ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name}`, extra ?? '');
  }
};

// ---- scaling ------------------------------------------------------------
// BTC mainnet: price_decimals=1, size_decimals=5. $95,000, 0.1 BTC.
const btc = { price_decimals: 1, size_decimals: 5 } as never;
const size = notionalToScaledSize(btc, 9500, 950000n);
check('notional->size (0.1 BTC)', size === 10000n, size);
check(
  'size->notional round trip',
  Math.abs(scaledSizeToNotional(btc, 10000n, 950000n) - 9500) < 1e-9,
);
check('rawToUsd', rawToUsd(100_000_000n) === 100);
check('leverage hundredths', leverageToHundredths(10) === 1000);

// ---- risk translation -----------------------------------------------------
const settings = {
  user_id: 'u1',
  leader_id: 'l1',
  allocation_usd: 1000,
  max_leverage: 3,
  max_notional_per_trade_usd: 5000,
  daily_loss_limit_usd: 50,
  weekly_drawdown_limit_bps: 1000,
  market_allowlist: [],
  market_blacklist: [],
  slippage_bps: 50,
  copy_delay_ms: 0,
  reduce_only: false,
  stop_loss_bps: 2000,
  enabled: true,
  paused_reason: null,
  kill_switch_requested_at: null,
  updated_at: '',
};

// Leader: $10k notional on $20k equity = 50% fraction.
// Follower $1k allocation -> $500 target, leverage min(0.5, 3)=0.5x.
const market = {
  id: 1,
  symbol: 'BTC',
  price_decimals: 1,
  size_decimals: 5,
  min_size: 1,
} as never;
const t1 = translateOrder({
  leaderNotionalUsd: 10_000,
  leaderEquityUsd: 20_000,
  leaderSide: 1,
  settings,
  market,
  priceScaled: 950000n,
});
check(
  'translation scales by allocation/equity',
  t1.kind === 'order' &&
    Math.abs((t1 as { notionalUsd: number }).notionalUsd - 500) < 1e-9,
  t1,
);

// Leverage clamp: leader 20x fraction on 1x... fraction 200% -> leverage min(2, 3)=2,
// target min(2000, 1000*2=2000, 5000) = 2000.
const t2 = translateOrder({
  leaderNotionalUsd: 40_000,
  leaderEquityUsd: 20_000,
  leaderSide: 2,
  settings,
  market,
  priceScaled: 950000n,
});
check(
  'translation clamps to allocation*leverage',
  t2.kind === 'order' &&
    Math.abs((t2 as { notionalUsd: number }).notionalUsd - 2000) < 1e-9 &&
    (t2 as { type: number }).type === 2,
  t2,
);

// Blacklist skip.
const t3 = translateOrder({
  leaderNotionalUsd: 10_000,
  leaderEquityUsd: 20_000,
  leaderSide: 1,
  settings: { ...settings, market_blacklist: [1] },
  market,
  priceScaled: 950000n,
});
check('blacklisted market skips', t3.kind === 'skip', t3);

// Stop-loss: long, entry 100, now 79 -> 21% adverse, 2000bps SL breached.
check('stop loss (long) breached', stopLossBreached(1, 100n, 79n, 2000));
check('stop loss (long) holds', !stopLossBreached(1, 100n, 85n, 2000));
// Short, entry 100, now 121 -> 21% adverse -> breached.
check('stop loss (short) breached', stopLossBreached(2, 100n, 121n, 2000));

// Drawdown: peak 100, trough 90 -> 1000 bps.
check('maxDrawdownBps', maxDrawdownBps([100, 110, 99, 105]) === 1000);

// Tournament score: 100 PnL, 25% DD -> 80.
check('tournamentScore', tournamentScore(100, 0.25) === 80);

// ---- crypto round trip ------------------------------------------------------
const secret = 'super-secret-api-key-token';
check('encrypt/decrypt round trip', decrypt(encrypt(secret)) === secret);
const testPrivateKeyHex = 'ab'.repeat(32);
const testPrivateKey = privateKeyFromHex(`0x${testPrivateKeyHex}`);
check(
  'private key decoder accepts 0x-prefixed 32-byte keys',
  testPrivateKey.length === 32 &&
    testPrivateKey.toString('hex') === testPrivateKeyHex,
);
const testSignature = await ed.signAsync(
  new Uint8Array([1, 2, 3]),
  testPrivateKey,
);
check('decoded private key signs with noble ed25519', testSignature.length === 64);
let invalidPrivateKeyRejected = false;
try {
  privateKeyFromHex('0x' + 'ab'.repeat(31));
} catch {
  invalidPrivateKeyRejected = true;
}
check('private key decoder rejects invalid lengths', invalidPrivateKeyRejected);
check(
  'enrollment no-account error mapping',
  enrollmentError(404).status === 404 &&
    enrollmentError(404).code === 'no_account',
);
check(
  'enrollment key-taken error mapping',
  enrollmentError(409).status === 409 &&
    enrollmentError(409).code === 'key_taken',
);
check(
  'enrollment key-limit error mapping',
  enrollmentError(423).status === 423 &&
    enrollmentError(423).code === 'key_limit',
);
check(
  'other enrollment failures remain gateway errors',
  enrollmentError(500, 'upstream').status === 502 &&
    enrollmentError(500, 'upstream').code === 'enrollment_failed',
);

// ---- app boot (no DB: health reports db:false) -------------------------------
const { createApp } = await import('./src/api/server.js');
const app = createApp();
const server = app.listen(0);
await new Promise<void>((r) => server.on('listening', () => r()));
const port = (server.address() as { port: number }).port;
const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) =>
  r.json(),
);
check('health endpoint responds', health.db === false, health);
const notFound = await fetch(`http://127.0.0.1:${port}/nope`);
check('404 envelope', notFound.status === 404);
check(
  'CORS allows public web clients',
  notFound.headers.get('access-control-allow-origin') === '*',
);
const preflight = await fetch(`http://127.0.0.1:${port}/dashboard`, {
  method: 'OPTIONS',
  headers: {
    Origin: 'https://example.com',
    'Access-Control-Request-Method': 'GET',
    'Access-Control-Request-Headers': 'ngrok-skip-browser-warning',
  },
});
check(
  'CORS preflight responds without authentication',
  preflight.status === 204,
);
check(
  'CORS allows ngrok browser warning header',
  preflight.headers
    .get('access-control-allow-headers')
    ?.toLowerCase()
    .includes('ngrok-skip-browser-warning') ?? false,
);
const assetLinks = [
  '/.well-known/assetlinks.json',
  '/.well-known/assetslinks.json',
];
for (const path of assetLinks) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  const body = await response.json();
  check(
    `public asset links endpoint ${path}`,
    response.status === 200 &&
      response.headers.get('content-type')?.includes('application/json') ===
        true &&
      body[0]?.target?.package_name === 'com.ausd.wallet' &&
      body[0]?.target?.sha256_cert_fingerprints?.length === 2,
    body,
  );
}
const unauthorized = await fetch(`http://127.0.0.1:${port}/dashboard`);
check('dashboard requires auth', unauthorized.status === 401);
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  if (String(input).endsWith('/v1/pub/context')) {
    return new Response(
      JSON.stringify({
        chain: { chain_id: 10143, name: 'Test Network' },
        instances: [
          {
            id: 1,
            address: '0x1111111111111111111111111111111111111111',
            collateral_token_id: 2,
            min_account_open_amount: '100000000',
            min_deposit_amount: '10000000',
          },
        ],
        tokens: [
          {
            id: 2,
            address: '0x2222222222222222222222222222222222222222',
            symbol: 'AUSD',
            name: 'Test USD',
            decimals: 6,
          },
        ],
        markets: [],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }
  return originalFetch(input, init);
};
const accountMetadata = await fetch(
  `http://127.0.0.1:${port}/meta/account-creation`,
).then((response) => response.json());
globalThis.fetch = originalFetch;
check(
  'account-creation metadata derives collateral amounts',
  accountMetadata.minAccountOpenAmount.amount === 100 &&
    accountMetadata.minDepositAmount.amount === 10 &&
    accountMetadata.collateralToken.symbol === 'AUSD',
  accountMetadata,
);
server.close();

if (failures > 0) {
  console.log(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\nall smoke tests passed');
