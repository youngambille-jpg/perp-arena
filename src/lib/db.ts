// Postgres pool (service role). Used by both the API server and the
// worker. Supabase requires TLS; rejectUnauthorized is left off because
// Supabase serves a shared wildcard certificate.

import { Pool, type PoolClient } from 'pg';
import { SUPABASE_DB_URL } from '../config.js';
import { logger } from './logger.js';

const isLocal =
  SUPABASE_DB_URL.includes('://localhost') ||
  SUPABASE_DB_URL.includes('://127.0.0.1') ||
  SUPABASE_DB_URL.includes('host=');

// The Supabase session pooler has a 15-connection server pool. API and worker
// each create a pool, so leave shared headroom instead of using pg's 20 default.
const POOL_MAX = 5;

export const pool = new Pool({
  connectionString: SUPABASE_DB_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (error) => {
  logger.error('pg pool client error', error.message);
});
