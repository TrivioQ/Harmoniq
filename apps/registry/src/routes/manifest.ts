import { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { NotFoundError } from '@harmoniq/core/dist/errors/AppError';
import { toFederationManifest, toImportMap } from '@harmoniq/core/dist/manifest/formats';
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

  /**
   * The current manifest: cache first (keyed only by URL slugs, so a hit never touches
   * the database), rebuilt on a miss, last-known-good when the database fails (MAN-06).
   */
  async function resolve(
    workspaceSlug: string,
    hostAppSlug: string | null,
    envSlug: string
  ): Promise<{ built: BuiltManifest; stale: boolean }> {
    if (hostAppSlug) {
      const cached = await cache.get(manifestKey(workspaceSlug, hostAppSlug, envSlug));
      if (cached) {
        fastify.metricMeters.manifestCacheHits.add(1);
        return { built: JSON.parse(cached) as BuiltManifest, stale: false };
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
      return { built, stale: false };
    } catch (err) {
      if (err instanceof NotFoundError || !hostAppSlug) throw err;
      const lkg = await cache.get(lastKnownGoodKey(workspaceSlug, hostAppSlug, envSlug));
      if (!lkg) throw err;
      logger.error('Serving last-known-good manifest after build failure', err as Error);
      return { built: JSON.parse(lkg) as BuiltManifest, stale: true };
    }
  }

  async function serve(
    request: FastifyRequest<{ Querystring: { pretty?: string } }>,
    reply: FastifyReply,
    workspaceSlug: string,
    hostAppSlug: string | null,
    envSlug: string
  ) {
    const { built, stale } = await resolve(workspaceSlug, hostAppSlug, envSlug);
    return send(request, reply, built, stale);
  }

  /** Derived formats (import map, federation manifest) share the manifest's caching. */
  async function serveDerived(
    request: FastifyRequest<{ Params: CanonicalParams }>,
    reply: FastifyReply,
    format: 'importmap' | 'federation',
    contentType: string,
    toBody: (manifest: BuiltManifest['manifest']) => unknown
  ) {
    const { workspaceSlug, hostAppSlug, env } = request.params;
    const { built, stale } = await resolve(workspaceSlug, hostAppSlug, env);
    // Derived from the manifest ETag: changes exactly when the manifest does (IMP-04).
    const etag = `${built.etag}.${format}`;
    reply.header('ETag', `"${etag}"`);
    reply.header('Cache-Control', 'no-cache');
    if (stale) reply.header('X-Harmoniq-Stale', 'true');
    if (etagMatches(request.headers['if-none-match'], etag)) return reply.code(304).send();
    return reply.type(contentType).send(JSON.stringify(toBody(built.manifest)));
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

  // IMP-01..06: standards-compliant import map (also valid for SystemJS).
  fastify.get<{ Params: CanonicalParams; Querystring: { format?: string } }>(
    '/api/importmap/:workspaceSlug/:hostAppSlug/:env',
    { config: rateLimit },
    (request, reply) =>
      serveDerived(
        request,
        reply,
        'importmap',
        request.query.format === 'systemjs'
          ? 'application/systemjs-importmap'
          : 'application/importmap+json',
        toImportMap
      )
  );

  // Native Federation (`@angular-architects/native-federation`): { name: remoteEntry URL }.
  fastify.get<{ Params: CanonicalParams }>(
    '/api/federation-manifest/:workspaceSlug/:hostAppSlug/:env',
    { config: rateLimit },
    (request, reply) =>
      serveDerived(request, reply, 'federation', 'application/json', toFederationManifest)
  );
};

export default manifestRoutes;
