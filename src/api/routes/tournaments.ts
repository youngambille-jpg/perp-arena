// Tournaments: list, detail with live standings, join,
// and the caller's entries.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { pool } from '../../lib/db.js';
import { ApiError } from '../../lib/errors.js';
import {
  asyncRoute,
  requireAuth,
  validateBody,
  type AuthedRequest,
} from '../middleware.js';

export const tournamentsRouter = Router();
tournamentsRouter.use(requireAuth);

// GET /tournaments?status=active
tournamentsRouter.get(
  '/',
  asyncRoute(async (req: Request, res: Response) => {
    const status =
      typeof req.query.status === 'string' ? req.query.status : undefined;
    const params: unknown[] = [];
    let filter = '';
    if (status && ['scheduled', 'active', 'settled'].includes(status)) {
      params.push(status);
      filter = `where status = $1`;
    }
    const { rows } = await pool.query(
      `select t.*,
              (select count(*) from tournament_entries e where e.tournament_id = t.id) as entries
         from tournaments t ${filter}
        order by t.starts_at desc`,
      params,
    );
    res.json({ tournaments: rows });
  }),
);

// GET /tournaments/me/entries — the caller's entries.
// Registered before /:id so "me" is not captured as an id.
tournamentsRouter.get(
  '/me/entries',
  asyncRoute(async (req: Request, res: Response) => {
    const { userId } = req as AuthedRequest;
    const { rows } = await pool.query(
      `select e.*, t.name, t.status, t.starts_at, t.ends_at
         from tournament_entries e
         join tournaments t on t.id = e.tournament_id
        where e.user_id = $1 order by t.starts_at desc`,
      [userId],
    );
    res.json({ entries: rows });
  }),
);

// GET /tournaments/:id — detail + current standings.
tournamentsRouter.get(
  '/:id',
  asyncRoute(async (req: Request, res: Response) => {
    const { rows } = await pool.query(
      `select * from tournaments where id = $1`,
      [req.params.id],
    );
    if (rows.length === 0) throw ApiError.notFound('Tournament not found');
    const { rows: standings } = await pool.query(
      `select e.*, u.handle
         from tournament_entries e
         join users u on u.id = e.user_id
        where e.tournament_id = $1
        order by e.score desc`,
      [req.params.id],
    );
    res.json({ tournament: rows[0], standings });
  }),
);

// POST /tournaments/:id/join — enter with the caller's live equity.
tournamentsRouter.post(
  '/:id/join',
  validateBody(z.object({})),
  asyncRoute(async (req: Request, res: Response) => {
    const { userId } = req as AuthedRequest;
    const { rows } = await pool.query(
      `select * from tournaments where id = $1`,
      [req.params.id],
    );
    if (rows.length === 0) throw ApiError.notFound('Tournament not found');
    const tournament = rows[0] as {
      status: string;
      entry_fee_usd: number;
    };
    if (tournament.status !== 'scheduled' && tournament.status !== 'active') {
      throw ApiError.badRequest(
        'tournament_closed',
        'This tournament is no longer accepting entries',
      );
    }
    // Entry requires an enrolled key so equity can be tracked.
    const { rows: keys } = await pool.query(
      `select 1 from perpl_accounts where user_id = $1 and status = 'active'`,
      [userId],
    );
    if (keys.length === 0) {
      throw ApiError.badRequest(
        'no_account',
        'Enroll a Perpl API key before joining',
      );
    }
    const { rows: curve } = await pool.query<{ equity: number }>(
      `select equity from equity_snapshots
        where user_id = $1 order by at desc limit 1`,
      [userId],
    );
    const start = curve[0]?.equity ?? 0;
    try {
      const { rows: entered } = await pool.query(
        `insert into tournament_entries
           (tournament_id, user_id, equity_start, equity_peak, equity_low)
         values ($1, $2, $3, $3, $3)
         returning *`,
        [req.params.id, userId, start],
      );
      res.status(201).json({ entry: entered[0] });
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code: string }).code === '23505'
      ) {
        throw ApiError.conflict('Already entered in this tournament');
      }
      throw error;
    }
  }),
);
