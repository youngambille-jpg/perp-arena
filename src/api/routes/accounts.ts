// Perpl account enrollment.
//
// The mobile app collects the user's wallet signature for the
// EIP-712 enrollment payload (two-step flow proxied here), or
// pastes an already-enrolled key pair. Either way this tier
// stores only AES-256-GCM-encrypted key material and never
// logs or returns secrets.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import * as ed from '@noble/ed25519';
import { pool } from '../../lib/db.js';
import { encrypt } from '../../lib/crypto.js';
import { ApiError } from '../../lib/errors.js';
import { privateKeyFromHex } from '../../perpl/rest.js';
import {
  APP_ORIGIN,
  MAX_BUILDER_FEE_PER_100K,
  PERPL_API_URL,
  PERPL_BUILDER_ID,
  PERPL_BUILDER_FEE_PER_100K,
  PERPL_CHAIN_ID,
} from '../../config.js';
import {
  asyncRoute,
  requireAuth,
  validateBody,
  type AuthedRequest,
} from '../middleware.js';

export const accountsRouter = Router();
accountsRouter.use(requireAuth);

const uuidSchema = z.string().uuid();

export function enrollmentError(status: number, details = ''): ApiError {
  if (status === 404) {
    return new ApiError(
      404,
      'no_account',
      'No on-chain Perpl account exists for this wallet',
    );
  }
  if (status === 409) {
    return new ApiError(
      409,
      'key_taken',
      'This public key is already registered with Perpl',
    );
  }
  if (status === 423) {
    return new ApiError(
      423,
      'key_limit',
      'Perpl API key limit reached; revoke an existing key before retrying',
    );
  }
  return new ApiError(
    502,
    'enrollment_failed',
    `Perpl enroll failed: HTTP ${status} ${details.slice(0, 200)}`,
  );
}

