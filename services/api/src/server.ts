import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { CompositeVerifier } from './auth/identity.js';
import { loadConfig, type Config } from './config.js';
import { registerRoutes } from './routes/index.js';
import { EventBroker } from './runner/broker.js';
import { InvestigationService } from './service/investigationService.js';
import { MemoryStore } from './store/memory.js';
import type { Store } from './store/types.js';

export interface BuildOptions {
  config?: Config;
  store?: Store;
}

/**
 * Build the API.
 *
 * Exported separately from `listen` so tests can exercise the real routes
 * in-process rather than against a mock.
 */
export async function buildServer(options: BuildOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const store = options.store ?? new MemoryStore();
  const broker = new EventBroker();
  const verifier = CompositeVerifier.create(config);
  const service = new InvestigationService(store, broker, config);

  const app = Fastify({
    logger: {
      level: config.nodeEnv === 'test' ? 'silent' : 'info',
      // Request ids tie every log line to one request; investigation ids are
      // added by the service so a whole investigation can be traced.
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    bodyLimit: 1_000_000,
  });

  await app.register(cors, {
    origin: config.allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
  });

  await registerRoutes(app, { store, broker, service, verifier, config });
  return app;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildServer({ config });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      app.log.info('shutting down');
      void app.close().then(() => process.exit(0));
    });
  }

  await app.listen({ port: config.port, host: '0.0.0.0' });
}

// Only start a server when run directly; importing the module must not listen.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  main().catch((error) => {
    console.error('Netra API failed to start:', error);
    process.exit(1);
  });
}
