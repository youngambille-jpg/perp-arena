// Copy engine.
//
// Watches public leaders' position updates and translates
// them into each follower's own Perpl account, through the
// follower's own enrolled API key, within that follower's
// risk limits. Never mirrors blindly: notional is scaled by
// allocation/equity, clamped by leverage and per-trade caps,
// gated by market allow/blacklists, daily loss limits,
// weekly drawdown limits, stop-losses, and a one-tap kill
// switch.

import type { PoolClient } from 'pg';
import { logger } from '../lib/logger.js';
import { pool } from '../lib/db.js';
import {
  COPY_DELAY_MS,
  DRY_RUN,
  PERPL_BUILDER_FEE_PER_100K,
} from '../config.js';
import { MarketDataClient } from '../perpl/marketDataWs.js';
import type { Position } from '../perpl/types.js';
import { notionalToScaledSize, scaledSizeToNotional, fromScaledPrice } from '../perpl/scaling.js';
import { marketRegistry } from '../perpl/context.js';
import type { SessionLookup } from './sessions.js';
import {
  maxDrawdownBps as maxDrawdownBpsFromRisk,
  stopLossBreached,
  translateOrder,
  unrealizedPnl,
} from './risk.js';
import type {
  CopyOrderRow,
  CopySettings,
  ManualOrderRow,
  PositionRow,
} from './types.js';
import { notify } from './notifications.js';

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

// Dry-run request ids are negative and process-local: they can
// never collide with real Perpl rq values (strictly increasing
// positives), and the reconciler skips dry_run rows entirely.
let dryRqCounter = 0;
const nextDryRq = (): number => -(++dryRqCounter);

/**
 * The copy engine. `sessions` supplies the per-user trading
 * WS sessions, REST clients, and the equity cache.
 */
export class CopyEngine {
  // leaderUserId -> marketId -> latest leader position
  private leaderPositions = new Map<string, Map<number, Position>>();

  constructor(
    private readonly sessions: SessionLookup,
    private readonly marketData: MarketDataClient,
  ) {}

  // ---------------------------------------------------------- leader side

  /** Called by the session registry on a leader's position update. */
  async onLeaderPositions(
    leaderUserId: string,
    positions: Position[],
  ): Promise<void> {
    const byMarket = new Map<number, Position>();
    for (const position of positions) {
      if ((position.s ?? 0) > 0) byMarket.set(position.mkt, position);
    }
    this.leaderPositions.set(leaderUserId, byMarket);

    const leaderEquity = this.sessions.equityOf(leaderUserId);
    if (leaderEquity === undefined) return;

    const { rows } = await pool.query<CopySettings>(
      `select * from copy_settings
        where leader_id = $1 and enabled
          and kill_switch_requested_at is null`,
      [leaderUserId],
    );

    for (const settings of rows) {
      try {
        await this.rebalance(
          settings,
          leaderUserId,
          byMarket,
          leaderEquity,
        );
      } catch (error) {
        logger.error(
          `copy rebalance failed for ${settings.user_id} <- ${leaderUserId}`,
          error,
        );
      }
    }
  }

