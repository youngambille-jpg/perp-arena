// Health and market data routes (public).

import { Router, type Request, type Response } from 'express';
import { pool } from '../../lib/db.js';
import { marketRegistry } from '../../perpl/context.js';
import { fetchCandles } from '../../perpl/rest.js';
import { asyncRoute } from '../middleware.js';
import { ApiError } from '../../lib/errors.js';

export const healthRouter = Router();

healthRouter.get(
  '/',
  asyncRoute(async (_req: Request, res: Response) => {
    let db = false;
    try {
      await pool.query('select 1');
      db = true;
    } catch {
      db = false;
    }
    res.json({
      ok: db,
      db,
      markets: marketRegistry.marketCount,
      contextAgeMs: marketRegistry.ageMs,
      at: new Date().toISOString(),
    });
  }),
);

export const marketsRouter = Router();

// GET /markets — cached market configs with live prices.
marketsRouter.get(
  '/',
  asyncRoute(async (_req: Request, res: Response) => {
    const { rows } = await pool.query(
      `select m.market_id, m.symbol, m.price_decimals, m.size_decimals,
              m.initial_margin, m.order_ttl_blocks,
              p.oracle_price, p.mark_price, p.last_price, p.mid_price,
              p.bid, p.ask, p.price_24h_ago, p.daily_volume,
              p.open_interest, p.at as price_at
         from market_cache m
         left join price_cache p on p.market_id = m.market_id
        order by m.market_id`,
    );
    res.json({ markets: rows });
  }),
);

// GET /markets/:id/candles?resolution=3600&hours=24
marketsRouter.get(
  '/:id/candles',
  asyncRoute(async (req: Request, res: Response) => {
    const marketId = Number(req.params.id);
    if (!Number.isInteger(marketId)) {
      throw ApiError.badRequest('invalid_market', 'market id must be an integer');
    }
    const allowed = [60, 300, 900, 1800, 3600, 7200, 14400, 28800, 43200, 86400];
    const resolution = Number(req.query.resolution ?? 3600);
    if (!allowed.includes(resolution)) {
      throw ApiError.badRequest(
        'invalid_resolution',
        `resolution must be one of ${allowed.join(', ')}`,
      );
    }
    const hours = Math.min(
      Math.max(Number(req.query.hours ?? 24), 1),
      24 * 30,
    );
    const to = Date.now();
    const from = to - hours * 60 * 60 * 1000;

    const candles = await fetchCandles(marketId, resolution, from, to);
    const market = marketRegistry.market(marketId);
    const scale = market ? 10 ** market.price_decimals : 1;
    res.json({
      marketId,
      resolution,
      candles: candles.map((c) => ({
        t: c.t,
        o: c.o / scale,
        h: c.h / scale,
        l: c.l / scale,
        c: c.c / scale,
        v: c.v,
        n: c.n,
      })),
    });
  }),
);
