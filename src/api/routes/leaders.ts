// Leader discovery: public profiles, follows, and activity.
// Leaderboard reads are plain Postgres queries over the
// worker-maintained leader_profiles rows.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { pool } from '../../lib/db.js';
import { ApiError } from '../../lib/errors.js';
import { ensureUserRow } from '../../lib/users.js';
import {
  asyncRoute,
  requireAuth,
  validateBody,
  validateQuery,
  type AuthedRequest,
} from '../middleware.js';

export const leadersRouter = Router();
leadersRouter.use(requireAuth);

// GET /leaders?market=&timeframe=&minWinRate=&maxDrawdown=&minSharpe=&style=&sort=&limit=
leadersRouter.get(
  '/',
  validateQuery(
    z.object({
      market: z.coerce.number().int().optional(),
      minWinRate: z.coerce.number().min(0).max(1).optional(),
      maxDrawdown: z.coerce.number().min(0).max(1).optional(),
      minSharpe: z.coerce.number().optional(),
      style: z.string().max(40).optional(),
      sort: z
        .enum(['pnl', 'pnl24h', 'winRate', 'sharpe', 'followers'])
        .optional()
        .default('pnl'),
      order: z.enum(['asc', 'desc']).optional().default('desc'),
      limit: z.coerce.number().int().min(1).max(100).optional().default(25),
      offset: z.coerce.number().int().min(0).optional().default(0),
    }),
  ),
  asyncRoute(async (req: Request, res: Response) => {
    const q = (
      req as Request & {
        validatedQuery: {
          minWinRate?: number;
          maxDrawdown?: number;
          minSharpe?: number;
          style?: string;
          sort: 'pnl' | 'pnl24h' | 'winRate' | 'sharpe' | 'followers';
          order: 'asc' | 'desc';
          limit: number;
          offset: number;
        };
      }
    ).validatedQuery;
    const sortColumn: Record<string, string> = {
      pnl: 'l.total_pnl_usd',
      pnl24h: 'l.pnl_24h_usd',
      winRate: 'l.win_rate',
      sharpe: 'l.sharpe',
      followers: 'l.followers_count',
    };
    const conditions: string[] = [`l.is_public = true`];
    const params: unknown[] = [];
    if (q.minWinRate !== undefined) {
      params.push(q.minWinRate);
      conditions.push(`l.win_rate >= $${params.length}`);
    }
    if (q.maxDrawdown !== undefined) {
      params.push(q.maxDrawdown);
      conditions.push(`l.max_drawdown <= $${params.length}`);
    }
    if (q.minSharpe !== undefined) {
      params.push(q.minSharpe);
      conditions.push(`l.sharpe >= $${params.length}`);
    }
    if (q.style) {
      params.push(q.style);
      conditions.push(`$${params.length} = any(l.styles)`);
    }
    params.push(q.limit, q.offset);
    const { rows } = await pool.query(
      `select l.user_id, u.handle, l.is_public, l.styles, l.bio,
              l.total_pnl_usd, l.pnl_24h_usd, l.win_rate, l.max_drawdown,
              l.sharpe, l.followers_count, l.updated_at
         from leader_profiles l
         join users u on u.id = l.user_id
        where ${conditions.join(' and ')}
        order by ${sortColumn[q.sort]} ${q.order === 'asc' ? 'asc' : 'desc'}
        limit $${params.length - 1} offset $${params.length}`,
      params,
    );
    res.json({ leaders: rows });
  }),
);

// GET /leaders/follows — leaders the caller follows, with copy status.
// Registered before /:id so "follows" is not captured as an id.
leadersRouter.get(
  '/follows',
  asyncRoute(async (req: Request, res: Response) => {
    const { userId } = req as AuthedRequest;
    const { rows } = await pool.query(
      `select l.user_id, u.handle, l.total_pnl_usd, l.pnl_24h_usd,
              l.win_rate, l.followers_count,
              s.enabled as copy_enabled, s.allocation_usd,
              s.paused_reason
         from follows f
         join leader_profiles l on l.user_id = f.leader_id
         join users u on u.id = l.user_id
         left join copy_settings s
           on s.user_id = f.follower_id and s.leader_id = f.leader_id
        where f.follower_id = $1
        order by f.created_at desc`,
      [userId],
    );
    res.json({ follows: rows });
  }),
);