  /** Rebalances one follower against one leader's positions. */
  private async rebalance(
    settings: CopySettings,
    leaderUserId: string,
    leaderPositions: Map<number, Position>,
    leaderEquity: number,
  ): Promise<void> {
    const followerId = settings.user_id;

    // Guardrail: daily loss cutoff pauses copying.
    const daily = await this.dailyLoss(followerId);
    if (daily.breached) {
      await this.pause(
        settings,
        'daily_loss_limit',
        `daily loss ${daily.loss.toFixed(2)} USD exceeds ${settings.daily_loss_limit_usd} USD`,
      );
      return;
    }

    // Guardrail: weekly drawdown cutoff.
    const weekly = await this.weeklyDrawdown(followerId);
    if (weekly.breached) {
      await this.pause(
        settings,
        'weekly_drawdown_limit',
        `drawdown ${(weekly.bps / 100).toFixed(2)}% exceeds ${(settings.weekly_drawdown_limit_bps / 100).toFixed(2)}%`,
      );
      return;
    }

    const session = this.sessions.sessionFor(followerId);
    if (!session || !session.ready) return;

    const { rows: copiedRows } = await pool.query<PositionRow>(
      `select * from positions where user_id = $1 and leader_id = $2`,
      [followerId, leaderUserId],
    );
    const copiedByMarket = new Map(
      copiedRows.map((p) => [p.market_id, p]),
    );

    for (const [marketId, leaderPos] of leaderPositions) {
      const market = marketRegistry.market(marketId);
      if (!market) continue;
      const priceScaled = this.currentPriceScaled(marketId);
      if (priceScaled === undefined || priceScaled <= 0n) continue;

      const leaderSide = (leaderPos.t ?? 1) === 2 ? 2 : 1;
      const leaderNotional = scaledSizeToNotional(
        market,
        BigInt(leaderPos.s ?? 0),
        priceScaled,
      );

      const translation = translateOrder({
        leaderNotionalUsd: leaderNotional,
        leaderEquityUsd: leaderEquity,
        leaderSide,
        settings,
        market,
        priceScaled,
      });
      if (translation.kind === 'skip') continue;

      const current = copiedByMarket.get(marketId);

      // Side flip: close the existing copied position first;
      // the new side opens on the next leader update, once
      // the close is reflected in the follower's positions.
      if (current && current.side !== translation.side) {
        await this.submitClose(
          settings,
          session,
          market,
          current,
          priceScaled,
          'leader side flip',
        );
        continue;
      }

      const currentNotional = current
        ? scaledSizeToNotional(
            market,
            BigInt(current.size_scaled),
            priceScaled,
          )
        : 0;
      const delta = translation.notionalUsd - currentNotional;

      // Hysteresis: ignore deltas under $5 or 5%, whichever
      // is larger, so noise does not churn the follower's book.
      if (Math.abs(delta) < Math.max(5, translation.notionalUsd * 0.05)) {
        continue;
      }

      if (delta > 0) {
        if (settings.reduce_only) {
          await this.riskEvent(
            followerId,
            'reduce_only',
            { leaderId: leaderUserId, marketId },
            'reduce-only mode blocks new exposure',
          );
          continue;
        }
        const sizeScaled = notionalToScaledSize(
          market,
          delta,
          priceScaled,
        );
        await this.submitOpen(
          settings,
          session,
          market,
          translation,
          sizeScaled,
          priceScaled,
          leaderUserId,
        );
      } else {
        // Reduce: close |delta| of the copied position.
        const currentSize = BigInt(current?.size_scaled ?? '0');
        const reduceSize = notionalToScaledSize(
          market,
          -delta,
          priceScaled,
        );
        const closeSize =
          reduceSize < currentSize ? reduceSize : currentSize;
        if (closeSize <= 0n) continue;
        await this.submitClosePartial(
          settings,
          session,
          market,
          current!,
          closeSize,
          priceScaled,
          'rebalance reduce',
        );
      }
    }

    // Close copied positions on markets the leader exited.
    for (const [marketId, current] of copiedByMarket) {
      if (!leaderPositions.has(marketId)) {
        const market = marketRegistry.market(marketId);
        if (!market) continue;
        const priceScaled = this.currentPriceScaled(marketId);
        if (priceScaled === undefined || priceScaled <= 0n) continue;
        await this.submitClose(
          settings,
          session,
          market,
          current,
          priceScaled,
          'leader closed market',
        );
      }
    }
  }

  // ---------------------------------------------------------- order flow

  private async submitOpen(
    settings: CopySettings,
    session: import('../perpl/tradingWs.js').TradingSession,
    market: import('../perpl/types.js').MarketConfig,
    translation: Extract<
      ReturnType<typeof translateOrder>,
      { kind: 'order' }
    >,
    sizeScaled: bigint,
    priceScaled: bigint,
    leaderUserId: string,
  ): Promise<void> {
    // Anti-frontrun delay before translating leader action.
    await sleep(settings.copy_delay_ms || COPY_DELAY_MS);

    // Builder fee: charged only on opening/increasing orders,
    // capped by the user's signed enrollment ceiling.
    const builderFeePer100k =
      session.builderId !== undefined &&
      session.builderId > 0
        ? Math.min(
            PERPL_BUILDER_FEE_PER_100K,
            session.maxBuilderFeePer100k,
          )
        : 0;

    if (DRY_RUN) {
      const requestId = nextDryRq();
      await this.copyOrderRow({
        user_id: settings.user_id,
        leader_id: leaderUserId,
        market_id: market.id,
        order_type: translation.type,
        size_scaled: sizeScaled.toString(),
        price_scaled: '0',
        leverage_hundredths: translation.leverageHundredths,
        notional_usd: translation.notionalUsd,
        request_id: String(requestId),
        status: 'submitted',
        builder_fee_per_100k: builderFeePer100k,
        dry_run: true,
      });
      logger.warn(
        `[dry-run] would open: user=${settings.user_id} leader=${leaderUserId} ` +
          `mkt=${market.id} type=${translation.type} size=${sizeScaled} ` +
          `notional=${translation.notionalUsd.toFixed(2)}`,
      );
      return;
    }

    let ack;
    try {
      ack = await session.placeOrder({
        marketId: market.id,
        type: translation.type,
        sizeScaled,
        priceScaled: 0n, // market order (IOC)
        leverageHundredths: translation.leverageHundredths,
        maxSlippageBps: settings.slippage_bps,
        builderFeePer100k: builderFeePer100k || undefined,
      });
    } catch (error) {
      await this.copyOrderRow({
        user_id: settings.user_id,
        leader_id: leaderUserId,
        market_id: market.id,
        order_type: translation.type,
        size_scaled: sizeScaled.toString(),
        price_scaled: '0',
        leverage_hundredths: translation.leverageHundredths,
        notional_usd: translation.notionalUsd,
        request_id: undefined,
        status: 'failed',
        builder_fee_per_100k: builderFeePer100k,
        error: String(error),
      });
      throw error;
    }

    await this.copyOrderRow({
      user_id: settings.user_id,
      leader_id: leaderUserId,
      market_id: market.id,
      order_type: translation.type,
      size_scaled: sizeScaled.toString(),
      price_scaled: '0',
      leverage_hundredths: translation.leverageHundredths,
      notional_usd: translation.notionalUsd,
      request_id: String(ack.requestId),
      perpl_order_id: ack.perplOrderId?.toString() ?? null,
      status: 'submitted',
      builder_fee_per_100k: builderFeePer100k,
    });

    logger.info(
      `copy order: user=${settings.user_id} leader=${leaderUserId} mkt=${market.id} ` +
        `type=${translation.type} size=${sizeScaled} notional=${translation.notionalUsd.toFixed(2)}`,
    );
  }

