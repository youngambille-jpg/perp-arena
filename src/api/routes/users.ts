// Supabase user ↔ mera wallet binding.
//
// Anonymous sign-in gives the transport credential (JWT); the mera
// passkey wallet is the trading identity. This route binds them:
// app fetches a one-time challenge, the wallet EIP-191-signs it via
// the mera session, and the server ecrecover-verifies before storing
// wallet_address. One wallet per user; re-linking rotates the binding
// (fresh signature required every time).

import { randomBytes } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { ethers } from 'ethers';
import { pool } from '../../lib/db.js';
import { ApiError } from '../../lib/errors.js';
import {
  asyncRoute,
  requireAuth,
  validateBody,
  type AuthedRequest,
} from '../middleware.js';

export const usersRouter = Router();
usersRouter.use(requireAuth);

const CHALLENGE_TTL_MS = 10 * 60_000;

/** Exact message the wallet must EIP-191-sign (mirrored in appflow.md). */
export function linkMessage(args: {
  userId: string;
  address: string;
  nonce: string;
  expiry: number;
}): string {
  return (
    `Perpl Arena wallet link\n` +
    `user: ${args.userId}\n` +
    `address: ${args.address}\n` +
    `nonce: ${args.nonce}\n` +
    `expiry: ${args.expiry}`
  );
}

// GET /users/link-challenge — one-time nonce, 10-minute expiry.
// Replaces any outstanding challenge for this user.
usersRouter.get(
  '/link-challenge',
  asyncRoute(async (req: Request, res: Response) => {
    const { userId } = req as AuthedRequest;
    const nonce = randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
    await pool.query(
      `insert into link_challenges (user_id, nonce, expires_at)
       values ($1, $2, $3)
       on conflict (user_id) do update set
         nonce = excluded.nonce, expires_at = excluded.expires_at,
         created_at = now()`,
      [userId, nonce, expiresAt.toISOString()],
    );
    res.json({ nonce, expiry: expiresAt.getTime() });
  }),
);

// PUT /users/me — create or update the caller's public handle.
usersRouter.put(
  '/me',
  validateBody(
    z.object({
      handle: z.string().trim().min(3).max(24).regex(/^[a-zA-Z0-9_]+$/),
    }),
  ),
  asyncRoute(async (req: Request, res: Response) => {
    const { userId } = req as AuthedRequest;
    const { handle } = req.body as { handle: string };
    try {
      const { rows } = await pool.query(
        `insert into public.users (id, handle)
         values ($1, $2)
         on conflict (id) do update set handle = excluded.handle
         returning id, handle, wallet_address, created_at`,
        [userId, handle],
      );
      res.json({ user: rows[0] });
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '23505'
      ) {
        throw ApiError.conflict('Handle is already taken');
      }
      throw error;
    }
  }),
);

// POST /users/link-wallet — verify signature, consume challenge, bind.
usersRouter.post(
  '/link-wallet',
  validateBody(
    z.object({
      address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      nonce: z.string().regex(/^[0-9a-f]{32}$/),
      expiry: z.number().int().positive(),
      signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
    }),
  ),
  asyncRoute(async (req: Request, res: Response) => {
    const { userId } = req as AuthedRequest;
    const body = req.body as {
      address: string;
      nonce: string;
      expiry: number;
      signature: string;
    };
    const address = body.address.toLowerCase();

    if (body.expiry < Date.now()) {
      throw ApiError.badRequest('challenge_expired', 'Challenge expired');
    }
    const { rows: challenges } = await pool.query<{
      nonce: string;
      expires_at: string;
    }>(
      `delete from link_challenges
        where user_id = $1 and nonce = $2 and expires_at > now()
        returning nonce, expires_at`,
      [userId, body.nonce],
    );
    if (challenges.length === 0) {
      throw ApiError.badRequest(
        'bad_challenge',
        'Unknown or expired challenge; fetch a fresh one',
      );
    }

    let recovered: string;
    try {
      recovered = ethers.verifyMessage(
        linkMessage({
          userId,
          address,
          nonce: body.nonce,
          expiry: body.expiry,
        }),
        body.signature,
      );
    } catch {
      throw ApiError.badRequest('bad_signature', 'Signature invalid');
    }
    if (recovered.toLowerCase() !== address) {
      throw ApiError.badRequest(
        'address_mismatch',
        'Signature does not recover to the claimed address',
      );
    }

    const { rows: taken } = await pool.query(
      `select id from public.users where wallet_address = $1 and id <> $2`,
      [address, userId],
    );
    if (taken.length > 0) {
      throw ApiError.conflict('Wallet already linked to another user');
    }

    const { rows } = await pool.query(
      `insert into public.users (id, handle, wallet_address)
       values ($1, $2, $3)
       on conflict (id) do update set wallet_address = excluded.wallet_address
       returning id, handle, wallet_address, created_at`,
      [userId, `user-${address.slice(2, 8)}`, address],
    );
    res.json({ user: rows[0] });
  }),
);

// GET /users/me — own profile row (handle + linked wallet).
usersRouter.get(
  '/me',
  asyncRoute(async (req: Request, res: Response) => {
    const { userId } = req as AuthedRequest;
    const { rows } = await pool.query(
      `select id, handle, wallet_address, created_at from public.users where id = $1`,
      [userId],
    );
    if (rows.length === 0) throw ApiError.notFound('Profile not found');
    res.json({ user: rows[0] });
  }),
);
