// Auto-provisioning of the caller's public.users row.
//
// Every user-scoped table (perpl_accounts, copy_settings, follows, …)
// references public.users(id), but that row is only ever created by
// PUT /users/me and POST /users/link-wallet. A fresh anonymous session
// that enrolls or imports a Perpl key before doing either one hits a
// foreign-key violation (23503), which the error handler reports as a
// generic 500 "internal". Routes that write user-scoped rows call
// ensureUserRow() first.

import { pool } from './db.js';

/**
 * Deterministic provisional handle: unique per user (16 hex digits of
 * the uuid) and valid under the same `[a-zA-Z0-9_]{3,24}` contract
 * PUT /users/me enforces, so the user can always replace it. Derived
 * from the user id rather than the wallet address: the client's own
 * `user-<6 hex>` convention is both invalid under that contract and
 * collides when one Perpl wallet is enrolled by two sessions.
 */
export function provisionalHandle(userId: string): string {
  return `user_${userId.replace(/-/g, '').slice(0, 16)}`;
}

/**
 * Creates the caller's public.users row when it is missing. An
 * existing row is left untouched, so a real handle or a linked wallet
 * address is never overwritten. Concurrent calls are safe: the insert
 * conflicts on the primary key and does nothing.
 */
export async function ensureUserRow(userId: string): Promise<void> {
  await pool.query(
    `insert into public.users (id, handle) values ($1, $2)
     on conflict (id) do nothing`,
    [userId, provisionalHandle(userId)],
  );
}
