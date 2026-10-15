// Express API server: thin mobile client <-> Supabase/Postgres.
// The trading brain (Perpl websockets, copy engine) lives in
// the worker process, not here.

import express from 'express';
import type { Server } from 'node:http';
import { PORT } from '../config.js';
import { logger } from '../lib/logger.js';
import { perUserRateLimiter } from '../lib/ratelimit.js';
import { errorHandler } from './middleware.js';
import { healthRouter, marketsRouter } from './routes/health.js';
import { metaRouter } from './routes/meta.js';
import { accountsRouter } from './routes/accounts.js';
import { leadersRouter } from './routes/leaders.js';
import { copyRouter } from './routes/copy.js';
import { tournamentsRouter } from './routes/tournaments.js';
import { dashboardRouter } from './routes/dashboard.js';
import { usersRouter } from './routes/users.js';
import { tradingRouter } from './routes/trading.js';
import { marketRegistry } from '../perpl/context.js';

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, DELETE, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Authorization, Content-Type, ngrok-skip-browser-warning',
    );
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });
  app.use(express.json({ limit: '256kb' }));

  app.get(
    ['/.well-known/assetlinks.json', '/.well-known/assetslinks.json'],
    (_req, res) => {
      res.json([
        {
          relation: ['delegate_permission/common.get_login_creds'],
          target: {
            namespace: 'android_app',
            package_name: 'com.pera.mobile',
            sha256_cert_fingerprints: [
              'FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C',
            ],
          },
        },
      ]);
    },
  );

  // Prune stale rate-limit buckets every 5 minutes.
  const pruneTimer = setInterval(
    () => perUserRateLimiter.prune(10 * 60_000),
    5 * 60_000,
  );
  pruneTimer.unref();

  app.use('/health', healthRouter);
  app.use('/meta', metaRouter);
  app.use('/markets', marketsRouter);
  app.use('/accounts', accountsRouter);
  app.use('/leaders', leadersRouter);
  app.use('/copy', copyRouter);
  app.use('/tournaments', tournamentsRouter);
  app.use('/dashboard', dashboardRouter);
  app.use('/users', usersRouter);
  app.use('/trading', tradingRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'Not found' } });
  });
  app.use(errorHandler);
  return app;
}

export async function startServer(): Promise<Server> {
  // Market context at startup: authoritative market ids and
  // scaling decimals. Retried — the API serves 503s from an
  // empty cache until this succeeds.
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

  const app = createApp();
  const server = app.listen(PORT);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.once('listening', () => {
      server.off('error', onError);
      logger.info(`perpl-arena api listening on :${PORT}`);
      resolve();
    });
  });
  return server;
}
