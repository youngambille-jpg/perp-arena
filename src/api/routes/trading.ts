// Manual trading: user-initiated order intents executed by the
// worker through the same sessions and lifecycle as copy orders,
// plus read-only passthroughs to Perpl trading history.
//
// POST /trading/orders never touches Perpl directly. It validates,
// translates human units to scaled integers, and inserts a pending
// intent; the worker consumes it (FOR UPDATE SKIP LOCKED), submits
// via the account's trading session, and tracks submitted → open →
// partial → filled. 202 + Realtime row updates close the loop.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { pool } from '../../lib/db.js';
import { decrypt } from '../../lib/crypto.js';
import { ApiError } from '../../lib/errors.js';
import {
  PerplApiError,
  PerplRestClient,
  type KeyMaterial,
} from '../../perpl/rest.js';
import {
  asyncRoute,
  requireAuth,
  validateBody,
  type AuthedRequest,
} from '../middleware.js';

export const tradingRouter = Router();
tradingRouter.use(requireAuth);

const uuidSchema = z.string().uuid();

/** Latest active key, optionally pinned to one account row. */
async function activeKey(
  userId: string,
  accountId?: string,
  tradeScope = false,
): Promise<{ id: string; material: KeyMaterial }> {
  const params: unknown[] = [userId];
  let accountFilter = '';
  if (accountId) {
    params.push(accountId);
    accountFilter = `and id = $${params.length}`;
  }
  const scopeFilter = tradeScope ? `and (scope_mask & 2) = 2` : ``;
  const { rows } = await pool.query(
    `select id, api_key_token, api_key_secret from perpl_accounts
      where user_id = $1 and status = 'active' ${scopeFilter} ${accountFilter}
      order by connected_at desc nulls last, created_at limit 1`,
    params,
  );
  if (rows.length === 0) {
    throw ApiError.badRequest(
      tradeScope ? 'no_trade_key' : 'no_account',
      tradeScope
        ? 'Enroll a trade-scoped Perpl API key first'
        : 'Enroll a Perpl API key first',
    );
  }
  return {
    id: rows[0].id as string,
    material: {
      token: decrypt(rows[0].api_key_token as string),
      privateKey: Buffer.from(
        decrypt(rows[0].api_key_secret as string).replace(/^0x/, ''),
        'hex',
      ),
    },
  };
}

const orderIntentSchema = z.object({
  marketId: z.number().int(),
  side: z.enum(['long', 'short', 'close', 'cancel']),
  // Human units (e.g. 0.01 BTC). Required for long/short.
  size: z.number().positive().max(1_000_000_000).optional(),
  // Human price. Omitted = market order (IOC); present = limit (GTC).
  price: z.number().positive().max(1_000_000_000).optional(),
  leverage: z.number().min(1).max(50).optional().default(1),
  slippageBps: z.number().int().min(0).max(10_000).optional().default(50),
  // Cancel target (Perpl order id). Required for cancel.
  perplOrderId: z.number().int().positive().optional(),
  // Client idempotency key: replays return the original row.
  idempotencyKey: uuidSchema,
  // Validate + record only; the worker simulates instead of submitting.
  dryRun: z.boolean().optional().default(false),
});

