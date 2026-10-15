// Copy-trading management: risk-limited settings per
// (follower, leader) pair, the copy-order audit trail, and
// the one-tap kill switch.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { pool } from '../../lib/db.js';
import { ApiError } from '../../lib/errors.js';
import {
  asyncRoute,
  requireAuth,
  validateBody,
  type AuthedRequest,
} from '../middleware.js';

export const copyRouter = Router();
copyRouter.use(requireAuth);

const riskSettingsSchema = z.object({
  allocationUsd: z.number().positive().max(10_000_000),
  maxLeverage: z.number().min(1).max(50).default(3),
  maxNotionalPerTradeUsd: z.number().positive().max(10_000_000).default(5000),
  dailyLossLimitUsd: z.number().positive().max(10_000_000).default(50),
  weeklyDrawdownLimitBps: z.number().int().min(0).max(10_000).default(1000),
  marketAllowlist: z.array(z.number().int()).max(64).default([]),
  marketBlacklist: z.array(z.number().int()).max(64).default([]),
  slippageBps: z.number().int().min(0).max(10_000).default(50),
  copyDelayMs: z.number().int().min(0).max(60_000).default(1500),
  reduceOnly: z.boolean().default(false),
  stopLossBps: z.number().int().min(0).max(10_000).default(2000),
  enabled: z.boolean().default(true),
});

// PUT /copy/:leaderId — create or replace copy settings.
// Requires a trade-scoped enrolled key and a followed leader.
copyRouter.put(
  '/:leaderId',
  validateBody(riskSettingsSchema),
  asyncRoute(async (req: Request, res: Response) => {
    const { userId } = req as AuthedRequest;
    const leaderId = req.params.leaderId;
    const body = req.body as z.infer<typeof riskSettingsSchema>;

    const { rows: follows } = await pool.query(
      `select 1 from follows where follower_id = $1 and leader_id = $2`,
      [userId, leaderId],
    );
    if (follows.length === 0) {
      throw ApiError.badRequest(
        'not_following',
        'Follow the leader before enabling copy-trading',
      );
    }
    const { rows: keys } = await pool.query(
      `select 1 from perpl_accounts
        where user_id = $1 and status = 'active' and (scope_mask & 2) = 2`,
      [userId],
    );
    if (keys.length === 0) {
      throw ApiError.badRequest(
        'no_trade_key',
        'Enroll a trade-scoped Perpl API key before copying',
      );
    }

    const { rows } = await pool.query(
      `insert into copy_settings
         (user_id, leader_id, allocation_usd, max_leverage,
          max_notional_per_trade_usd, daily_loss_limit_usd,
          weekly_drawdown_limit_bps, market_allowlist, market_blacklist,
          slippage_bps, copy_delay_ms, reduce_only, stop_loss_bps,
          enabled, paused_reason, kill_switch_requested_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, null, null, now())
       on conflict (user_id, leader_id) do update set
         allocation_usd = excluded.allocation_usd,
         max_leverage = excluded.max_leverage,
         max_notional_per_trade_usd = excluded.max_notional_per_trade_usd,
         daily_loss_limit_usd = excluded.daily_loss_limit_usd,
         weekly_drawdown_limit_bps = excluded.weekly_drawdown_limit_bps,
         market_allowlist = excluded.market_allowlist,
         market_blacklist = excluded.market_blacklist,
         slippage_bps = excluded.slippage_bps,
         copy_delay_ms = excluded.copy_delay_ms,
         reduce_only = excluded.reduce_only,
         stop_loss_bps = excluded.stop_loss_bps,
         enabled = excluded.enabled,
         paused_reason = null,
         kill_switch_requested_at = null,
         updated_at = now()
       returning *`,
      [
        userId,
        leaderId,
        body.allocationUsd,
        body.maxLeverage,
        body.maxNotionalPerTradeUsd,
        body.dailyLossLimitUsd,
        body.weeklyDrawdownLimitBps,
        body.marketAllowlist,
        body.marketBlacklist,
        body.slippageBps,
        body.copyDelayMs,
        body.reduceOnly,
        body.stopLossBps,
        body.enabled,
      ],
    );
    res.json({ settings: rows[0] });
  }),
);

// GET /copy — all of the caller's copy settings.
copyRouter.get(
  '/',
  asyncRoute(async (req: Request, res: Response) => {
    const { userId } = req as AuthedRequest;
    const { rows } = await pool.query(
      `select s.*, u.handle as leader_handle
         from copy_settings s
         left join users u on u.id = s.leader_id
        where s.user_id = $1 order by s.updated_at desc`,
      [userId],
    );
    res.json({ settings: rows });
  }),
);

// DELETE /copy/:leaderId — stop copying (keeps history).
copyRouter.delete(
  '/:leaderId',
  asyncRoute(async (req: Request, res: Response) => {
    const { userId } = req as AuthedRequest;
    await pool.query(
      `delete from copy_settings where user_id = $1 and leader_id = $2`,
      [userId, req.params.leaderId],
    );
    res.json({ copying: null });
  }),
);

// POST /copy/kill-switch — one tap: request closure of all
// copied positions and pause every copy setting. The worker
// consumes the request within ~1s.
copyRouter.post(
  '/kill-switch',
  asyncRoute(async (req: Request, res: Response) => {
    const { userId } = req as AuthedRequest;
    const { rowCount } = await pool.query(
      `update copy_settings
          set kill_switch_requested_at = now(), updated_at = now()
        where user_id = $1 and enabled`,
      [userId],
    );
    res.json({ killSwitchRequested: true, affectedSettings: rowCount });
  }),
);

// GET /copy/orders?leader=&limit= — the audit trail.
copyRouter.get(
  '/orders',
  asyncRoute(async (req: Request, res: Response) => {
    const { userId } = req as AuthedRequest;
    const limit = Math.min(
      Math.max(Number(req.query.limit ?? 50), 1),
      200,
    );
    const params: unknown[] = [userId];
    let leaderFilter = '';
    if (typeof req.query.leader === 'string' && req.query.leader) {
      params.push(req.query.leader);
      leaderFilter = `and leader_id = $${params.length}`;
    }
    params.push(limit);
    const { rows } = await pool.query(
      `select * from copy_orders
        where user_id = $1 ${leaderFilter}
        order by created_at desc limit $${params.length}`,
      params,
    );
    res.json({ orders: rows });
  }),
);

// GET /copy/risk-events?limit= — guardrail history.
copyRouter.get(
  '/risk-events',
  asyncRoute(async (req: Request, res: Response) => {
    const { userId } = req as AuthedRequest;
    const limit = Math.min(
      Math.max(Number(req.query.limit ?? 50), 1),
      200,
    );
    const { rows } = await pool.query(
      `select * from risk_events where user_id = $1
        order by created_at desc limit $2`,
      [userId, limit],
    );
    res.json({ events: rows });
  }),
);
