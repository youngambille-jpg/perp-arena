import ngrok from '@ngrok/ngrok';
import { PORT } from './config.js';
import { startServer } from './api/server.js';
import { logger } from './lib/logger.js';

async function startTunnel(): Promise<void> {
  if (!process.env.NGROK_AUTHTOKEN) {
    throw new Error('NGROK_AUTHTOKEN is required to start the ngrok tunnel.');
  }

  const server = await startServer();
  try {
    const options: { addr: string; authtoken_from_env: true; domain?: string } = {
      addr: `localhost:${PORT}`,
      authtoken_from_env: true,
    };
    if (process.env.NGROK_DOMAIN) {
      options.domain = process.env.NGROK_DOMAIN;
    }

    const forwarder = await ngrok.forward(options);
    logger.info(`ngrok tunnel available: ${forwarder.url()}`);

    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;

      try {
        await forwarder.close();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      } catch (error) {
        logger.error('ngrok shutdown failed', error);
        process.exitCode = 1;
      }
    };

    process.once('SIGINT', () => void shutdown());
    process.once('SIGTERM', () => void shutdown());
  } catch (error) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    throw error;
  }
}

startTunnel().catch((error) => {
  logger.error('ngrok tunnel startup failed', error);
  process.exitCode = 1;
});
