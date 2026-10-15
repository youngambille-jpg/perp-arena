// Environment configuration. Everything Perpl-related is read from the
// environment so testnet/mainnet is a variable swap, never a code change.

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.length > 0 ? value : fallback;
}

function optionalNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number`);
  return parsed;
}

function optionalInt(name: string, fallback: number): number {
  const value = optionalNumber(name, fallback);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

function parseHexKey(name: string): Buffer {
  const raw = required(name).replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(`${name} must be 64 hex characters (32 bytes)`);
  }
  return Buffer.from(raw, 'hex');
}

export const NODE_ENV = optional('NODE_ENV', 'development');
export const PORT = optionalInt('PORT', 8080);

// Supabase
export const SUPABASE_DB_URL = required('SUPABASE_DB_URL');
export const SUPABASE_URL = required('SUPABASE_URL');
export const SUPABASE_ANON_KEY = required('SUPABASE_ANON_KEY');
export const SUPABASE_SERVICE_ROLE_KEY = required('SUPABASE_SERVICE_ROLE_KEY');

// Perpl network selection
export const PERPL_API_URL = optional(
  'PERPL_API_URL',
  'https://testnet.perpl.xyz/api',
);
export const PERPL_WS_URL = optional('PERPL_WS_URL', 'wss://testnet.perpl.xyz');
export const PERPL_CHAIN_ID = optionalInt('PERPL_CHAIN_ID', 10143);

// Builder code: Perpl issues builder ids 1..255 out of band. 0 = disabled.
export const PERPL_BUILDER_ID = optionalInt('PERPL_BUILDER_ID', 0);
// Fee charged per copied order, in per_100k (1 = 0.1 bps, 100 = 0.1% max).
export const PERPL_BUILDER_FEE_PER_100K = optionalInt(
  'PERPL_BUILDER_FEE_PER_100K',
  0,
);

// AES-256-GCM master key for stored Perpl key material.
export const KEY_ENCRYPTION_KEY = parseHexKey('KEY_ENCRYPTION_KEY');

// Origin sent with the API-key enrollment payload.
export const APP_ORIGIN = optional('APP_ORIGIN', 'http://localhost:8080');

// Engine tuning
export const COPY_DELAY_MS = optionalInt('COPY_DELAY_MS', 1500);

// Dry run: the copy engine (and kill switch) log the orders they
// WOULD place instead of submitting them. Copy-order rows are
// still written, flagged dry_run, so the audit trail shows what
// would have happened. Default off; enable for safe live testing.
export const DRY_RUN =
  (process.env.DRY_RUN ?? 'false').toLowerCase() === 'true';
export const COPY_POLL_MS = optionalInt('COPY_POLL_MS', 2000);
export const LEADER_SNAPSHOT_MS = optionalInt('LEADER_SNAPSHOT_MS', 60_000);
export const TOURNAMENT_SNAPSHOT_MS = optionalInt(
  'TOURNAMENT_SNAPSHOT_MS',
  60_000,
);
export const RISK_CHECK_MS = optionalInt('RISK_CHECK_MS', 15_000);
export const SESSION_POLL_MS = optionalInt('SESSION_POLL_MS', 1000);

export const COLLATERAL_DECIMALS = 6;
export const MAX_BUILDER_FEE_PER_100K = 100;
