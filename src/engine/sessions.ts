// Session registry.
//
// Owns one authenticated TradingSession per enrolled Perpl
// account, plus a matching signed REST client and a live
// equity cache. Sessions are opened lazily on demand and
// rebuilt when their key material changes. Postgres unique
// constraints on copy_orders.request_id are the duplicate-
// submission backstop; each session's strictly-increasing rq
// counter (seeded from the account's lfr) is the first line
// of defense.

import { logger } from '../lib/logger.js';
import { pool } from '../lib/db.js';
import { decrypt } from '../lib/crypto.js';
import {
  COPY_POLL_MS,
  LEADER_SNAPSHOT_MS,
  SESSION_POLL_MS,
} from '../config.js';
import {
  PerplRestClient,
  privateKeyFromHex,
  type KeyMaterial,
} from '../perpl/rest.js';
import { TradingSession } from '../perpl/tradingWs.js';
import { rawToUsd } from '../perpl/scaling.js';
import { marketRegistry } from '../perpl/context.js';
import { unrealizedPnl } from './risk.js';
import type { MarketDataClient } from '../perpl/marketDataWs.js';
import type { Fill, Position } from '../perpl/types.js';
import type { PerplAccountRow } from './types.js';
import { notify } from './notifications.js';

export interface SessionLookup {
  sessionFor(userId: string): TradingSession | undefined;
  restFor(userId: string): PerplRestClient | undefined;
  equityOf(userId: string): number | undefined;
}

type ManagedAccount = {
  row: PerplAccountRow;
  userId: string;
  session?: TradingSession;
  rest?: PerplRestClient;
  lastEquity?: number;
  lastPositions: Position[];
  lastPositionsAt: number;
  consecutiveFailures: number;
};

export type SessionEvents = {
  onLeaderPositions?: (
    leaderUserId: string,
    positions: Position[],
  ) => Promise<void>;
  onFollowerPositions?: (
    userId: string,
    positions: Position[],
  ) => Promise<void>;
  onFollowerFill?: (
    userId: string,
    fill: Fill,
    requestId?: number,
  ) => Promise<void>;
};

