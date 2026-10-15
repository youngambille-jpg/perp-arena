// Leader statistics.
//
// Recomputes each public leader's profile row from their
// equity curve: total PnL, 24h PnL, win rate (share of
// positive daily closes), max drawdown, and a Sharpe-like
// score (mean/std of daily returns). Follower counts are
// maintained by the follows endpoints.

import { logger } from '../lib/logger.js';
import { pool } from '../lib/db.js';

export async function refreshLeaderStats(
  leaderUserId?: string,
): Promise<void> {
  const { rows } = await pool.query<{ user_id: string }>(
    leaderUserId
      ? `select user_id from leader_profiles where user_id = $1 and is_public`
      : `select user_id from leader_profiles where is_public`,
    leaderUserId ? [leaderUserId] : [],
  );

  for (const { user_id } of rows) {
    try {
      await refreshOneLeader(user_id);
    } catch (error) {
      logger.error(`leader stats refresh failed for ${user_id}`, error);
    }
  }
}

async function refreshOneLeader(userId: string): Promise<void> {
  const { rows: curve } = await pool.query<{
    equity: number;
    at: string;
  }>(
    `select equity, at from equity_snapshots
      where user_id = $1 and at >= now() - interval '30 days'
      order by at`,
    [userId],
  );
  if (curve.length < 2) return;

  const equities = curve.map((r) => r.equity);
  const first = equities[0];
  const last = equities[equities.length - 1];

  const totalPnl = last - first;

  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const cut = curve.findIndex(
    (r) => new Date(r.at).getTime() >= dayAgo,
  );
  const pnl24h =
    cut > 0 ? last - curve[cut].equity : totalPnl;

  // Daily closes: last equity per UTC day.
  const byDay = new Map<string, number>();
  for (const row of curve) {
    byDay.set(new Date(row.at).toISOString().slice(0, 10), row.equity);
  }
  const closes = [...byDay.values()];
  const dailyReturns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    if (prev > 0) dailyReturns.push((closes[i] - prev) / prev);
  }
  const wins = dailyReturns.filter((r) => r > 0).length;
  const winRate =
    dailyReturns.length > 0 ? wins / dailyReturns.length : 0;

  let peak = -Infinity;
  let maxDd = 0;
  for (const equity of equities) {
    if (equity > peak) peak = equity;
    if (peak > 0) maxDd = Math.max(maxDd, (peak - equity) / peak);
  }

  const mean =
    dailyReturns.length > 0
      ? dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length
      : 0;
  const variance =
    dailyReturns.length > 1
      ? dailyReturns.reduce((a, b) => a + (b - mean) ** 2, 0) /
        (dailyReturns.length - 1)
      : 0;
  const std = Math.sqrt(variance);
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(365) : 0;

  await pool.query(
    `update leader_profiles
        set total_pnl_usd = $2, pnl_24h_usd = $3, win_rate = $4,
            max_drawdown = $5, sharpe = $6, updated_at = now()
      where user_id = $1`,
    [userId, totalPnl, pnl24h, winRate, maxDd, sharpe],
  );
}
