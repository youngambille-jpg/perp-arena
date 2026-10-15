// Market configuration cache. GET /v1/pub/context is public and
// authoritative — market ids and scaling decimals are read here at
// startup and refreshed periodically, never hard-coded.

import { logger } from '../lib/logger.js';
import { pool } from '../lib/db.js';
import { PERPL_API_URL } from '../config.js';
import type { Context, MarketConfig, RawMarketConfig } from './types.js';

/**
 * Normalizes one raw context market into the flat internal
 * shape. Scaling and margin fields live under `config` on the
 * wire. A market without usable decimals is skipped — it
 * cannot be priced, sized, or traded.
 */
function normalizeMarket(raw: RawMarketConfig): MarketConfig | undefined {
  const config = raw.config ?? {};
  const priceDecimals = config.price_decimals;
  const sizeDecimals = config.size_decimals;
  if (
    typeof raw.id !== 'number' ||
    typeof raw.symbol !== 'string' ||
    !Number.isInteger(priceDecimals) ||
    (priceDecimals as number) < 0 ||
    !Number.isInteger(sizeDecimals) ||
    (sizeDecimals as number) < 0
  ) {
    logger.warn(`skipping market with unusable config: ${JSON.stringify(raw.id)}`);
    return undefined;
  }
  return {
    id: raw.id,
    symbol: raw.symbol,
    price_decimals: priceDecimals as number,
    size_decimals: sizeDecimals as number,
    initial_margin:
      typeof config.initial_margin === 'number'
        ? config.initial_margin
        : 1000,
    min_size: 1, // one-unit size floor, in size_decimals units
    order_ttl_blocks:
      typeof raw.order_ttl_blocks === 'number'
        ? raw.order_ttl_blocks
        : 100,
  };
}

export class MarketRegistry {
  private markets = new Map<number, MarketConfig>();
  private context: Context | null = null;
  private fetchedAt = 0;

  async refresh(): Promise<Context> {
    const res = await fetch(`${PERPL_API_URL}/v1/pub/context`);
    if (!res.ok) {
      throw new Error(`context fetch failed: HTTP ${res.status}`);
    }
    const context = (await res.json()) as Context;

    const normalized: MarketConfig[] = [];
    for (const raw of context.markets) {
      const market = normalizeMarket(raw);
      if (market) normalized.push(market);
    }

    this.context = context;
    this.markets = new Map(normalized.map((m) => [m.id, m]));
    this.fetchedAt = Date.now();

    // Mirror the config into Postgres so the API tier can serve it
    // without calling Perpl, and the copy engine can validate
    // markets without holding the registry in memory. Best-effort:
    // a DB outage must not block boot — the in-memory registry
    // above is already authoritative for this process.
    try {
      for (const m of normalized) {
        await pool.query(
          `insert into market_cache
             (market_id, symbol, price_decimals, size_decimals,
              initial_margin, min_size_scaled, order_ttl_blocks, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, now())
           on conflict (market_id) do update set
             symbol = excluded.symbol,
             price_decimals = excluded.price_decimals,
             size_decimals = excluded.size_decimals,
             initial_margin = excluded.initial_margin,
             min_size_scaled = excluded.min_size_scaled,
             order_ttl_blocks = excluded.order_ttl_blocks,
             updated_at = now()`,
          [
            m.id,
            m.symbol,
            m.price_decimals,
            m.size_decimals,
            m.initial_margin ?? 1000,
            m.min_size ?? 1,
            m.order_ttl_blocks ?? 100,
          ],
        );
      }
    } catch (error) {
      logger.warn(
        'market_cache mirror write failed (continuing with in-memory registry)',
        error,
      );
    }

    logger.info(
      `market context loaded: ${normalized.length} markets`,
    );
    return context;
  }

  get marketCount(): number {
    return this.markets.size;
  }

  get ageMs(): number {
    return Date.now() - this.fetchedAt;
  }

  market(id: number): MarketConfig | undefined {
    return this.markets.get(id);
  }

  all(): MarketConfig[] {
    return [...this.markets.values()];
  }

  symbols(): Map<number, string> {
    return new Map(
      [...this.markets.entries()].map(([id, m]) => [id, m.symbol]),
    );
  }
}

export const marketRegistry = new MarketRegistry();