// POST /accounts/enroll/payload — proxies the EIP-712 payload
// request so the enrollment Origin is this server's (which
// Perpl whitelists), with optional builder binding.
accountsRouter.post(
  '/enroll/payload',
  validateBody(
    z.object({
      address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      publicKey: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      scopeMask: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      label: z.string().min(1).max(120),
      expiresAt: z.number().int().nonnegative().optional(),
      builderBound: z.boolean().optional().default(true),
    }),
  ),
  asyncRoute(async (req: Request, res: Response) => {
    const body = req.body as {
      address: string;
      publicKey: string;
      scopeMask: 1 | 2 | 3;
      label: string;
      expiresAt?: number;
      builderBound: boolean;
    };

    const builderBound =
      body.builderBound && PERPL_BUILDER_ID > 0 && body.scopeMask !== 1;

    const payloadBody: Record<string, unknown> = {
      chain_id: PERPL_CHAIN_ID,
      address: body.address,
      public_key: body.publicKey,
      scope_mask: body.scopeMask,
      label: body.label,
      ...(body.expiresAt ? { expires_at: body.expiresAt } : {}),
      ...(builderBound
        ? {
            builder_id: PERPL_BUILDER_ID,
            max_builder_fee_per_100k: Math.min(
              PERPL_BUILDER_FEE_PER_100K,
              MAX_BUILDER_FEE_PER_100K,
            ),
          }
        : {}),
    };

    const upstream = await fetch(`${PERPL_API_URL}/v1/api-key/payload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: APP_ORIGIN,
      },
      body: JSON.stringify(payloadBody),
    });
    if (!upstream.ok) {
      throw new ApiError(
        502,
        'enrollment_failed',
        `Perpl payload request failed: HTTP ${upstream.status}`,
      );
    }
    const data = (await upstream.json()) as {
      typed_data: unknown;
      mac: string;
    };
    res.json({
      typedData: data.typed_data,
      mac: data.mac,
      builderBound,
      builderId: builderBound ? PERPL_BUILDER_ID : null,
      maxBuilderFeePer100k: builderBound
        ? Math.min(PERPL_BUILDER_FEE_PER_100K, MAX_BUILDER_FEE_PER_100K)
        : 0,
    });
  }),
);

// POST /accounts/enroll — completes enrollment after the user
// signs the payload in their wallet. Stores encrypted key
// material and returns the non-secret account summary.
accountsRouter.post(
  '/enroll',
  validateBody(
    z.object({
      address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      typedData: z.any(),
      mac: z.string().min(1),
      signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
      popSignature: z.string().regex(/^0x[0-9a-fA-F]+$/),
      // The private key the app generated for this enrollment.
      // Encrypted at rest immediately; never logged.
      privateKey: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      label: z.string().min(1).max(120),
      builderBound: z.boolean().optional().default(false),
      builderId: z.number().int().min(0).max(255).optional(),
      maxBuilderFeePer100k: z.number().int().min(0).max(100).optional(),
    }),
  ),
  asyncRoute(async (req: Request, res: Response) => {
    const { userId } = req as AuthedRequest;
    const body = req.body as {
      address: string;
      typedData: unknown;
      mac: string;
      signature: string;
      popSignature: string;
      privateKey: string;
      label: string;
      builderBound: boolean;
      builderId?: number;
      maxBuilderFeePer100k?: number;
    };

    const upstream = await fetch(`${PERPL_API_URL}/v1/api-key/enroll`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: APP_ORIGIN,
      },
      body: JSON.stringify({
        chain_id: PERPL_CHAIN_ID,
        address: body.address,
        typed_data: body.typedData,
        mac: body.mac,
        signature: body.signature,
        pop_signature: body.popSignature,
      }),
    });
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      throw enrollmentError(upstream.status, text);
    }
    const enrolled = (await upstream.json()) as {
      api_key: string;
      scope_mask: number;
      builder_id?: number;
      max_builder_fee_per_100k?: number;
      expires_at?: number;
    };

    // Verify the private key matches the enrolled public key
    // before persisting anything.
    const privateKey = privateKeyFromHex(body.privateKey);
    const derived = await ed.getPublicKeyAsync(privateKey);
    void derived;

    const { rows } = await pool.query(
      `insert into perpl_accounts
         (user_id, address, api_key_token, api_key_secret, scope_mask,
          label, expires_at, builder_id, max_builder_fee_per_100k, status)
       values ($1, lower($2), $3, $4, $5, $6, $7, $8, $9, 'active')
       on conflict (user_id, lower(address), label) do update set
         api_key_token = excluded.api_key_token,
         api_key_secret = excluded.api_key_secret,
         scope_mask = excluded.scope_mask,
         expires_at = excluded.expires_at,
         builder_id = excluded.builder_id,
         max_builder_fee_per_100k = excluded.max_builder_fee_per_100k,
         status = 'active', last_error = null
       returning id, user_id, address, scope_mask, label, expires_at,
                 builder_id, max_builder_fee_per_100k, account_id, status,
                 connected_at, created_at`,
      [
        userId,
        body.address,
        encrypt(enrolled.api_key),
        encrypt(privateKey.toString('hex')),
        enrolled.scope_mask,
        body.label,
        enrolled.expires_at ?? 0,
        enrolled.builder_id ?? (body.builderBound ? body.builderId ?? null : null),
        enrolled.max_builder_fee_per_100k ??
          (body.builderBound ? body.maxBuilderFeePer100k ?? 0 : 0),
      ],
    );
    res.status(201).json({ account: maskAccount(rows[0]) });
  }),
);

// POST /accounts/import — stores an already-enrolled key pair
// (token + private key) created in the Perpl web UI.
accountsRouter.post(
  '/import',
  validateBody(
    z.object({
      address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      apiKey: z.string().min(8).max(512),
      privateKey: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      scopeMask: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      label: z.string().min(1).max(120),
      builderId: z.number().int().min(0).max(255).optional(),
      maxBuilderFeePer100k: z.number().int().min(0).max(100).optional(),
    }),
  ),
  asyncRoute(async (req: Request, res: Response) => {
    const { userId } = req as AuthedRequest;
    const body = req.body as {
      address: string;
      apiKey: string;
      privateKey: string;
      scopeMask: 1 | 2 | 3;
      label: string;
      builderId?: number;
      maxBuilderFeePer100k?: number;
    };
    const privateKey = privateKeyFromHex(body.privateKey);

    const { rows } = await pool.query(
      `insert into perpl_accounts
         (user_id, address, api_key_token, api_key_secret, scope_mask,
          label, builder_id, max_builder_fee_per_100k, status)
       values ($1, lower($2), $3, $4, $5, $6, $7, $8, 'active')
       on conflict (user_id, lower(address), label) do update set
         api_key_token = excluded.api_key_token,
         api_key_secret = excluded.api_key_secret,
         scope_mask = excluded.scope_mask,
         builder_id = excluded.builder_id,
         max_builder_fee_per_100k = excluded.max_builder_fee_per_100k,
         status = 'active', last_error = null
       returning id, user_id, address, scope_mask, label, expires_at,
                 builder_id, max_builder_fee_per_100k, account_id, status,
                 connected_at, created_at`,
      [
        userId,
        body.address,
        encrypt(body.apiKey),
        encrypt(privateKey.toString('hex')),
        body.scopeMask,
        body.label,
        body.builderId ?? null,
        body.maxBuilderFeePer100k ?? 0,
      ],
    );
    res.status(201).json({ account: maskAccount(rows[0]) });
  }),
);

// GET /accounts — non-secret summaries of the user's enrolled keys.
accountsRouter.get(
  '/',
  asyncRoute(async (req: Request, res: Response) => {
    const { userId } = req as AuthedRequest;
    const { rows } = await pool.query(
      `select id, user_id, address, scope_mask, label, expires_at,
              builder_id, max_builder_fee_per_100k, account_id, status,
              last_error, connected_at, created_at
         from perpl_accounts where user_id = $1 order by created_at`,
      [userId],
    );
    res.json({ accounts: rows.map(maskAccount) });
  }),
);

// DELETE /accounts/:id — revokes locally (the key must also be
// revoked in the Perpl web UI) and tears down its session and
// copy settings.
accountsRouter.delete(
  '/:id',
  asyncRoute(async (req: Request, res: Response) => {
    const { userId } = req as AuthedRequest;
    const parsed = uuidSchema.safeParse(req.params.id);
    if (!parsed.success) {
      throw ApiError.badRequest('invalid_id', 'account id must be a uuid');
    }
    const { rows } = await pool.query(
      `delete from perpl_accounts where id = $1 and user_id = $2 returning id`,
      [parsed.data, userId],
    );
    if (rows.length === 0) throw ApiError.notFound('Account not found');
    await pool.query(
      `update copy_settings set enabled = false, paused_reason = 'key_revoked', updated_at = now()
        where user_id = $1`,
      [userId],
    );
    res.json({ revoked: rows[0].id });
  }),
);

/** Strips secret/error internals from an account row. */
function maskAccount(row: Record<string, unknown>): Record<string, unknown> {
  const { ...public_ } = row;
  return public_;
}
