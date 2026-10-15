// Worker entry: the trading brain.
//
// Owns the market-data WebSocket, one authenticated trading
// session per enrolled key, the copy engine, leader stats,
// and tournament scoring. Writes state to Postgres; the
// mobile app reads it via the API tier and Supabase Realtime.

import { logger } from './lib/logger.js';
import { pool } from './lib/db.js';
import {
  COPY_POLL_MS,
  DRY_RUN,
  LEADER_SNAPSHOT_MS,
  RISK_CHECK_MS,
  TOURNAMENT_SNAPSHOT_MS,
} from './config.js';
import { marketRegistry } from './perpl/context.js';
import { MarketDataClient } from './perpl/marketDataWs.js';
import { SessionRegistry } from './engine/sessions.js';
import { CopyEngine } from './engine/copyEngine.js';
import { refreshLeaderStats } from './engine/leaders.js';
import { TournamentEngine } from './engine/tournaments.js';

async function main(): Promise<void> {
  logger.info('perpl-arena worker starting');
  if (DRY_RUN) {
    logger.warn(
      'DRY RUN MODE: copy orders and kill-switch closes are simulated, nothing is submitted to Perpl',
    );
  }

  // Market context first: ids and decimals drive everything.
  for (let attempt = 1; ; attempt++) {
    try {
      await marketRegistry.refresh();
      break;
    } catch (error) {
      logger.warn(
        `market context fetch failed (attempt ${attempt}), retrying in 10s`,
        error,
      );
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }

  const marketData = new MarketDataClient();

  // Observe every public leader's session for copy signals.
  // A DB outage yields an empty set; the refresh loop picks
  // leaders up later instead of crashing the worker.
  let leaders: Array<{ user_id: string }> = [];
  try {
    const result = await pool.query<{ user_id: string }>(
      `select user_id from leader_profiles where is_public = true`,
    );
    leaders = result.rows;
  } catch (error) {
    logger.error(
      'worker startup: leader query failed, continuing with none',
      error,
    );
  }

  const copyEngineHolder: { engine?: CopyEngine } = {};

  const sessions = new SessionRegistry(marketData, {
    onLeaderPositions: (leaderUserId, positions) =>
      copyEngineHolder.engine?.onLeaderPositions(leaderUserId, positions) ??
      Promise.resolve(),
    onFollowerPositions: (userId, positions) =>
      copyEngineHolder.engine?.onFollowerPositions(userId, positions) ??
      Promise.resolve(),
    onFollowerFill: (userId, fill, requestId) =>
      copyEngineHolder.engine?.onFollowerFill(userId, fill, requestId) ??
      Promise.resolve(),
  });
  for (const { user_id } of leaders) sessions.observeLeader(user_id);

  const copyEngine = new CopyEngine(sessions, marketData);
  copyEngineHolder.engine = copyEngine;
  const tournaments = new TournamentEngine(sessions);

  // Keep the leader set fresh: profiles flip public/private at runtime.
  const refreshLeaders = async (): Promise<void> => {
    try {
      const { rows } = await pool.query<{ user_id: string }>(
        `select user_id from leader_profiles where is_public = true`,
      );
      const current = new Set(rows.map((r) => r.user_id));
      for (const id of current) {
        if (!sessions.isLeaderObserved(id)) sessions.observeLeader(id);
      }
    } catch (error) {
      logger.error('leader set refresh failed', error);
    }
  };

  // Public market data: state stream for prices + head block.
  const { PERPL_CHAIN_ID } = await import('./config.js');
  marketData.connect();
  marketData.subscribe([`market-state@${PERPL_CHAIN_ID}`]);

  await sessions.start();

  const loop = (
    name: string,
    ms: number,
    fn: () => Promise<unknown>,
  ): ReturnType<typeof setInterval> => {
    const timer = setInterval(() => {
      fn().catch((error) => logger.error(`${name} loop failed`, error));
    }, ms);
    timer.unref();
    return timer;
  };

  loop('kill-switch', 1000, () => copyEngine.consumeKillSwitches());
  loop('manual-intents', 1000, () => copyEngine.consumeOrderIntents());
  loop('risk-monitor', RISK_CHECK_MS, () => copyEngine.monitorOnce());
  loop('reconcile', 60_000, () => copyEngine.reconcileOnce());
  loop('leader-refresh', 5 * 60_000, refreshLeaders);
  loop('leader-stats', LEADER_SNAPSHOT_MS, () => refreshLeaderStats());
  loop('tournaments', TOURNAMENT_SNAPSHOT_MS, () => tournaments.scoreOnce());
  loop('tournament-transitions', 60_000, () => tournaments.transitionOnce());
  // Market context refresh: picks up listings/delistings.
  loop('market-context', 10 * 60_000, () => marketRegistry.refresh());

  // Initial passes so state is warm without waiting a full interval.
  await refreshLeaderStats().catch((error) =>
    logger.error('initial leader stats failed', error),
  );
  await tournaments.transitionOnce().catch((error) =>
    logger.error('initial tournament transition failed', error),
  );

  logger.info(
    `worker running (poll=${COPY_POLL_MS}ms risk=${RISK_CHECK_MS}ms)`,
  );
}

const shutdown = (): void => {
  logger.info('worker shutting down');
  pool.end().finally(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((error) => {
  logger.error('worker fatal', error);
  process.exit(1);
});