export class SessionRegistry implements SessionLookup {
  private accounts = new Map<string, ManagedAccount>(); // perpl_accounts.id -> managed
  private byUser = new Map<string, ManagedAccount[]>(); // user_id -> managed
  private leaders = new Set<string>(); // user ids under leader observation
  private running = false;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private snapshotTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly marketData: MarketDataClient,
    private readonly events: SessionEvents = {},
  ) {}

  sessionFor(userId: string): TradingSession | undefined {
    return this.byUser.get(userId)?.[0]?.session;
  }

  restFor(userId: string): PerplRestClient | undefined {
    return this.byUser.get(userId)?.[0]?.rest;
  }

  equityOf(userId: string): number | undefined {
    return this.byUser.get(userId)?.[0]?.lastEquity;
  }

  /** Mark a user as a public leader: their session's position
   * updates feed the copy engine. */
  observeLeader(userId: string): void {
    this.leaders.add(userId);
  }

  unobserveLeader(userId: string): void {
    this.leaders.delete(userId);
  }

  isLeaderObserved(userId: string): boolean {
    return this.leaders.has(userId);
  }

  async start(): Promise<void> {
    this.running = true;
    await this.syncAccounts();
    this.pollTimer = setInterval(
      () => void this.syncAccounts(),
      SESSION_POLL_MS,
    );
    this.snapshotTimer = setInterval(
      () => void this.snapshotLeaders(),
      LEADER_SNAPSHOT_MS,
    );
    logger.info('session registry started');
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    for (const account of this.accounts.values()) {
      account.session?.disconnect();
    }
    this.accounts.clear();
    this.byUser.clear();
  }

  /**
   * Reconciles managed sessions with perpl_accounts: opens
   * sessions for new/changed keys, tears down revoked ones.
   */
  async syncAccounts(): Promise<void> {
    if (!this.running) return;
    let rows: PerplAccountRow[];
    try {
      const result = await pool.query<PerplAccountRow>(
        `select * from perpl_accounts where status = 'active'`,
      );
      rows = result.rows;
    } catch (error) {
      logger.error('session sync: account query failed', error);
      return;
    }

    const seen = new Set<string>();
    for (const row of rows) {
      seen.add(row.id);
      const existing = this.accounts.get(row.id);
      if (
        existing &&
        existing.row.api_key_token === row.api_key_token &&
        existing.row.api_key_secret === row.api_key_secret &&
        existing.row.status === row.status
      ) {
        continue; // unchanged
      }
      if (existing?.session) {
        existing.session.disconnect();
        existing.session = undefined;
        existing.rest = undefined;
      }
      this.openAccount(row);
    }

    for (const [id, managed] of this.accounts) {
      if (!seen.has(id)) {
        managed.session?.disconnect();
        this.accounts.delete(id);
        const list = this.byUser.get(managed.userId) ?? [];
        this.byUser.set(
          managed.userId,
          list.filter((m) => m !== managed),
        );
      }
    }
  }

  private openAccount(row: PerplAccountRow): void {
    let key: KeyMaterial;
    try {
      key = {
        token: decrypt(row.api_key_token),
        privateKey: privateKeyFromHex(decrypt(row.api_key_secret)),
      };
    } catch (error) {
      logger.error(
        `session ${row.id}: key decryption failed, marking error`,
        error,
      );
      void pool.query(
        `update perpl_accounts set status = 'error', last_error = 'key decryption failed' where id = $1`,
        [row.id],
      );
      return;
    }

    // Builder terms come from the enrolled key. The worker never
    // exceeds the user's signed ceiling; when no builder code is
    // configured the fee is omitted entirely.
    const rest = new PerplRestClient(key);
    const session = new TradingSession(key, {
      userId: row.user_id,
      headBlockProvider: () => this.marketData.headBlock,
      // Deadline blocks come from the live market config (testnet
      // markets allow 20), not the client-side fallback.
      orderTtlProvider: (marketId) =>
        marketRegistry.market(marketId)?.order_ttl_blocks,
    });
    session.builderId =
      row.builder_id && row.builder_id > 0 ? row.builder_id : undefined;
    session.maxBuilderFeePer100k = row.max_builder_fee_per_100k;

    const managed: ManagedAccount = {
      row,
      userId: row.user_id,
      session,
      rest,
      lastPositions: [],
      lastPositionsAt: 0,
      consecutiveFailures: 0,
    };
    this.accounts.set(row.id, managed);
    const list = this.byUser.get(row.user_id) ?? [];
    list.push(managed);
    this.byUser.set(row.user_id, list);

    session.on('ready', () => {
      managed.consecutiveFailures = 0;
      // Persist the discovered on-chain account id for the API tier.
      if (session.accountId !== undefined) {
        void pool
          .query(
            `update perpl_accounts set account_id = $1, connected_at = now(), last_error = null where id = $2`,
            [String(session.accountId), row.id],
          )
          .catch((error) =>
            logger.error('account_id persist failed', error),
          );
      }
      // Pull an immediate position snapshot so the copy engine
      // has leader state without waiting for the next update.
      void this.pullPositions(managed);
    });

    session.on('wallet', () => {
      this.updateEquity(managed, session);
    });
    session.on('walletUpdate', () => {
      this.updateEquity(managed, session);
    });
    session.on('account', () => {
      this.updateEquity(managed, session);
    });

    session.on('positions', (positions: Position[]) => {
      void this.handlePositions(managed, positions);
    });
    session.on('positionUpdate', (positions: Position[]) => {
      void this.handlePositions(managed, positions);
    });

    session.on('fill', (fill: Fill, requestId?: number) => {
      if (this.leaders.has(row.user_id)) {
        void this.recordLeaderFill(row.user_id, fill);
      }
      // Follower fills feed the copy-order audit trail.
      if (this.events.onFollowerFill) {
        void this.events
          .onFollowerFill(row.user_id, fill, requestId)
          .catch((error) =>
            logger.error('onFollowerFill handler failed', error),
          );
      }
    });

    // Gateway admission moves order rows submitted -> open
    // (copy and manual tickets share the rq correlation).
    session.on('admitted', (requestId: number) => {
      const params = [String(requestId), row.user_id];
      void pool
        .query(
          `update copy_orders set status = 'open'
            where request_id = $1::bigint and user_id = $2
              and status = 'submitted'`,
          params,
        )
        .catch((error) => logger.error('admission record failed', error));
      void pool
        .query(
          `update manual_orders set status = 'open'
            where request_id = $1::bigint and user_id = $2
              and status = 'submitted'`,
          params,
        )
        .catch((error) => logger.error('admission record failed', error));
    });

    session.on('closed', () => {
      // Reconnect is owned by the session; here we only note it.
      logger.debug(`session closed for user ${row.user_id}`);
    });

    session.connect();
  }

  private updateEquity(
    managed: ManagedAccount,
    session: TradingSession,
  ): void {
    if (session.balance === undefined) return;
    // Equity = on-chain balance + unrealized PnL of the cached
    // positions at the latest mark price. Without this, equity
    // curves (and everything downstream: leader stats, tournament
    // scores, drawdown guards) ignore open positions. Missing
    // prices degrade to balance-only for that position.
    let equity = rawToUsd(session.balance);
    for (const position of managed.lastPositions) {
      const market = marketRegistry.market(position.mkt);
      const state = this.marketData.stateFor(position.mkt);
      const price = state?.lst ?? state?.mrk ?? state?.mid;
      const size = BigInt(position.s ?? 0);
      const entry = BigInt(position.ep ?? 0);
      if (!market || price === undefined || size <= 0n || entry <= 0n) {
        continue;
      }
      equity += unrealizedPnl(
        market,
        (position.sd ?? 1) === 2 ? 2 : 1,
        size,
        entry,
        BigInt(Math.round(price)),
      );
    }
    managed.lastEquity = equity;
    const balance = rawToUsd(session.balance);
    const locked =
      session.lockedBalance === undefined
        ? null
        : rawToUsd(session.lockedBalance);
    void pool
      .query(
        `update perpl_accounts
            set wallet_balance_usd = $1,
                wallet_locked_usd = coalesce($2, wallet_locked_usd),
                wallet_updated_at = now()
          where id = $3`,
        [balance, locked, managed.row.id],
      )
      .catch((error) =>
        logger.error('wallet balance mirror write failed', error),
      );
    void pool
      .query(
        `insert into equity_snapshots (user_id, equity) values ($1, $2)`,
        [managed.userId, equity],
      )
      .catch((error) =>
        logger.error('equity snapshot write failed', error),
      );
  }

  private async handlePositions(
    managed: ManagedAccount,
    positions: Position[],
  ): Promise<void> {
    managed.lastPositions = positions;
    managed.lastPositionsAt = Date.now();
    try {
      if (this.leaders.has(managed.userId)) {
        await this.recordLeaderPositions(managed.userId, positions);
        if (this.events.onLeaderPositions) {
          await this.events.onLeaderPositions(managed.userId, positions);
        }
      } else if (this.events.onFollowerPositions) {
        await this.events.onFollowerPositions(managed.userId, positions);
      }
    } catch (error) {
      // Event handlers hit the DB; a failure here must degrade to
      // a missed update, never an unhandled rejection (which would
      // crash the worker on Node 24).
      logger.error(
        `position handler failed for user ${managed.userId}`,
        error,
      );
    }
  }

  private async recordLeaderPositions(
    leaderUserId: string,
    _positions: Position[],
  ): Promise<void> {
    // Leader position history is derived from fills; the snapshot
    // itself is consumed live by the copy engine. Refresh the
    // profile's updated_at so the leaderboard shows liveness.
    try {
      await pool.query(
        `update leader_profiles set updated_at = now() where user_id = $1`,
        [leaderUserId],
      );
    } catch (error) {
      logger.error('leader profile touch failed', error);
    }
  }

  private async recordLeaderFill(
    leaderUserId: string,
    fill: Fill,
  ): Promise<void> {
    try {
      const at =
        fill.at && typeof fill.at.t === 'number'
          ? new Date(fill.at.t)
          : new Date();
      await pool.query(
        `insert into leader_fills
           (leader_user_id, market_id, order_type, liquidity,
            price_scaled, size_scaled, fee, builder_fee, at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          leaderUserId,
          fill.mkt,
          fill.t,
          fill.l ?? null,
          fill.p !== undefined ? String(fill.p) : null,
          String(fill.s),
          fill.f ?? null,
          fill.bfa ?? null,
          at.toISOString(),
        ],
      );
    } catch (error) {
      logger.error('leader fill record failed', error);
    }
  }

  /** Pulls a REST position snapshot for accounts that went quiet. */
  private async pullPositions(managed: ManagedAccount): Promise<void> {
    if (!managed.rest) return;
    try {
      const snapshot = await managed.rest.positions();
      await this.handlePositions(managed, snapshot.d ?? []);
    } catch (error) {
      logger.warn(
        `position pull failed for user ${managed.userId}`,
        error,
      );
    }
  }

  /**
   * Periodic REST snapshot for every observed leader whose WS
   * went quiet (>2 poll intervals without a position frame).
   * The WS is the live path; this is the safety net.
   */
  private async snapshotLeaders(): Promise<void> {
    if (!this.running) return;
    const cutoff = Date.now() - 2 * COPY_POLL_MS;
    for (const managed of this.accounts.values()) {
      if (!this.leaders.has(managed.userId)) continue;
      if (managed.lastPositionsAt > cutoff) continue;
      if (!managed.rest) continue;
      try {
        await this.pullPositions(managed);
      } catch (error) {
        logger.warn('leader snapshot failed', error);
      }
    }
  }

  /** Force-teardown of one user's sessions (used after revocation). */
  async dropUser(userId: string): Promise<void> {
    const list = this.byUser.get(userId) ?? [];
    for (const managed of list) {
      managed.session?.disconnect();
      this.accounts.delete(managed.row.id);
    }
    this.byUser.delete(userId);
  }
}
