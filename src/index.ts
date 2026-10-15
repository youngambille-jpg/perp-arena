// API entry: `pnpm dev` / `pnpm start` serve the mobile REST API.
// The trading brain runs separately: `pnpm dev:worker`.

import { startServer } from './api/server.js';
import { logger } from './lib/logger.js';

startServer().catch((error) => {
  logger.error('api fatal', error);
  process.exit(1);
});
