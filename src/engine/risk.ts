// Pure risk-translation functions.
//
// Copy-trading is risk translation, not blind order mirroring:
// the leader's position is expressed as a fraction of their
// equity, then re-scaled onto the follower's allocation and
// clamped by every guardrail before an order is placed.

import type { MarketConfig } from '../perpl/types.js';
import {
  fromScaledPrice,
  fromScaledSize,
  leverageToHundredths,
  notionalToScaledSize,
} from '../perpl/scaling.js';
import type { CopySettings } from './types.js';

export type TranslationResult =
  | { kind: 'skip'; reason: string }
  | {
      kind: 'order';
      /** Perpl OrderType: 1 OpenLong, 2 OpenShort, 3 CloseLong, 4 CloseShort. */
      type: 1 | 2 | 3 | 4;
      /** PositionType side: 1 long, 2 short. */
      side: 1 | 2;
      sizeScaled: bigint;
      notionalUsd: number;
      leverageHundredths: number;
    };

export interface TranslationInput {
  /** Absolute notional of the leader's position, USD. */
  leaderNotionalUsd: number;
  /** Leader's account equity, USD. */
  leaderEquityUsd: number;
  /** Leader's position side. */
  leaderSide: 1 | 2;
  settings: CopySettings;
  market: MarketConfig;
  priceScaled: bigint;
}

/**
 * Translates a leader position into a follower order.
 *
 *   fraction       = leaderNotional / leaderEquity
 *   targetNotional = allocation * fraction
 *   leverage       = min(impliedLeverage, settings.maxLeverage)
 *   targetNotional = min(targetNotional, allocation * leverage,
 *                        settings.maxNotionalPerTrade)
 */
export function translateOrder(
  input: TranslationInput,
): TranslationResult {
  const { settings, market } = input;

  // Market allowlist / blacklist.
  const allowed = checkMarketAllowed(settings, market.id);
  if (!allowed.allowed) {
    return { kind: 'skip', reason: allowed.reason ?? 'market not allowed' };
  }

  const fraction =
    input.leaderEquityUsd > 0
      ? input.leaderNotionalUsd / input.leaderEquityUsd
      : 0;
  if (fraction <= 0) return { kind: 'skip', reason: 'leader position has no notional' };

  // Implied leverage is the leader's notional/equity fraction;
  // the follower inherits it, clamped by their own max leverage.
  const impliedLeverage = fraction;
  const leverage = Math.min(
    Math.max(impliedLeverage, 0.01),
    settings.max_leverage,
  );

  let targetNotional = settings.allocation_usd * fraction;
  targetNotional = Math.min(
    targetNotional,
    settings.allocation_usd * leverage,
    settings.max_notional_per_trade_usd,
  );

  const sizeScaled = notionalToScaledSize(
    market,
    targetNotional,
    input.priceScaled,
  );

  // Minimum order size: skip (v1) rather than aggregate.
  const minSizeUsd =
    market.min_size !== undefined
      ? fromScaledSize(market, BigInt(Math.round(market.min_size))) *
        fromScaledPrice(market, input.priceScaled)
      : 0;
  if (sizeScaled <= 0n || targetNotional < minSizeUsd) {
    return {
      kind: 'skip',
      reason: `below market minimum (${targetNotional.toFixed(2)} < ${minSizeUsd.toFixed(2)} USD)`,
    };
  }

  return {
    kind: 'order',
    type: input.leaderSide === 1 ? 1 : 2, // OpenLong / OpenShort
    side: input.leaderSide,
    sizeScaled,
    notionalUsd: targetNotional,
    leverageHundredths: leverageToHundredths(leverage),
  };
}

/** Guardrail: market allowlist (empty = all allowed) and blacklist. */
export function checkMarketAllowed(
  settings: CopySettings,
  marketId: number,
): { allowed: boolean; reason?: string } {
  if (
    settings.market_allowlist.length > 0 &&
    !settings.market_allowlist.includes(marketId)
  ) {
    return { allowed: false, reason: 'market not in allowlist' };
  }
  if (settings.market_blacklist.includes(marketId)) {
    return { allowed: false, reason: 'market is blacklisted' };
  }
  return { allowed: true };
}

/**
 * Stop-loss check: true when the position's adverse move
 * from entry exceeds the configured stop-loss (bps).
 */
export function stopLossBreached(
  side: 1 | 2,
  entryPriceScaled: bigint,
  currentPriceScaled: bigint,
  stopLossBps: number,
): boolean {
  if (entryPriceScaled <= 0n || currentPriceScaled <= 0n) return false;
  const entry = Number(entryPriceScaled);
  const current = Number(currentPriceScaled);
  const adverse =
    side === 1
      ? (entry - current) / entry // long loses when price falls
      : (current - entry) / entry; // short loses when price rises
  return adverse * 10_000 >= stopLossBps;
}

/** Unrealized PnL (USD) of a position at a given price. */
export function unrealizedPnl(
  market: MarketConfig,
  side: 1 | 2,
  sizeScaled: bigint,
  entryPriceScaled: bigint,
  currentPriceScaled: bigint,
): number {
  const entryNotional =
    (Number(sizeScaled) * Number(entryPriceScaled)) /
    (10 ** market.size_decimals * 10 ** market.price_decimals);
  const currentNotional =
    (Number(sizeScaled) * Number(currentPriceScaled)) /
    (10 ** market.size_decimals * 10 ** market.price_decimals);
  const delta = currentNotional - entryNotional;
  return side === 1 ? delta : -delta;
}

/**
 * Weekly drawdown from an equity curve: the largest peak-to-
 * trough decline, in bps.
 */
export function maxDrawdownBps(equities: number[]): number {
  let peak = -Infinity;
  let maxBps = 0;
  for (const equity of equities) {
    if (equity > peak) peak = equity;
    if (peak > 0) {
      const bps = ((peak - equity) / peak) * 10_000;
      if (bps > maxBps) maxBps = bps;
    }
  }
  return maxBps;
}
