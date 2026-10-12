// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import Fastify, { FastifyError, FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Redis from 'ioredis';
import containerPlugin from './plugins/container';
import { startHeartbeat } from './services/operations';
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
import adminDirectoryRoutes from './routes/adminDirectory';
import domainRoutes from './routes/domains';
import transferRoutes from './routes/transfers';
import exportRoutes from './routes/exports';
import invitationRoutes from './routes/invitations';
import accessRequestRoutes from './routes/accessRequests';
import workspaceRoutes from './routes/workspaces';
import gitopsRoutes from './routes/gitops';
import workspacePolicyRoutes from './routes/policy';
import usageRoutes from './routes/usage';
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
    // HTTP/2 needs TLS here; behind a TLS-terminating proxy, let the proxy speak HTTP/2.
    ...((config.tls
      ? {
          http2: true,
          https: {
            allowHTTP1: true,
            cert: readFileSync(config.tls.certFile),
            key: readFileSync(config.tls.keyFile),
          },
        }
      : {}) as object),
    trustProxy: config.trustProxy,
    // Structured logs carry `requestId` (and, once resolved, the workspace); `responseTime`
    // on "request completed" is the duration. A caller's X-Request-Id is kept.
    genReqId: (req) => {
      const given = req.headers['x-request-id'];
      return typeof given === 'string' && /^[\w.:-]{1,128}$/.test(given) ? given : randomUUID();
    },
    requestIdLogLabel: 'requestId',
    logger:
      process.env.NODE_ENV === 'production'
        ? true
        : {
            transport: {
              target: 'pino-pretty',
              options: { colorize: true },
            },
          },
    // Same request/reply API over HTTP/1.1 and HTTP/2; routes are typed against HTTP/1.1.
  }) as unknown as FastifyInstance;

  app.decorate('config', config);
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Request-Id', request.id);
  });
  // The workspace a request resolved to, on its remaining log lines.
  app.addHook('onSend', async (request) => {
    if (request.workspace) {
      request.log = request.log.child({
        workspaceId: request.workspace.id,
        workspace: request.workspace.slug,
      });
    }
  });

  // Services throw AppError subclasses; this is the only place they become HTTP errors.
  app.setErrorHandler((err: FastifyError, request, reply) => {
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

  // Every write gets a limit unless its route sets a stricter one (sign-in, setup, health
  // ingest…). Keyed by credential, so CI runners behind one NAT don't share a budget.
  // Added before the plugin so its onRoute hook sees the config.
  app.addHook('onRoute', (route) => {
    const methods = [route.method].flat();
    if (!methods.some((m) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(m))) return;
    route.config = route.config ?? {};
    const routeConfig = route.config as { rateLimit?: unknown };
    if (routeConfig.rateLimit !== undefined) return;
    // MT-12: writes to a workspace or an organization share that tenant's budget (by plan,
    // RL-04), whoever makes them; other writes are limited per credential.
    const tenant = route.url.includes(':workspaceSlug')
      ? 'workspaceSlug'
      : route.url.includes(':orgSlug')
        ? 'orgSlug'
        : null;
    routeConfig.rateLimit = tenant
      ? {
          timeWindow: '1 minute',
          keyGenerator: (request: { params: unknown }) =>
            `t:${tenant === 'workspaceSlug' ? 'ws' : 'org'}:${(request.params as Record<string, string>)[tenant]}`,
          max: async (request: { params: unknown }) => {
            const slug = (request.params as Record<string, string>)[tenant];
            const plan =
              tenant === 'workspaceSlug'
                ? await app.container.plans.planOf({ slug })
                : await app.container.plans.planOfOrgSlug(slug);
            return app.container.settings.rateLimits().api[plan];
          },
        }
      : {
          // INST-34: read per request, so a change in the admin panel applies at once.
          max: () => app.container.settings.rateLimits().write,
          timeWindow: '1 minute',
          keyGenerator: (request: { headers: Record<string, unknown>; ip: string }) => {
            const auth = request.headers.authorization;
            return typeof auth === 'string' && auth
              ? `w:${createHash('sha256').update(auth).digest('hex').slice(0, 32)}`
              : `w:${request.ip}`;
          },
        };
  });
  // RL-03: with Redis, every replica counts against the same limits.
  const rateLimitRedis =
    config.cacheAdapter === 'redis' && config.redisUrl
      ? new Redis(config.redisUrl, { connectTimeout: 500, maxRetriesPerRequest: 1 })
      : undefined;
  if (rateLimitRedis) app.addHook('onClose', async () => void (await rateLimitRedis.quit()));
  await app.register(rateLimit, {
    max: 1000,
    timeWindow: '1 minute',
    ...(rateLimitRedis && { redis: rateLimitRedis, nameSpace: 'harmoniq:rl:' }),
    global: false, // Applied per route: writes (above), manifests, sign-in.
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
  // INST-28: this replica's version and liveness, for the admin health page.
  const stopHeartbeat = startHeartbeat(
    app.container.systemDb,
    () => app.container.settings.loadedAt
  );
  app.addHook('onClose', stopHeartbeat);

  // INST-37: maintenance mode makes the instance read-only. Reads, manifests, health
  // reports, sign-in and the admin API (to end it) keep working.
  const MAINTENANCE_OPEN = [
    '/api/admin/',
    '/api/auth/',
    '/api/me/',
    '/api/health/',
    '/api/instance',
  ];
  app.addHook('onRequest', async (request, reply) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
    const maintenance = app.container.settings.maintenance();
    if (!maintenance?.active) return;
    const path = request.url.split('?')[0];
    if (MAINTENANCE_OPEN.some((prefix) => path.startsWith(prefix))) return;
    const retryAfter = maintenance.until
      ? Math.max(1, Math.ceil((new Date(maintenance.until).getTime() - Date.now()) / 1000))
      : 300;
    return reply
      .code(503)
      .header('Retry-After', String(retryAfter))
      .send({
        error: {
          code: 'MAINTENANCE',
          message: maintenance.message || 'The registry is in maintenance; changes are paused.',
          ...(maintenance.until && { until: maintenance.until }),
        },
      });
  });
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
  await app.register(adminDirectoryRoutes);
  await app.register(workspacePolicyRoutes);
  await app.register(usageRoutes);
  await app.register(workspaceRoutes);
  await app.register(domainRoutes);
  await app.register(transferRoutes);
  await app.register(exportRoutes);
  await app.register(invitationRoutes);
  await app.register(accessRequestRoutes);
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
