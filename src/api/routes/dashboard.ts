// Dashboard: the mobile home screen in one round trip —
// balances, positions with live prices, today's copied PnL,
// active copy settings, and unread notifications.

import { Router, type Request, type Response } from 'express';
import { pool } from '../../lib/db.js';
import { asyncRoute, requireAuth, type AuthedRequest } from '../middleware.js';

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth);

dashboardRouter.get(
  '/',
  asyncRoute(async (req: Request, res: Response) => {
    const { userId } = req as AuthedRequest;

    const [
      { rows: equityRows },
      { rows: walletRows },
      { rows: positions },
      { rows: settings },
    ] =
      await Promise.all([
        pool.query<{ equity: number; at: string }>(
          `select equity, at from equity_snapshots
            where user_id = $1 order by at desc limit 1`,
          [userId],
        ),
        pool.query<{
          balance: number | null;
          locked: number | null;
          wallet_at: string | null;
        }>(
          `select sum(wallet_balance_usd) as balance,
                  sum(wallet_locked_usd) as locked,
                  max(wallet_updated_at) as wallet_at
             from perpl_accounts
            where user_id = $1 and status = 'active'
              and wallet_balance_usd is not null`,
          [userId],
        ),
        pool.query(
          `select p.market_id, m.symbol, p.side, p.size_scaled,
                  p.entry_price_scaled, p.leverage_hundredths,
                  p.leader_id, u.handle as leader_handle,
                  c.last_price, c.mark_price
             from positions p
             left join market_cache m on m.market_id = p.market_id
             left join price_cache c on c.market_id = p.market_id
             left join users u on u.id = p.leader_id
            where p.user_id = $1`,
          [userId],
        ),
        pool.query(
          `select s.*, u.handle as leader_handle
             from copy_settings s
             left join users u on u.id = s.leader_id
            where s.user_id = $1 and s.enabled`,
          [userId],
        ),
      ]);

    const [{ rows: pnlRows }, { rows: notifications }] = await Promise.all([
      pool.query<{ realized: string }>(
        `select coalesce(sum(realized_usd), 0) as realized
           from copy_pnl_events
          where user_id = $1 and created_at >= date_trunc('day', now())`,
        [userId],
      ),
      pool.query(
        `select * from notifications
          where user_id = $1 and read = false
          order by created_at desc limit 20`,
        [userId],
      ),
    ]);

    res.json({
      equity: equityRows[0]?.equity ?? null,
      equityAt: equityRows[0]?.at ?? null,
      balance: walletRows[0]?.balance ?? null,
      locked: walletRows[0]?.locked ?? null,
      walletAt: walletRows[0]?.wallet_at ?? null,
      positions,
      activeCopySettings: settings,
      realizedPnlToday: Number(pnlRows[0]?.realized ?? '0'),
      unreadNotifications: notifications,
    });
  }),
);

// POST /notifications/read — mark notifications read.
dashboardRouter.post(
  '/notifications/read',
  asyncRoute(async (req: Request, res: Response) => {
    const { userId } = req as AuthedRequest;
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (ids.length === 0) {
      await pool.query(
        `update notifications set read = true where user_id = $1 and read = false`,
        [userId],
      );
    } else {
      await pool.query(
        `update notifications set read = true
          where user_id = $1 and id = any($2::bigint[])`,
        [userId, ids.map(Number).filter(Number.isFinite)],
      );
    }
    res.json({ ok: true });
  }),
);