  private async submitClose(
    settings: CopySettings,
    session: import('../perpl/tradingWs.js').TradingSession,
    market: import('../perpl/types.js').MarketConfig,
    position: PositionRow,
    priceScaled: bigint,
    reason: string,
  ): Promise<void> {
    const sizeScaled = BigInt(position.size_scaled);
    if (sizeScaled <= 0n) return;
    await this.submitClosePartial(
      settings,
      session,
      market,
      position,
      sizeScaled,
      priceScaled,
      reason,
    );
  }

  private async submitClosePartial(
    settings: CopySettings,
    session: import('../perpl/tradingWs.js').TradingSession,
    market: import('../perpl/types.js').MarketConfig,
    position: PositionRow,
    sizeScaled: bigint,
    priceScaled: bigint,
    reason: string,
  ): Promise<void> {
    await sleep(settings.copy_delay_ms || COPY_DELAY_MS);

    const type = position.side === 1 ? 3 : 4; // CloseLong / CloseShort
    const leaderId = position.leader_id!;

    if (DRY_RUN) {
      await this.copyOrderRow({
        user_id: settings.user_id,
        leader_id: leaderId,
        market_id: market.id,
        order_type: type,
        size_scaled: sizeScaled.toString(),
        price_scaled: priceScaled.toString(),
        leverage_hundredths: 0,
        notional_usd: scaledSizeToNotional(market, sizeScaled, priceScaled),
        request_id: String(nextDryRq()),
        status: 'submitted',
        dry_run: true,
      });
      logger.warn(
        `[dry-run] would close: user=${settings.user_id} mkt=${market.id} ` +
          `size=${sizeScaled} reason=${reason}`,
      );
      return;
    }

    let ack;
    try {
      ack = await session.placeOrder({
        marketId: market.id,
        type,
        sizeScaled,
        positionId: position.perpl_position_id
          ? Number(position.perpl_position_id)
          : undefined,
        maxSlippageBps: settings.slippage_bps,
      });
    } catch (error) {
      await this.copyOrderRow({
        user_id: settings.user_id,
        leader_id: leaderId,
        market_id: market.id,
        order_type: type,
        size_scaled: sizeScaled.toString(),
        price_scaled: priceScaled.toString(),
        leverage_hundredths: 0,
        notional_usd: scaledSizeToNotional(market, sizeScaled, priceScaled),
        request_id: undefined,
        status: 'failed',
        error: String(error),
      });
      throw error;
    }

    await this.copyOrderRow({
      user_id: settings.user_id,
      leader_id: leaderId,
      market_id: market.id,
      order_type: type,
      size_scaled: sizeScaled.toString(),
      price_scaled: priceScaled.toString(),
      leverage_hundredths: 0,
      notional_usd: scaledSizeToNotional(market, sizeScaled, priceScaled),
      request_id: String(ack.requestId),
      perpl_order_id: ack.perplOrderId?.toString() ?? null,
      status: 'submitted',
    });

    logger.info(
      `copy close: user=${settings.user_id} mkt=${market.id} ` +
        `size=${sizeScaled} reason=${reason}`,
    );
  }