// POST /trading/orders — validate, translate, queue. 202 accepted.
tradingRouter.post(
  '/orders',
  validateBody(orderIntentSchema),
  asyncRoute(async (req: Request, res: Response) => {
    const { userId } = req as AuthedRequest;
    const body = req.body as z.infer<typeof orderIntentSchema>;

    await activeKey(userId, undefined, true);

    const { rows: markets } = await pool.query(
      `select market_id, symbol, price_decimals, size_decimals,
              initial_margin, min_size_scaled, order_ttl_blocks
         from market_cache where market_id = $1`,
      [body.marketId],
    );
    if (markets.length === 0) {
      throw ApiError.badRequest('unknown_market', 'Market not listed');
    }
    const market = markets[0] as {
      market_id: number;
      symbol: string;
      price_decimals: number;
      size_decimals: number;
      initial_margin: number;
      min_size_scaled: string;
    };

    const maxLeverage = 10_000 / market.initial_margin;
    if (body.leverage > maxLeverage) {
      throw ApiError.badRequest(
        'leverage_too_high',
        `${market.symbol} allows at most ${maxLeverage.toFixed(2)}x`,
      );
    }

    let orderType: number;
    let sizeScaled = 0n;
    let priceScaled = 0n;
    let positionId: number | null = null;

    if (body.side === 'long' || body.side === 'short') {
      if (body.size === undefined) {
        throw ApiError.badRequest(
          'missing_size',
          'size is required for long/short',
        );
      }
      orderType = body.side === 'long' ? 1 : 2; // OpenLong / OpenShort
      sizeScaled = BigInt(
        Math.round(body.size * 10 ** market.size_decimals),
      );
      if (sizeScaled < BigInt(market.min_size_scaled)) {
        throw ApiError.badRequest(
          'below_minimum',
          'Order is below the market minimum size',
        );
      }
      if (body.price !== undefined) {
        priceScaled = BigInt(
          Math.round(body.price * 10 ** market.price_decimals),
        );
      }
    } else if (body.side === 'close') {
      const { rows: positions } = await pool.query(
        `select perpl_position_id, side, size_scaled from positions
          where user_id = $1 and market_id = $2`,
        [userId, body.marketId],
      );
      if (positions.length === 0) {
        throw ApiError.badRequest('no_position', 'No open position here');
      }
      const position = positions[0] as {
        perpl_position_id: string | null;
        side: number;
        size_scaled: string;
      };
      orderType = position.side === 1 ? 3 : 4; // CloseLong / CloseShort
      sizeScaled = BigInt(position.size_scaled);
      positionId =
        position.perpl_position_id !== null
          ? Number(position.perpl_position_id)
          : null;
    } else {
      if (body.perplOrderId === undefined) {
        throw ApiError.badRequest(
          'missing_order',
          'perplOrderId is required for cancel',
        );
      }
      orderType = 5; // Cancel
    }

    // Notional estimate at the last price (informational; execution
    // uses market/limit price at submit time).
    const { rows: prices } = await pool.query(
      `select last_price, mark_price from price_cache where market_id = $1`,
      [body.marketId],
    );
    const refPrice = Number(
      prices[0]?.last_price ?? prices[0]?.mark_price ?? 0,
    );
    const notionalUsd =
      refPrice > 0
        ? (Number(sizeScaled) / 10 ** market.size_decimals) *
          (refPrice / 10 ** market.price_decimals)
        : 0;

    try {
      const { rows } = await pool.query(
        `insert into manual_orders
           (user_id, idempotency_key, market_id, order_type, size_scaled,
            price_scaled, leverage_hundredths, notional_usd, perpl_order_id,
            slippage_bps, dry_run)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         returning *`,
        [
          userId,
          body.idempotencyKey,
          body.marketId,
          orderType,
          sizeScaled.toString(),
          priceScaled.toString(),
          Math.round(body.leverage * 100),
          notionalUsd,
          body.side === 'cancel' ? body.perplOrderId : positionId,
          body.slippageBps,
          body.dryRun,
        ],
      );
      res.status(202).json({ intent: rows[0], duplicate: false });
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code: string }).code === '23505'
      ) {
        const { rows } = await pool.query(
          `select * from manual_orders where idempotency_key = $1 and user_id = $2`,
          [body.idempotencyKey, userId],
        );
        res.status(200).json({ intent: rows[0] ?? null, duplicate: true });
        return;
      }
      throw error;
    }
  }),
);

// GET /trading/manual — own intents, newest first.
tradingRouter.get(
  '/manual',
  asyncRoute(async (req: Request, res: Response) => {
    const { userId } = req as AuthedRequest;
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 200);
    const { rows } = await pool.query(
      `select * from manual_orders where user_id = $1
        order by created_at desc limit $2`,
      [userId, limit],
    );
    res.json({ orders: rows });
  }),
);

// ---- Read-only Perpl history passthroughs (read scope) ---------------

async function historyClient(
  req: Request,
): Promise<PerplRestClient> {
  const { userId } = req as AuthedRequest;
  const account =
    typeof req.query.account === 'string' ? req.query.account : undefined;
  if (account && !uuidSchema.safeParse(account).success) {
    throw ApiError.badRequest('invalid_account', 'account must be a uuid');
  }
  const { material } = await activeKey(userId, account, false);
  return new PerplRestClient(material);
}

function pageParams(req: Request): { count: number; page?: string } {
  const count = Math.min(Math.max(Number(req.query.count ?? 50), 1), 100);
  const page =
    typeof req.query.page === 'string' && req.query.page
      ? req.query.page
      : undefined;
  return { count, page };
}

/** Maps Perpl transport errors onto our envelope. */
async function passthrough<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof PerplApiError) {
      throw new ApiError(
        error.status,
        'perpl_error',
        `Perpl rejected the request: HTTP ${error.status}`,
      );
    }
    throw error;
  }
}

tradingRouter.get(
  '/fills',
  asyncRoute(async (req: Request, res: Response) => {
    const client = await historyClient(req);
    const { count, page } = pageParams(req);
    res.json(await passthrough(() => client.fills(count, page)));
  }),
);

tradingRouter.get(
  '/orders/history',
  asyncRoute(async (req: Request, res: Response) => {
    const client = await historyClient(req);
    const { count, page } = pageParams(req);
    res.json(await passthrough(() => client.orderHistory(count, page)));
  }),
);

tradingRouter.get(
  '/positions/history',
  asyncRoute(async (req: Request, res: Response) => {
    const client = await historyClient(req);
    const { count, page } = pageParams(req);
    res.json(await passthrough(() => client.positionHistory(count, page)));
  }),
);

tradingRouter.get(
  '/account/history',
  asyncRoute(async (req: Request, res: Response) => {
    const client = await historyClient(req);
    const { count, page } = pageParams(req);
    res.json(await passthrough(() => client.accountHistory(count, page)));
  }),
);