// GET /leaders/:id — profile with live positions and recent fills.
leadersRouter.get(
  '/:id',
  asyncRoute(async (req: Request, res: Response) => {
    const leaderId = req.params.id;
    const { rows } = await pool.query(
      `select l.user_id, u.handle, l.is_public, l.styles, l.bio,
              l.total_pnl_usd, l.pnl_24h_usd, l.win_rate, l.max_drawdown,
              l.sharpe, l.followers_count, l.updated_at
         from leader_profiles l
         join users u on u.id = l.user_id
        where l.user_id = $1 and l.is_public = true`,
      [leaderId],
    );
    if (rows.length === 0) throw ApiError.notFound('Leader not found');
    const profile = rows[0];

    const { rows: positions } = await pool.query(
      `select p.market_id, m.symbol, p.side, p.size_scaled,
              p.entry_price_scaled, p.leverage_hundredths, p.updated_at,
              c.last_price
         from positions p
         left join market_cache m on m.market_id = p.market_id
         left join price_cache c on c.market_id = p.market_id
        where p.user_id = $1`,
      [leaderId],
    );
    const { rows: fills } = await pool.query(
      `select market_id, order_type, liquidity, price_scaled,
              size_scaled, fee, at
         from leader_fills
        where leader_user_id = $1
        order by at desc limit 50`,
      [leaderId],
    );
    res.json({ profile, positions, recentFills: fills });
  }),
);

// PUT /leaders/me — create or update the caller's public profile.
leadersRouter.put(
  '/me',
  validateBody(
    z.object({
      isPublic: z.boolean(),
      styles: z.array(z.string().max(32)).max(8).default([]),
      bio: z.string().max(500).default(''),
    }),
  ),
  asyncRoute(async (req: Request, res: Response) => {
    const { userId } = req as AuthedRequest;
    const body = req.body as {
      isPublic: boolean;
      styles: string[];
      bio: string;
    };
    // Publishing a profile must not require a prior PUT /users/me.
    await ensureUserRow(userId);
    const { rows } = await pool.query(
      `insert into leader_profiles (user_id, is_public, styles, bio)
       values ($1, $2, $3, $4)
       on conflict (user_id) do update set
         is_public = excluded.is_public,
         styles = excluded.styles,
         bio = excluded.bio,
         updated_at = now()
       returning *`,
      [userId, body.isPublic, body.styles, body.bio],
    );
    res.json({ profile: rows[0] });
  }),
);

// POST /leaders/:id/follow — follow a public leader.
leadersRouter.post(
  '/:id/follow',
  asyncRoute(async (req: Request, res: Response) => {
    const { userId } = req as AuthedRequest;
    const leaderId = req.params.id;
    if (leaderId === userId) {
      throw ApiError.badRequest('invalid_follow', 'Cannot follow yourself');
    }
    const { rows: leaders } = await pool.query(
      `select 1 from leader_profiles where user_id = $1 and is_public = true`,
      [leaderId],
    );
    if (leaders.length === 0) {
      throw ApiError.notFound('Leader not found or not public');
    }
    // follows.follower_id references public.users(id).
    await ensureUserRow(userId);
    await pool.query(
      `insert into follows (follower_id, leader_id) values ($1, $2)
       on conflict do nothing`,
      [userId, leaderId],
    );
    await pool.query(
      `update leader_profiles set followers_count = (
         select count(*) from follows where leader_id = $1
       ) where user_id = $1`,
      [leaderId],
    );
    res.status(201).json({ following: leaderId });
  }),
);

// DELETE /leaders/:id/follow — unfollow.
leadersRouter.delete(
  '/:id/follow',
  asyncRoute(async (req: Request, res: Response) => {
    const { userId } = req as AuthedRequest;
    const leaderId = req.params.id;
    await pool.query(
      `delete from follows where follower_id = $1 and leader_id = $2`,
      [userId, leaderId],
    );
    await pool.query(
      `update leader_profiles set followers_count = (
         select count(*) from follows where leader_id = $1
       ) where user_id = $1`,
      [leaderId],
    );
    res.json({ following: null });
  }),
);