  private async copyOrderRow(row: {
    user_id: string;
    leader_id: string;
    market_id: number;
    order_type: number;
    size_scaled: string;
    price_scaled: string;
    leverage_hundredths: number;
    notional_usd: number;
    request_id: string | null | undefined;
    perpl_order_id?: string | null;
    status: string;
    builder_fee_per_100k?: number;
    status_reason?: number | null;
    error?: string | null;
    dry_run?: boolean;
  }): Promise<void> {
    await pool.query(
      `insert into copy_orders
         (user_id, leader_id, market_id, order_type, size_scaled,
          price_scaled, leverage_hundredths, notional_usd, request_id,
          perpl_order_id, status, builder_fee_per_100k, status_reason,
          error, dry_run)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        row.user_id,
        row.leader_id,
        row.market_id,
        row.order_type,
        row.size_scaled,
        row.price_scaled,
        row.leverage_hundredths,
        row.notional_usd,
        row.request_id ?? null,
        row.perpl_order_id ?? null,
        row.status,
        row.builder_fee_per_100k ?? 0,
        row.status_reason ?? null,
        row.error ?? null,
        row.dry_run ?? false,
      ],
    );
  }

  // ---------------------------------------------------------- follower side

  /** A fill on a follower's account; correlates back to the copy order. */
  async onFollowerFill(
    userId: string,
    fill: import('../perpl/types.js').Fill,
    requestId?: number,
  ): Promise<void> {
    if (requestId === undefined) return;

    // Accumulate the fill into the copy order: partial fills move
    // open -> partial, and the row becomes filled once the filled
    // size covers the ordered size. Rows already filled/canceled/
    // failed are untouched, so a duplicate fill event cannot
    // double-count (at-most-once per rq, enforced in SQL).
    const { rows } = await pool.query<CopyOrderRow>(
      `update copy_orders
          set perpl_order_id = coalesce($1::bigint, perpl_order_id),
              filled_size_scaled = filled_size_scaled + $2::bigint,
              status = case
                         when filled_size_scaled + $2::bigint >= size_scaled
                           then 'filled'
                         else 'partial'
                       end
        where request_id = $3::bigint and user_id = $4
          and status in ('submitted', 'open', 'partial')
        returning *`,
      [String(fill.oid), String(fill.s), String(requestId), userId],
    );
    const copyOrder = rows[0];
    if (copyOrder) {
      // Realized PnL on a closing fill of a copied position.
      if (copyOrder.order_type === 3 || copyOrder.order_type === 4) {
        await this.recordRealizedPnl(copyOrder, fill);
      }

      await notify(userId, 'fill', {
        marketId: fill.mkt,
        orderType: fill.t,
        size: fill.s,
        status: copyOrder.status,
        requestId,
      });
      return;
    }

    // Otherwise the fill belongs to a manual ticket (same rq
    // correlation, result column instead of perpl_order_id).
    // Manual closes skip the PnL ledger in v1 (no leader
    // attribution); equity snapshots still reflect the value.
    const { rows: manualRows } = await pool.query<ManualOrderRow>(
      `update manual_orders
          set result_order_id = coalesce($1::bigint, result_order_id),
              filled_size_scaled = filled_size_scaled + $2::bigint,
              status = case
                         when filled_size_scaled + $2::bigint >= size_scaled
                           then 'filled'
                         else 'partial'
                       end
        where request_id = $3::bigint and user_id = $4
          and status in ('submitted', 'open', 'partial')
        returning *`,
      [String(fill.oid), String(fill.s), String(requestId), userId],
    );
    const manual = manualRows[0];
    if (!manual) return;

    await notify(userId, 'manual_fill', {
      marketId: fill.mkt,
      orderType: fill.t,
      size: fill.s,
      status: manual.status,
      intentId: manual.id,
      requestId,
    });
  }

  private async recordRealizedPnl(
    copyOrder: CopyOrderRow,
    fill: import('../perpl/types.js').Fill,
  ): Promise<void> {
    const market = marketRegistry.market(copyOrder.market_id);
    if (!market || fill.p === undefined) return;

    const { rows } = await pool.query<PositionRow>(
      `select * from positions where user_id = $1 and market_id = $2 and leader_id = $3`,
      [copyOrder.user_id, copyOrder.market_id, copyOrder.leader_id],
    );
    const position = rows[0];
    if (!position || !position.entry_price_scaled) return;

    const entryPrice = BigInt(position.entry_price_scaled);
    const fillPrice = BigInt(fill.p);
    // Realize only this fill event's own share, so partial
    // fills of one close each record their slice exactly once.
    const fillSize = BigInt(fill.s ?? 0);
    const positionSize = BigInt(position.size_scaled);
    const size =
      fillSize > 0n && fillSize < positionSize ? fillSize : positionSize;
    const isLong = position.side === 1;

    const pnl =
      (Number(size) *
        (Number(fillPrice) - Number(entryPrice))) /
      (10 ** market.size_decimals * 10 ** market.price_decimals);
    const realized = isLong ? pnl : -pnl;

    await pool.query(
      `insert into copy_pnl_events
         (user_id, leader_id, market_id, realized_usd)
       values ($1, $2, $3, $4)`,
      [copyOrder.user_id, copyOrder.leader_id, copyOrder.market_id, realized],
    );
  }

  /** Mirrors a follower's position snapshot into Postgres. */
  async onFollowerPositions(
    userId: string,
    positions: Position[],
  ): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('begin');
      for (const position of positions) {
        const size = BigInt(position.s ?? 0);
        if (size <= 0n) {
          await client.query(
            `delete from positions where user_id = $1 and market_id = $2`,
            [userId, position.mkt],
          );
          continue;
        }
        const leaderId = await this.attributeLeader(
          userId,
          position.mkt,
          client,
        );
        await client.query(
          `insert into positions
             (user_id, market_id, perpl_position_id, side, size_scaled,
              entry_price_scaled, leverage_hundredths, leader_id)
           values ($1,$2,$3,$4,$5,$6,$7,$8)
           on conflict (user_id, market_id) do update set
             perpl_position_id = excluded.perpl_position_id,
             side = excluded.side,
             size_scaled = excluded.size_scaled,
             entry_price_scaled = excluded.entry_price_scaled,
             leverage_hundredths = excluded.leverage_hundredths,
             leader_id = excluded.leader_id,
             updated_at = now()`,
          [
            userId,
            position.mkt,
            String(position.id),
            position.t ?? 1,
            size.toString(),
            String(position.p ?? 0),
            position.lv ?? 0,
            leaderId,
          ],
        );
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      logger.error(`position mirror failed for ${userId}`, error);
    } finally {
      client.release();
    }
  }

  /**
   * Attributes a follower position to a leader when exactly
   * one of the follower's active copy targets holds that
   * market. With multiple leaders on one market (a future
   * multi-trader feature) the first match wins — document
   * that limitation; v1 is single-leader per market.
   */
  private async attributeLeader(
    userId: string,
    marketId: number,
    client?: PoolClient,
  ): Promise<string | null> {
    const db = client ?? pool;
    const { rows } = await db.query<{ leader_id: string }>(
      `select leader_id from copy_settings
        where user_id = $1 and enabled and kill_switch_requested_at is null`,
      [userId],
    );
    for (const { leader_id } of rows) {
      const leaderPos = this.leaderPositions.get(leader_id)?.get(marketId);
      if (leaderPos) return leader_id;
    }
    return null;
  }

  // ---------------------------------------------------------- loops

  /** Consumes kill-switch requests (~1s cadence from the worker). */
  async consumeKillSwitches(): Promise<void> {
    const { rows } = await pool.query<{ user_id: string }>(
      `select distinct user_id from copy_settings
        where kill_switch_requested_at is not null`,
    );
    for (const { user_id } of rows) {
      try {
        await this.executeKillSwitch(user_id);
      } catch (error) {
        logger.error(`kill switch failed for ${user_id}`, error);
      }
    }
  }

  /**
   * Consumes manual order intents (~1s cadence). Each intent is
   * claimed with an atomic status-gated UPDATE, so even concurrent
   * workers never execute one twice; the session's strictly-
   * increasing rq is the second backstop. A claimed row carries
   * error='__executing__' until completion clears it; a crashed
   * worker's claimed rows age into the reconciler, which resolves
   * or fails them via REST order-history.
   */
  async consumeOrderIntents(): Promise<void> {
    const CLAIM = '__executing__';
    const { rows: candidates } = await pool.query<{ id: string }>(
      `select id from manual_orders
        where status = 'pending'
        order by created_at
        limit 25`,
    );

    for (const { id } of candidates) {
      const { rows: claimed } = await pool.query<ManualOrderRow>(
        `update manual_orders
            set status = 'submitted', error = $2
          where id = $1 and status = 'pending'
          returning *`,
        [id, CLAIM],
      );
      if (claimed.length === 0) continue; // claimed or settled elsewhere
      try {
        await this.executeManualIntent(claimed[0], CLAIM);
      } catch (error) {
        logger.error(`manual intent ${id} failed`, error);
        await pool.query(
          `update manual_orders
              set status = 'failed', error = $2
            where id = $1 and error = $3`,
          [id, String(error), CLAIM],
        );
      }
    }
  }

  private async executeManualIntent(
    intent: ManualOrderRow,
    claim: string,
  ): Promise<void> {
    const session = this.sessions.sessionFor(intent.user_id);
    if (!session?.ready) {
      // Release the claim; retry on the next pass.
      await pool.query(
        `update manual_orders
            set status = 'pending', error = null
          where id = $1 and error = $2`,
        [intent.id, claim],
      );
      return;
    }

    const market = marketRegistry.market(intent.market_id);
    if (!market) {
      await pool.query(
        `update manual_orders set status = 'failed', error = 'unknown market'
          where id = $1 and error = $2`,
        [intent.id, claim],
      );
      return;
    }

    // Closes link the live mirrored position (fresher than intent time).
    let positionId: number | null = null;
    if (intent.order_type === 3 || intent.order_type === 4) {
      const { rows } = await pool.query<{ perpl_position_id: string | null }>(
        `select perpl_position_id from positions
          where user_id = $1 and market_id = $2`,
        [intent.user_id, intent.market_id],
      );
      if (rows.length === 0) {
        await pool.query(
          `update manual_orders
              set status = 'failed', error = 'position already closed'
            where id = $1 and error = $2`,
          [intent.id, claim],
        );
        return;
      }
      positionId =
        rows[0].perpl_position_id !== null
          ? Number(rows[0].perpl_position_id)
          : null;
    }

    const sizeScaled = BigInt(intent.size_scaled);
    const priceScaled = BigInt(intent.price_scaled);
    const spec = {
      marketId: intent.market_id,
      type: intent.order_type,
      sizeScaled,
      ...(priceScaled > 0n ? { priceScaled } : {}),
      ...(intent.order_type === 5 && intent.perpl_order_id !== null
        ? { orderId: Number(intent.perpl_order_id) }
        : {}),
      ...(positionId !== null ? { positionId } : {}),
      // Leverage only applies to opens; closes/cancels send none.
      ...(intent.order_type === 1 || intent.order_type === 2
        ? { leverageHundredths: Number(intent.leverage_hundredths) }
        : {}),
      maxSlippageBps: intent.slippage_bps,
      ...(session.builderId !== undefined && session.builderId > 0
        ? {
            builderFeePer100k: Math.min(
              PERPL_BUILDER_FEE_PER_100K,
              session.maxBuilderFeePer100k,
            ),
          }
        : {}),
    };

    if (DRY_RUN || intent.dry_run) {
      await pool.query(
        `update manual_orders
            set dry_run = true, error = null
          where id = $1 and error = $2`,
        [intent.id, claim],
      );
      logger.warn(
        `[dry-run] would submit manual intent ${intent.id}: ` +
          `user=${intent.user_id} mkt=${intent.market_id} ` +
          `type=${intent.order_type} size=${sizeScaled}`,
      );
      await notify(intent.user_id, 'manual_fill', {
        intentId: intent.id,
        dryRun: true,
        status: 'submitted',
      });
      return;
    }

    try {
      const ack = await session.placeOrder(spec);
      await pool.query(
        `update manual_orders
            set request_id = $2::bigint,
                result_order_id = $3::bigint,
                builder_fee_per_100k = $4,
                error = null
          where id = $1 and error = $5`,
        [
          intent.id,
          String(ack.requestId),
          ack.perplOrderId !== undefined ? String(ack.perplOrderId) : null,
          spec.builderFeePer100k ?? 0,
          claim,
        ],
      );
      logger.info(
        `manual order submitted: intent=${intent.id} rq=${ack.requestId}`,
      );
    } catch (error) {
      await pool.query(
        `update manual_orders
            set status = 'failed', error = $2
          where id = $1 and error = $3`,
        [intent.id, String(error), claim],
      );
      throw error;
    }
  }

  private async executeKillSwitch(userId: string): Promise<void> {
    const { rows } = await pool.query<PositionRow>(
      `select * from positions where user_id = $1 and leader_id is not null`,
      [userId],
    );

    const session = this.sessions.sessionFor(userId);
    if (DRY_RUN) {
      logger.warn(
        `[dry-run] kill switch for ${userId}: would close ${rows.length} copied positions`,
      );
    } else if (session?.ready && rows.length > 0) {
      await session.closeAllPositions(
        rows.map((p) => ({
          id: Number(p.perpl_position_id ?? 0),
          mkt: p.market_id,
          t: p.side,
          s: Number(p.size_scaled),
        })),
        500, // tight slippage cap on emergency closes
      );
    }

    await pool.query(
      `update copy_settings
          set enabled = false,
              paused_reason = 'kill_switch',
              kill_switch_requested_at = null,
              updated_at = now()
        where user_id = $1`,
      [userId],
    );
    await this.riskEvent(userId, 'kill_switch', {}, 'Kill switch engaged');
    await notify(userId, 'kill_switch', {
      positionsClosed: rows.length,
    });
    logger.warn(`kill switch executed for ${userId}`);
  }

  /** Stop-loss, daily-loss, and drawdown monitoring. */
  async monitorOnce(): Promise<void> {
    const { rows } = await pool.query<
      PositionRow & {
        stop_loss_bps: number;
        daily_loss_limit_usd: number;
        weekly_drawdown_limit_bps: number;
      }
    >(
      `select p.*, s.stop_loss_bps, s.daily_loss_limit_usd,
              s.weekly_drawdown_limit_bps
         from positions p
         join copy_settings s
           on s.user_id = p.user_id and s.leader_id = p.leader_id
        where p.leader_id is not null and s.enabled`,
    );

    // Stop-loss per copied position.
    for (const row of rows) {
      const market = marketRegistry.market(row.market_id);
      if (!market) continue;
      const priceScaled = this.currentPriceScaled(row.market_id);
      if (priceScaled === undefined || priceScaled <= 0n) continue;

      if (
        stopLossBreached(
          row.side as 1 | 2,
          BigInt(row.entry_price_scaled),
          priceScaled,
          row.stop_loss_bps,
        )
      ) {
        const settings = await this.settingsFor(
          row.user_id,
          row.leader_id!,
        );
        if (!settings) continue;
        const session = this.sessions.sessionFor(row.user_id);
        if (!session?.ready) continue;
        try {
          await this.submitClose(
            settings,
            session,
            market,
            row,
            priceScaled,
            'stop loss',
          );
          await this.riskEvent(
            row.user_id,
            'stop_loss',
            {
              leaderId: row.leader_id,
              marketId: row.market_id,
              entryPrice: fromScaledPrice(
                market,
                BigInt(row.entry_price_scaled),
              ),
              exitPrice: fromScaledPrice(market, priceScaled),
            },
            `Stop loss hit on market ${row.market_id}`,
          );
          await notify(row.user_id, 'stop_loss', {
            marketId: row.market_id,
          });
        } catch (error) {
          logger.error('stop-loss close failed', error);
        }
      }
    }

    // Daily loss + weekly drawdown per follower.
    const userIds = [...new Set(rows.map((r) => r.user_id))];
    for (const userId of userIds) {
      const daily = await this.dailyLoss(userId);
      if (daily.breached) {
        await this.pauseAll(userId, 'daily_loss_limit', daily.detail);
        continue;
      }
      const weekly = await this.weeklyDrawdown(userId);
      if (weekly.breached) {
        await this.pauseAll(userId, 'weekly_drawdown_limit', weekly.detail);
      }
    }
  }

  /**
   * Finalizes copy and manual orders stuck short of a terminal
   * state via REST order-history. Maps the full Perpl status set
   * (open / partially-filled included), never regresses a
   * terminal row, and skips dry-run rows (simulated orders
   * have no on-chain counterpart to reconcile against).
   */
  async reconcileOnce(): Promise<void> {
    const { rows: copies } = await pool.query<CopyOrderRow>(
      `select * from copy_orders
        where status in ('submitted', 'open', 'partial')
          and dry_run = false
          and created_at < now() - interval '2 minutes'
        order by created_at
        limit 100`,
    );
    for (const order of copies) {
      await this.reconcileRow('copy_orders', order);
    }
    const { rows: manuals } = await pool.query<ManualOrderRow>(
      `select * from manual_orders
        where status in ('submitted', 'open', 'partial')
          and dry_run = false
          and created_at < now() - interval '2 minutes'
        order by created_at
        limit 100`,
    );
    for (const order of manuals) {
      await this.reconcileRow('manual_orders', order);
    }
  }

  /** Terminal states win; anything else only advances, never backward. */
  private mapOrderStatus(
    matchSt: number | undefined,
    fallback: string,
  ): string {
    return matchSt === 4
      ? 'filled'
      : matchSt === 5 || matchSt === 6
        ? 'canceled'
        : matchSt === 7
          ? 'failed'
          : matchSt === 2
            ? 'open'
            : matchSt === 3
              ? 'partial'
              : fallback;
  }

  private async reconcileRow(
    table: 'copy_orders' | 'manual_orders',
    order: CopyOrderRow | ManualOrderRow,
  ): Promise<void> {
    try {
      const rest = this.sessions.restFor(order.user_id);
      if (!rest) return;
      const page = await rest.orderHistory(100);
      const match = page.d.find(
        (o) => o.rq !== undefined && String(o.rq) === order.request_id,
      );
      if (match) {
        const status = this.mapOrderStatus(match.st, order.status);
        if (status === order.status) return;
        // Explicit per-table SQL (no interpolated identifiers).
        if (table === 'copy_orders') {
          await pool.query(
            `update copy_orders
                set status = $1, perpl_order_id = $2::bigint,
                    status_reason = $3::int
              where id = $4
                and status in ('submitted', 'open', 'partial')`,
            [status, String(match.id), match.sr ?? null, order.id],
          );
        } else {
          await pool.query(
            `update manual_orders
                set status = $1, result_order_id = $2::bigint,
                    status_reason = $3::int
              where id = $4
                and status in ('submitted', 'open', 'partial')`,
            [status, String(match.id), match.sr ?? null, order.id],
          );
        }
      } else if (
        new Date(order.created_at).getTime() < Date.now() - 10 * 60_000
      ) {
        if (table === 'copy_orders') {
          await pool.query(
            `update copy_orders set status = 'failed', error = 'no status received within 10 minutes' where id = $1`,
            [order.id],
          );
        } else {
          await pool.query(
            `update manual_orders set status = 'failed', error = 'no status received within 10 minutes' where id = $1`,
            [order.id],
          );
        }
      }
    } catch (error) {
      logger.error('reconcile failed', error);
    }
  }

  // ---------------------------------------------------------- helpers

  private currentPriceScaled(marketId: number): bigint | undefined {
    const state = this.marketData.stateFor(marketId);
    const price = state?.lst ?? state?.mrk ?? state?.mid ?? undefined;
    if (price === undefined) return undefined;
    return BigInt(Math.round(price));
  }

  private async settingsFor(
    userId: string,
    leaderId: string,
  ): Promise<CopySettings | undefined> {
    const { rows } = await pool.query<CopySettings>(
      `select * from copy_settings where user_id = $1 and leader_id = $2`,
      [userId, leaderId],
    );
    return rows[0];
  }

  /** Realized (today) + unrealized loss on copied positions, USD. */
  private async dailyLoss(userId: string): Promise<{
    loss: number;
    breached: boolean;
    detail: string;
  }> {
    const { rows } = await pool.query<{ limit: number }>(
      `select least(daily_loss_limit_usd) as limit
         from copy_settings where user_id = $1 and enabled`,
      [userId],
    );
    const limit = rows[0]?.limit ?? Infinity;
    if (limit === Infinity) return { loss: 0, breached: false, detail: '' };

    const { rows: realizedRows } = await pool.query<{
      realized: string;
    }>(
      `select coalesce(sum(realized_usd), 0) as realized
         from copy_pnl_events
        where user_id = $1 and created_at >= date_trunc('day', now())`,
      [userId],
    );
    const realized = Number(realizedRows[0]?.realized ?? '0');

    let unrealized = 0;
    const { rows: positions } = await pool.query<PositionRow>(
      `select * from positions where user_id = $1 and leader_id is not null`,
      [userId],
    );
    for (const position of positions) {
      const market = marketRegistry.market(position.market_id);
      const priceScaled = this.currentPriceScaled(position.market_id);
      if (!market || priceScaled === undefined || priceScaled <= 0n) continue;
      unrealized += unrealizedPnl(
        market,
        position.side as 1 | 2,
        BigInt(position.size_scaled),
        BigInt(position.entry_price_scaled),
        priceScaled,
      );
    }

    const loss = -(realized + unrealized);
    const breached = loss > limit;
    return {
      loss,
      breached,
      detail: `daily loss ${loss.toFixed(2)} USD (realized ${realized.toFixed(2)}, unrealized ${unrealized.toFixed(2)}) vs limit ${limit} USD`,
    };
  }

  private async weeklyDrawdown(userId: string): Promise<{
    bps: number;
    breached: boolean;
    detail: string;
  }> {
    const { rows } = await pool.query<{ limit: number }>(
      `select least(weekly_drawdown_limit_bps) as limit
         from copy_settings where user_id = $1 and enabled`,
      [userId],
    );
    const limitBps = rows[0]?.limit ?? Infinity;
    if (limitBps === Infinity) return { bps: 0, breached: false, detail: '' };

    const { rows: curve } = await pool.query<{ equity: number }>(
      `select equity from equity_snapshots
        where user_id = $1 and at >= now() - interval '7 days'
        order by at`,
      [userId],
    );
    const equities = curve.map((r) => r.equity);
    // Include the live balance so the current state counts.
    const live = this.sessions.equityOf(userId);
    if (live !== undefined) equities.push(live);

    const bps = maxDrawdownBpsFromRisk(equities);
    const breached = bps >= limitBps;
    return {
      bps,
      breached,
      detail: `7-day drawdown ${(bps / 100).toFixed(2)}% vs limit ${(limitBps / 100).toFixed(2)}%`,
    };
  }

  private async pause(
    settings: CopySettings,
    type: string,
    detail: string,
  ): Promise<void> {
    await pool.query(
      `update copy_settings
          set enabled = false, paused_reason = $1, updated_at = now()
        where user_id = $2 and leader_id = $3 and enabled`,
      [type, settings.user_id, settings.leader_id],
    );
    await this.riskEvent(settings.user_id, type, { leaderId: settings.leader_id }, detail);
    await notify(settings.user_id, 'copy_paused', {
      leaderId: settings.leader_id,
      reason: type,
      detail,
    });
    logger.warn(`copy paused: ${settings.user_id} <- ${settings.leader_id}: ${detail}`);
  }

  private async pauseAll(
    userId: string,
    type: string,
    detail: string,
  ): Promise<void> {
    await pool.query(
      `update copy_settings
          set enabled = false, paused_reason = $1, updated_at = now()
        where user_id = $2 and enabled`,
      [type, userId],
    );
    await this.riskEvent(userId, type, {}, detail);
    await notify(userId, 'copy_paused', { reason: type, detail });
    logger.warn(`copy paused for all leaders: ${userId}: ${detail}`);
  }

  private async riskEvent(
    userId: string,
    type: string,
    detail: Record<string, unknown>,
    message: string,
  ): Promise<void> {
    await pool.query(
      `insert into risk_events (user_id, type, detail) values ($1, $2, $3)`,
      [userId, type, JSON.stringify({ ...detail, message })],
    );
  }
}

export type { PositionRow };
