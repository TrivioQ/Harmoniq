import { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { NotFoundError } from '@harmoniq/core/dist/errors/AppError';
import { BuiltManifest, buildManifest } from '../services/manifestBuilder';
import { lastKnownGoodKey, manifestKey } from '../services/cacheKeys';
import { MANIFEST_CACHE_TTL_SECONDS } from '../services/manifestMutation';

type CanonicalParams = { workspaceSlug: string; hostAppSlug: string; env: string };
type LegacyParams = { workspaceSlug: string; env: string };

/** `If-None-Match` may hold several, possibly weak, quoted ETags. */
function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === '*') return true;
  return header
    .split(',')
    .map((t) => t.trim().replace(/^W\//, '').replace(/^"|"$/g, ''))
    .includes(etag);
}

const manifestRoutes: FastifyPluginAsync = async (fastify) => {
  const { cache, systemDb, withTenant, logger } = fastify.container;
  const { isProduction } = fastify.config;

  // RL-01/02: per (workspace, client IP). In-memory per replica for now; RL-03 (shared
  // store) moves this to Redis.
  const rateLimit = {
    rateLimit: {
      max: fastify.config.manifestRateLimit,
      timeWindow: '1 minute',
      keyGenerator: (req: FastifyRequest) =>
        `${(req.params as { workspaceSlug?: string }).workspaceSlug}:${req.ip}`,
      onExceeded: (req: FastifyRequest) => {
        fastify.metricMeters.manifestRateLimited.add(1, {
          workspace: (req.params as { workspaceSlug?: string }).workspaceSlug ?? '',
        });
      },
    },
  };

  function send(
    request: FastifyRequest<{ Querystring: { pretty?: string } }>,
    reply: FastifyReply,
    built: BuiltManifest,
    stale = false
  ) {
    reply.header('ETag', `"${built.etag}"`);
    reply.header('Cache-Control', 'no-cache');
    reply.header('X-Harmoniq-Variant', built.manifest.variant);
    reply.header('X-Harmoniq-Cohort-Id', built.manifest.cohortId);
    if (stale) reply.header('X-Harmoniq-Stale', 'true');

    if (etagMatches(request.headers['if-none-match'], built.etag)) {
      return reply.code(304).send();
    }
    // DX-03: human-readable output for local debugging only.
    if (!isProduction && request.query.pretty === 'true') {
      return reply.type('application/json').send(JSON.stringify(built.manifest, null, 2));
    }
    return reply.send(built.manifest);
  }

  /** Resolves the tenant and builds from the database (cache miss). */
  async function load(workspaceSlug: string, hostAppSlug: string | null, envSlug: string) {
    const workspace = await systemDb.workspace.findUnique({
      where: { slug: workspaceSlug },
      include: {
        HostApps: {
          where: hostAppSlug ? { slug: hostAppSlug } : {},
          orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
          include: { Environments: { where: { slug: envSlug } } },
        },
      },
    });
    // Legacy endpoint: the default host app, or the only one (HST-02).
    const hostApp =
      hostAppSlug !== null
        ? workspace?.HostApps[0]
        : (workspace?.HostApps.find((h) => h.isDefault) ??
          (workspace?.HostApps.length === 1 ? workspace.HostApps[0] : undefined));
    const environment = hostApp?.Environments[0];
    if (!workspace || !hostApp || !environment) {
      throw new NotFoundError('Manifest not found');
    }

    const built = await withTenant(workspace.id, (tx) =>
      buildManifest(tx, { workspaceSlug, hostApp, environment })
    );
    return { built, hostAppSlug: hostApp.slug };
  }

  async function serve(
    request: FastifyRequest<{ Querystring: { pretty?: string } }>,
    reply: FastifyReply,
    workspaceSlug: string,
    hostAppSlug: string | null,
    envSlug: string
  ) {
    // Cache first, keyed only by URL slugs: a hit never touches the database.
    if (hostAppSlug) {
      const cached = await cache.get(manifestKey(workspaceSlug, hostAppSlug, envSlug));
      if (cached) {
        fastify.metricMeters.manifestCacheHits.add(1);
        return send(request, reply, JSON.parse(cached) as BuiltManifest);
      }
    }
    fastify.metricMeters.manifestCacheMisses.add(1);

    try {
      const { built, hostAppSlug: resolvedHost } = await load(workspaceSlug, hostAppSlug, envSlug);
      const value = JSON.stringify(built);
      await cache.set(
        manifestKey(workspaceSlug, resolvedHost, envSlug),
        value,
        MANIFEST_CACHE_TTL_SECONDS
      );
      await cache.set(lastKnownGoodKey(workspaceSlug, resolvedHost, envSlug), value);
      return send(request, reply, built);
    } catch (err) {
      if (err instanceof NotFoundError || !hostAppSlug) throw err;
      // MAN-06: on database failure serve the last manifest we know was correct.
      const lkg = await cache.get(lastKnownGoodKey(workspaceSlug, hostAppSlug, envSlug));
      if (!lkg) throw err;
      logger.error('Serving last-known-good manifest after build failure', err as Error);
      return send(request, reply, JSON.parse(lkg) as BuiltManifest, true);
    }
  }

  // HST-01: canonical endpoint. Public (MAN-05).
  fastify.get<{ Params: CanonicalParams; Querystring: { pretty?: string } }>(
    '/api/manifest/:workspaceSlug/:hostAppSlug/:env',
    { config: rateLimit },
    (request, reply) =>
      serve(
        request,
        reply,
        request.params.workspaceSlug,
        request.params.hostAppSlug,
        request.params.env
      )
  );

  // HST-02: legacy endpoint, resolves to the workspace's default host app.
  fastify.get<{ Params: LegacyParams; Querystring: { pretty?: string } }>(
    '/api/manifest/:workspaceSlug/:env',
    { config: rateLimit },
    (request, reply) =>
      serve(request, reply, request.params.workspaceSlug, null, request.params.env)
  );
};

export default manifestRoutes;
