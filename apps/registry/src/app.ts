import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import containerPlugin from './plugins/container';
import authenticatePlugin from './plugins/authenticate';
import manifestRoutes from './routes/manifest';
import moduleRoutes from './routes/modules';
import healthRoutes from './routes/health';
import alertRoutes from './routes/alerts';
import scheduledRoutes from './routes/scheduled';
import approvalRoutes from './routes/approvals';
import ssoRoutes from './routes/sso';
import samlRoutes from './routes/saml';
import scimRoutes from './routes/scim';
import orgRoutes from './routes/orgs';
import { SsoProviders } from './services/sso';
import hostAppRoutes from './routes/hostApps';
import historyRoutes from './routes/history';
import accessRoutes from './routes/access';
import staticRoutes from './routes/static';
import webhookRoutes from './routes/webhooks';
import adminRoutes from './routes/admin';
import workspaceRoutes from './routes/workspaces';
import gitopsRoutes from './routes/gitops';
import authRoutes from './routes/auth';
import jobsPlugin from './plugins/jobs';
import metricsPlugin from './plugins/metrics';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { openapiTransform } from './openapi';
import { ZodError } from 'zod';
import { AppError } from '@harmoniq/core/dist/errors/AppError';
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
    trustProxy: config.trustProxy,
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

  // Services throw AppError subclasses; this is the only place they become HTTP errors.
  app.setErrorHandler((err, request, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({
        error: {
          code: err.code,
          message: err.message,
          ...(err.metadata && { details: err.metadata }),
        },
      });
    }
    // Structural check: core and the registry may resolve different copies of zod.
    if (err instanceof ZodError || (err.name === 'ZodError' && 'flatten' in err)) {
      return reply.code(400).send({
        error: {
          code: 'BAD_REQUEST',
          message: 'Invalid request',
          details: (err as unknown as ZodError).flatten(),
        },
      });
    }
    const status = err.statusCode ?? 500;
    if (status < 500) {
      return reply
        .code(status)
        .send({ error: { code: err.code ?? 'BAD_REQUEST', message: err.message } });
    }
    request.log.error(err);
    return reply
      .code(500)
      .send({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  });

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
      const isPublic =
        ((method === 'GET' || method === 'HEAD') &&
          /^\/(api\/manifest|api\/importmap|api\/federation-manifest|api\/schema|static|health|ready|docs)(\/|$|\?)/.test(
            req.url ?? ''
          )) ||
        // Health reports from host apps (HLT-01).
        (method === 'POST' && /^\/api\/health\//.test(req.url ?? ''));
      callback(
        null,
        isPublic
          ? {
              origin: '*',
              credentials: false,
              // Without these, browsers hide them from cross-origin reads (no 304 polling).
              exposedHeaders: [
                'ETag',
                'X-Harmoniq-Variant',
                'X-Harmoniq-Cohort-Id',
                'X-Harmoniq-Stale',
              ],
              // Preflights caused by X-Harmoniq-User-Id (canary assignment).
              maxAge: 600,
            }
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
    // OAS-01: generated from the routes; docs/openapi.json is this, committed.
    transform: openapiTransform,
    openapi: {
      info: {
        title: 'Harmoniq Registry API',
        description:
          'Micro frontend registry: manifests, deploys, progressive delivery, governance. See docs/api-reference.md.',
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
  app.decorate('ssoProviders', new SsoProviders(app));
  await app.register(manifestRoutes);
  await app.register(moduleRoutes);
  await app.register(healthRoutes);
  await app.register(alertRoutes);
  await app.register(scheduledRoutes);
  await app.register(approvalRoutes);
  await app.register(ssoRoutes);
  await app.register(samlRoutes);
  await app.register(scimRoutes);
  await app.register(orgRoutes);
  await app.register(hostAppRoutes);
  await app.register(historyRoutes);
  await app.register(accessRoutes);
  await app.register(staticRoutes);
  await app.register(webhookRoutes);
  await app.register(adminRoutes);
  await app.register(workspaceRoutes);
  await app.register(gitopsRoutes);
  await app.register(authRoutes);

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
