// Live end-to-end test against Supabase + API (port 8099).
// Creates two auth users, exercises every authed route, then
// cleans up. Perpl-key-gated paths are verified up to their
// guardrails (no real Perpl key exists yet).
// Run: pnpm exec tsx e2e.ts

const API = 'http://127.0.0.1:8099';
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANON = process.env.SUPABASE_ANON_KEY!;

let failures = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) console.log(`ok   ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name}`, JSON.stringify(extra)?.slice(0, 300) ?? '');
  }
};

const adminHeaders = {
  apikey: SERVICE,
  Authorization: `Bearer ${SERVICE}`,
  'Content-Type': 'application/json',
};

async function createUser(email: string, password: string) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!res.ok) throw new Error(`create user failed: ${await res.text()}`);
  return (await res.json()) as { id: string };
}

async function signIn(email: string, password: string): Promise<string> {
  const res = await fetch(
    `${SUPABASE_URL}/auth/v1/token?grant_type=password`,
    {
      method: 'POST',
      headers: { apikey: ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    },
  );
  if (!res.ok) throw new Error(`sign in failed: ${await res.text()}`);
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

const api = (token?: string) => ({
  get: (p: string) =>
    fetch(`${API}${p}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }).then(async (r) => ({ status: r.status, body: await r.json() })),
  post: (p: string, b?: unknown) =>
    fetch(`${API}${p}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(b ?? {}),
    }).then(async (r) => ({ status: r.status, body: await r.json() })),
  put: (p: string, b?: unknown) =>
    fetch(`${API}${p}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(b ?? {}),
    }).then(async (r) => ({ status: r.status, body: await r.json() })),
  del: (p: string) =>
    fetch(`${API}${p}`, {
      method: 'DELETE',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }).then(async (r) => ({ status: r.status, body: await r.json() })),
});

const stamp = Date.now().toString(36);
const aliceEmail = `alice-${stamp}@example.com`;
const bobEmail = `bob-${stamp}@example.com`;
const password = 'Test-Pass-123!';
const createdIds: string[] = [];

try {
  // --- setup users -------------------------------------------------------
  const alice = await createUser(aliceEmail, password);
  const bob = await createUser(bobEmail, password);
  createdIds.push(alice.id, bob.id);
  const aliceTok = await signIn(aliceEmail, password);
  const bobTok = await signIn(bobEmail, password);
  check('auth users created + signed in', !!aliceTok && !!bobTok);

  // public.users rows (the mobile app inserts these after signup)
  const { pool } = await import('./src/lib/db.js');
  await pool.query(
    `insert into public.users (id, handle) values ($1, 'alice'), ($2, 'bob')
     on conflict (id) do update set handle = excluded.handle`,
    [alice.id, bob.id],
  );

  // --- leader profiles ----------------------------------------------------
  let r = await api(bobTok).put('/leaders/me', {
    isPublic: true,
    styles: ['swing'],
    bio: 'test leader',
  });
  check('bob publishes profile', r.status === 200, r);

  r = await api(aliceTok).get('/leaders?sort=pnl&limit=10');
  check(
    'leaderboard lists bob',
    r.status === 200 &&
      (r.body as { leaders: unknown[] }).leaders.length === 1,
    r,
  );

  r = await api(aliceTok).get(`/leaders/${bob.id}`);
  check(
    'leader detail has positions + fills',
    r.status === 200 &&
      'positions' in (r.body as object) &&
      'recentFills' in (r.body as object),
    r,
  );

  r = await api(aliceTok).get(`/leaders/${alice.id}`);
  check('private profile 404s', r.status === 404, r.status);

  // --- follows --------------------------------------------------------------
  r = await api(aliceTok).post(`/leaders/${alice.id}/follow`);
  check('self-follow rejected', r.status === 400, r);

  r = await api(aliceTok).post(`/leaders/${bob.id}/follow`);
  check('alice follows bob', r.status === 201, r);

  r = await api(aliceTok).get('/leaders/follows');
  const follows = (r.body as { follows: unknown[] }).follows;
  check('follows lists bob', r.status === 200 && follows.length === 1, r);

  // --- copy settings ----------------------------------------------------------
  r = await api(aliceTok).put(`/copy/${bob.id}`, { allocationUsd: -5 });
  check('negative allocation 400s', r.status === 400, r);

  r = await api(aliceTok).put(`/copy/${bob.id}`, { allocationUsd: 1000 });
  check(
    'copy without trade key rejected with no_trade_key',
    r.status === 400 &&
      (r.body as { error: { code: string } }).error.code ===
        'no_trade_key',
    r,
  );

  r = await api(aliceTok).get('/copy');
  check('empty copy settings', r.status === 200, r);

  r = await api(aliceTok).post('/copy/kill-switch');
  check(
    'kill switch accepted with no settings',
    r.status === 200 &&
      (r.body as { affectedSettings: number }).affectedSettings === 0,
    r,
  );

  r = await api(aliceTok).get('/copy/orders?limit=5');
  check('empty audit trail', r.status === 200, r);

  // --- accounts ---------------------------------------------------------------
  r = await api(aliceTok).get('/accounts');
  check('empty accounts list', r.status === 200, r);

  r = await api(aliceTok).post('/accounts/import', {
    address: '0x123',
    apiKey: 'x',
    privateKey: '0x1',
    scopeMask: 3,
    label: 'bad',
  });
  check('invalid import body 400s', r.status === 400, r);

  // --- wallet link (anon user + mera-style wallet) --------------------------
  const { ethers } = await import('ethers');
  const linkWallet = ethers.Wallet.createRandom();
  const linkAddress = linkWallet.address.toLowerCase();

  r = await api(aliceTok).get('/users/link-challenge');
  const challenge = r.body as { nonce: string; expiry: number };
  check(
    'link challenge issued',
    r.status === 200 && /^[0-9a-f]{32}$/.test(challenge.nonce),
    r,
  );

  const linkMessage = (nonce: string, expiry: number): string =>
    `Perpl Arena wallet link\n` +
    `user: ${alice.id}\n` +
    `address: ${linkAddress}\n` +
    `nonce: ${nonce}\n` +
    `expiry: ${expiry}`;
  const goodSig = await linkWallet.signMessage(
    linkMessage(challenge.nonce, challenge.expiry),
  );
  r = await api(aliceTok).post('/users/link-wallet', {
    address: linkAddress,
    nonce: challenge.nonce,
    expiry: challenge.expiry,
    signature: goodSig,
  });
  check(
    'wallet linked',
    r.status === 200 &&
      (r.body as { user: { wallet_address: string } }).user
        .wallet_address === linkAddress,
    r,
  );

  // Challenge is one-time: replay fails.
  r = await api(aliceTok).post('/users/link-wallet', {
    address: linkAddress,
    nonce: challenge.nonce,
    expiry: challenge.expiry,
    signature: goodSig,
  });
  check('challenge replay rejected', r.status === 400, r.status);

  // Wrong signer fails.
  const other = ethers.Wallet.createRandom();
  r = await api(aliceTok).get('/users/link-challenge');
  const challenge2 = r.body as { nonce: string; expiry: number };
  const badSig = await other.signMessage(
    linkMessage(challenge2.nonce, challenge2.expiry),
  );
  r = await api(aliceTok).post('/users/link-wallet', {
    address: linkAddress,
    nonce: challenge2.nonce,
    expiry: challenge2.expiry,
    signature: badSig,
  });
  check('wrong-signer link rejected', r.status === 400, r);

  r = await api(aliceTok).get('/users/me');
  check(
    'profile shows linked wallet',
    r.status === 200 &&
      (r.body as { user: { wallet_address: string } }).user
        .wallet_address === linkAddress,
    r,
  );

  // --- manual trading intents -------------------------------------------------
  // History needs a key: none enrolled yet.
  r = await api(aliceTok).get('/trading/fills?count=5');
  check(
    'history without key rejected with no_account',
    r.status === 400 &&
      (r.body as { error: { code: string } }).error.code === 'no_account',
    r,
  );

  r = await api(aliceTok).post('/trading/orders', {
    marketId: 16,
    side: 'long',
    size: 0.001,
    leverage: 2,
    idempotencyKey: '11111111-1111-1111-1111-111111111111',
  });
  check(
    'intent without trade key rejected with no_trade_key',
    r.status === 400 &&
      (r.body as { error: { code: string } }).error.code === 'no_trade_key',
    r,
  );

  // Store a syntactically-valid (non-Perpl) key directly: exercises the
  // full intent path up to worker submission. The live worker will fail
  // to open a session with it — harmless, cleaned up below.
  const { encrypt } = await import('./src/lib/crypto.js');
  await pool.query(
    `insert into perpl_accounts
       (user_id, address, api_key_token, api_key_secret, scope_mask,
        label, status)
     values ($1, '0x0000000000000000000000000000000000000001', $2, $3, 3,
             'e2e-fake', 'active')`,
    [alice.id, encrypt('fake-token'), encrypt('0x' + 'ab'.repeat(32))],
  );

  const intentKey = '22222222-2222-2222-2222-222222222222';
  r = await api(aliceTok).post('/trading/orders', {
    marketId: 16,
    side: 'long',
    size: 0.001,
    leverage: 2,
    idempotencyKey: intentKey,
    dryRun: true,
  });
  const intent = (
    r.body as { intent: { id: string; status: string; dry_run: boolean } }
  ).intent;
  check(
    'manual intent accepted as pending (202)',
    r.status === 202 &&
      intent.status === 'pending' &&
      intent.dry_run === true,
    r,
  );

  r = await api(aliceTok).post('/trading/orders', {
    marketId: 16,
    side: 'long',
    size: 0.001,
    leverage: 2,
    idempotencyKey: intentKey,
  });
  check(
    'idempotency replay returns original',
    r.status === 200 &&
      (r.body as { duplicate: boolean }).duplicate === true,
    r,
  );

  r = await api(aliceTok).post('/trading/orders', {
    marketId: 999999,
    side: 'long',
    size: 0.001,
    idempotencyKey: '33333333-3333-3333-3333-333333333333',
  });
  check('unknown market rejected', r.status === 400, r.status);

  r = await api(aliceTok).post('/trading/orders', {
    marketId: 16,
    side: 'close',
    idempotencyKey: '44444444-4444-4444-4444-444444444444',
  });
  check('close without position rejected', r.status === 400, r.status);

  r = await api(aliceTok).post('/trading/orders', {
    marketId: 16,
    side: 'cancel',
    idempotencyKey: '55555555-5555-5555-5555-555555555555',
  });
  check('cancel without order id rejected', r.status === 400, r.status);

  r = await api(aliceTok).post('/trading/orders', {
    marketId: 16,
    side: 'long',
    size: 0.001,
    leverage: 50,
    idempotencyKey: '66666666-6666-6666-6666-666666666666',
  });
  check('leverage above market max rejected', r.status === 400, r.status);

  r = await api(aliceTok).get('/trading/manual');
  const manuals = (r.body as { orders: unknown[] }).orders;
  check('manual audit lists the intent', r.status === 200 && manuals.length === 1, r);

  // --- tournaments --------------------------------------------------------------
  await pool.query(
    `insert into tournaments (id, name, metric, status, starts_at, ends_at)
     values ('00000000-0000-0000-0000-000000000001', 'e2e weekly', 'risk_adjusted_pnl',
             'active', now() - interval '1 hour', now() + interval '6 days')
     on conflict (id) do update set status = 'active'`,
  );
  r = await api(aliceTok).get('/tournaments?status=active');
  check('tournament listed', r.status === 200, r);

  r = await api(aliceTok).get(
    '/tournaments/00000000-0000-0000-0000-000000000001',
  );
  check('tournament detail + standings', r.status === 200, r);

  // Alice now holds the (fake) trade key from the manual-intent
  // section, so join succeeds — assert the entry shape.
  r = await api(aliceTok).post(
    '/tournaments/00000000-0000-0000-0000-000000000001/join',
  );
  check(
    'join with enrolled key succeeds',
    r.status === 201 &&
      (r.body as { entry: { tournament_id: string } }).entry
        .tournament_id === '00000000-0000-0000-0000-000000000001',
    r,
  );

  // Bob has no key: the no_account guardrail still holds.
  r = await api(bobTok).post(
    '/tournaments/00000000-0000-0000-0000-000000000001/join',
  );
  check(
    'join without enrolled key rejected with no_account',
    r.status === 400 &&
      (r.body as { error: { code: string } }).error.code === 'no_account',
    r,
  );

  // --- dashboard ---------------------------------------------------------------
  r = await api(aliceTok).get('/dashboard');
  const dash = r.body as Record<string, unknown>;
  check(
    'dashboard shape (equity/positions/copies/pnl/notifications)',
    r.status === 200 &&
      'equity' in dash &&
      'positions' in dash &&
      'activeCopySettings' in dash &&
      'realizedPnlToday' in dash &&
      'unreadNotifications' in dash,
    r,
  );

  r = await api(aliceTok).post('/dashboard/notifications/read');
  check('notifications mark-read', r.status === 200, r);

  await pool.end();
} finally {
  // --- cleanup ------------------------------------------------------------------
  // Fresh pool: the shared singleton may already be ended by the test body.
  const { Pool } = await import('pg');
  const cleanupPool = new Pool({
    connectionString: process.env.SUPABASE_DB_URL,
    ssl: { rejectUnauthorized: false },
  });
  for (const id of createdIds) {
    await cleanupPool
      .query(`delete from public.users where id = $1`, [id])
      .catch(() => {});
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${id}`, {
      method: 'DELETE',
      headers: adminHeaders,
    }).catch(() => {});
  }
  await cleanupPool
    .query(
      `delete from tournaments where id = '00000000-0000-0000-0000-000000000001'`,
    )
    .catch(() => {});
  await cleanupPool.end().catch(() => {});
  console.log('cleanup done');
}

if (failures > 0) {
  console.log(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\nall e2e tests passed');
