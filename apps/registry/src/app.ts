import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import containerPlugin from './plugins/container';
import authenticatePlugin from './plugins/authenticate';
import manifestRoutes from './routes/manifest';
import deployRoutes from './routes/deploy';
import webhookRoutes from './routes/webhooks';
import adminRoutes from './routes/admin';
import workspaceRoutes from './routes/workspaces';
import jobsPlugin from './plugins/jobs';
import metricsPlugin from './plugins/metrics';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { Config, loadConfig } from './config';

declare module 'fastify' {
  interface FastifyInstance {
    config: Config;
  }
}

export async function buildApp() {
  // Throws ConfigError on unsafe production configuration (missing/default secrets).
  const config = loadConfig();

  const app = Fastify({
    logger:
      process.env.NODE_ENV === 'production'
        ? true
        : {
            transport: {
              target: 'pino-pretty',
              options: { colorize: true },
            },
          },
  });

  app.decorate('config', config);

  // Register security plugins
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: [],
      },
    },
  });
  // Public reads (manifests are fetched by host apps on any origin) allow `*` without
  // credentials. Everything else — writes, admin, workspace APIs — only the dashboard.
  await app.register(cors, {
    delegator: (req, callback) => {
      const method = (req.headers['access-control-request-method'] as string) || req.method;
      const isPublicRead =
        (method === 'GET' || method === 'HEAD') &&
        /^\/(api\/manifest|api\/importmap|health|ready|docs)(\/|$|\?)/.test(req.url ?? '');
      callback(
        null,
        isPublicRead
          ? { origin: '*', credentials: false }
          : { origin: config.webOrigin, credentials: true }
      );
    },
  });

  await app.register(rateLimit, {
    max: 1000,
    timeWindow: '1 minute',
    global: false, // We will apply it explicitly to write endpoints
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Harmoniq Registry API',
        description: 'API for Harmoniq Micro Frontend Registry',
        version: '1.0.0',
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
          },
        },
      },
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
  });

  // Register local plugins
  await app.register(metricsPlugin);
  await app.register(containerPlugin);
  await app.register(authenticatePlugin);
  await app.register(jobsPlugin);

  // Register routes
  await app.register(manifestRoutes);
  await app.register(deployRoutes);
  await app.register(webhookRoutes);
  await app.register(adminRoutes);
  await app.register(workspaceRoutes);

  // Health check routes
  app.get('/health', async () => {
    return { status: 'ok' };
  });

  app.get('/ready', async (_request, reply) => {
    try {
      await Promise.all([
        app.container.db.$queryRaw`SELECT 1`,
        app.container.systemDb.$queryRaw`SELECT 1`,
      ]);
      // Check cache by setting/getting a temp key
      await app.container.cache.set('ping', 'pong', 5);
      const val = await app.container.cache.get('ping');
      if (val !== 'pong') throw new Error('Cache failed');
      return { status: 'ok' };
    } catch {
      reply.code(503).send({ status: 'error', message: 'Dependencies not ready' });
    }
  });

  return app;
}
