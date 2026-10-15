// Tournament engine.
//
// Weekly risk-adjusted PnL contests. Score rewards making
// money without blowing up:
//
//   Score = NetPnL / (1 + MaxDrawdown)
//
// Rankings are recomputed from each entrant's equity curve
// on a timer and written to tournament_entries; the mobile
// app reads the latest rows (and subscribes to
// leaderboard_snapshots over Realtime). Settlement reads the
// final scores — no on-chain settlement exists in v1.

import { logger } from '../lib/logger.js';
import { pool } from '../lib/db.js';
import type { SessionLookup } from './sessions.js';
import type { TournamentEntryRow, TournamentRow } from './types.js';
import { notify } from './notifications.js';

/** Risk-adjusted score: NetPnL discounted by max drawdown. */
export function tournamentScore(
  netPnl: number,
  maxDrawdown: number,
): number {
  return netPnl / (1 + Math.max(0, maxDrawdown));
}

export class TournamentEngine {
  constructor(private readonly sessions: SessionLookup) {}

  /** Scores every active tournament from entrants' equity curves. */
  async scoreOnce(): Promise<void> {
    const { rows: tournaments } = await pool.query<TournamentRow>(
      `select * from tournaments where status = 'active'`,
    );
    for (const tournament of tournaments) {
      try {
        await this.scoreTournament(tournament);
      } catch (error) {
        logger.error(
          `tournament scoring failed for ${tournament.id}`,
          error,
        );
      }
    }
  }

  private async scoreTournament(
    tournament: TournamentRow,
  ): Promise<void> {
    const { rows: entries } = await pool.query<TournamentEntryRow>(
      `select * from tournament_entries where tournament_id = $1`,
      [tournament.id],
    );

    const scored: Array<{
      userId: string;
      equity: number;
      netPnl: number;
      maxDrawdown: number;
      score: number;
    }> = [];

    for (const entry of entries) {
      const { rows: curve } = await pool.query<{ equity: number }>(
        `select equity from equity_snapshots
          where user_id = $1 and at >= $2 and at <= $3
          order by at`,
        [entry.user_id, tournament.starts_at, tournament.ends_at],
      );
      const equities = curve.map((r) => r.equity);
      const live = this.sessions.equityOf(entry.user_id);
      if (live !== undefined) equities.push(live);
      if (equities.length === 0) continue;

      const start =
        entry.equity_start > 0 ? entry.equity_start : equities[0];
      const equity = equities[equities.length - 1];
      const netPnl = equity - start;

      let peak = -Infinity;
      let maxDd = 0;
      for (const value of equities) {
        if (value > peak) peak = value;
        if (peak > 0) maxDd = Math.max(maxDd, (peak - value) / peak);
      }

      const score = tournamentScore(netPnl, maxDd);
      scored.push({
        userId: entry.user_id,
        equity,
        netPnl,
        maxDrawdown: maxDd,
        score,
      });
    }

    scored.sort((a, b) => b.score - a.score);

    const client = await pool.connect();
    try {
      await client.query('begin');
      let rank = 0;
      for (const s of scored) {
        rank += 1;
        await client.query(
          `update tournament_entries
              set net_pnl = $3, max_drawdown = $4, score = $5, rank = $6
            where tournament_id = $1 and user_id = $2`,
          [
            tournament.id,
            s.userId,
            s.netPnl,
            s.maxDrawdown,
            s.score,
            rank,
          ],
        );
        await client.query(
          `insert into leaderboard_snapshots
             (tournament_id, user_id, equity, net_pnl, max_drawdown, score)
           values ($1, $2, $3, $4, $5, $6)`,
          [
            tournament.id,
            s.userId,
            s.equity,
            s.netPnl,
            s.maxDrawdown,
            s.score,
          ],
        );
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }

    logger.debug(
      `tournament ${tournament.id} scored: ${scored.length} entries`,
    );
  }

  /** Transitions scheduled->active->settled based on wall clock. */
  async transitionOnce(): Promise<void> {
    // Activate tournaments whose start passed.
    const { rows: starting } = await pool.query<TournamentRow>(
      `update tournaments set status = 'active'
        where status = 'scheduled' and starts_at <= now()
        returning *`,
    );
    for (const tournament of starting) {
      // Seed each entrant's starting equity from their curve.
      const { rows: entries } = await pool.query<TournamentEntryRow>(
        `select * from tournament_entries where tournament_id = $1`,
        [tournament.id],
      );
      for (const entry of entries) {
        const start =
          this.sessions.equityOf(entry.user_id) ?? entry.equity_start;
        await pool.query(
          `update tournament_entries
              set equity_start = $3, equity_peak = $3, equity_low = $3
            where tournament_id = $1 and user_id = $2`,
          [tournament.id, entry.user_id, start],
        );
      }
      logger.info(`tournament ${tournament.id} activated`);
    }

    // Settle tournaments whose end passed.
    const { rows: ending } = await pool.query<TournamentRow>(
      `update tournaments set status = 'settled'
        where status = 'active' and ends_at <= now()
        returning *`,
    );
    for (const tournament of ending) {
      await this.scoreTournament(tournament);
      const { rows: winners } = await pool.query<TournamentEntryRow>(
        `select * from tournament_entries
          where tournament_id = $1 order by rank nulls last limit 3`,
        [tournament.id],
      );
      for (const winner of winners) {
        await notify(winner.user_id, 'tournament_settled', {
          tournamentId: tournament.id,
          rank: winner.rank,
          score: winner.score,
        });
      }
      logger.info(
        `tournament ${tournament.id} settled with ${winners.length} ranked`,
      );
    }
  }
}
