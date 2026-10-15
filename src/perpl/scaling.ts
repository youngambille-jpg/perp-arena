// Scaling helpers. Perpl transmits prices, sizes, and leverage as
// scaled integers; convert at the client boundary so the rest of the
// code works in human units.

import { COLLATERAL_DECIMALS } from '../config.js';
import type { MarketConfig } from './types.js';

export const priceScale = (market: Pick<MarketConfig, 'price_decimals'>) =>
  10 ** market.price_decimals;

export const sizeScale = (market: Pick<MarketConfig, 'size_decimals'>) =>
  10 ** market.size_decimals;

export const toScaledPrice = (
  market: Pick<MarketConfig, 'price_decimals'>,
  price: number,
): bigint => BigInt(Math.round(price * priceScale(market)));

export const fromScaledPrice = (
  market: Pick<MarketConfig, 'price_decimals'>,
  scaled: bigint | number,
): number => Number(scaled) / priceScale(market);

export const toScaledSize = (
  market: Pick<MarketConfig, 'size_decimals'>,
  size: number,
): bigint => BigInt(Math.round(size * sizeScale(market)));

export const fromScaledSize = (
  market: Pick<MarketConfig, 'size_decimals'>,
  scaled: bigint | number,
): number => Number(scaled) / sizeScale(market);

// Leverage is stored in hundredths: 1000 = 10x.
export const leverageToHundredths = (leverage: number): number =>
  Math.round(leverage * 100);
export const hundredthsToLeverage = (hundredths: number): number =>
  hundredths / 100;

// Collateral settles in a 6-decimal token.
export const rawToUsd = (raw: bigint | string): number =>
  Number(raw) / 10 ** COLLATERAL_DECIMALS;
export const usdToRaw = (usd: number): bigint =>
  BigInt(Math.round(usd * 10 ** COLLATERAL_DECIMALS));

/**
 * Notional (USD) -> scaled size, given a scaled price.
 * size = notional / price, computed in scaled units to avoid
 * intermediate float error:
 *   size_scaled = notional * price_scale / price_scaled / size_scale...
 * We compute with rationals in bigint where practical.
 */
export function notionalToScaledSize(
  market: MarketConfig,
  notionalUsd: number,
  priceScaled: bigint,
): bigint {
  const pScale = priceScale(market);
  const sScale = sizeScale(market);
  // notional_usd * pScale = notional in price-scaled units.
  // size_scaled = notional_price_scaled / price_scaled * sScale... but
  // price already carries pScale, so:
  // size_human = notional / (priceScaled / pScale)
  // size_scaled = size_human * sScale
  //            = notional * pScale * sScale / priceScaled
  const numerator = BigInt(Math.round(notionalUsd)) * BigInt(pScale) * BigInt(sScale);
  if (priceScaled <= 0n) return 0n;
  return numerator / priceScaled;
}

export function scaledSizeToNotional(
  market: MarketConfig,
  sizeScaled: bigint,
  priceScaled: bigint,
): number {
  const pScale = priceScale(market);
  const sScale = sizeScale(market);
  // notional = sizeScaled / sScale * priceScaled / pScale
  return (
    (Number(sizeScaled) * Number(priceScaled)) / (sScale * pScale)
  );
}
