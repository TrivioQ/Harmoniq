// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { withSpan } from '../services/tracing';
import { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { GoneError, NotFoundError } from '@harmoniq/core/dist/errors/AppError';
import { toFederationManifest, toImportMap } from '@harmoniq/core/dist/manifest/formats';
import { BuiltManifest, buildManifest } from '../services/manifestBuilder';
import { manifestJsonSchema } from '../services/manifestJsonSchema';
import { LRUCache } from 'lru-cache';
import {
  defaultHostKey,
  lastKnownDefaultHostKey,
  lastKnownGoodKey,
  manifestKey,
  missingManifestKey,
} from '../services/cacheKeys';
import {
  assignCanaries,
  attributesFrom,
  cohortIdFor,
  userKeyFrom,
  variantKey,
} from '../services/canary';
import { MANIFEST_CACHE_TTL_SECONDS } from '../services/manifestMutation';

type CanonicalParams = { workspaceSlug: string; hostAppSlug: string; env: string };
type LegacyParams = { workspaceSlug: string; env: string };
type Resolved = { built: BuiltManifest; stale: boolean; cohortId?: string };

/** How long "not found" is cached for an environment or a workspace's default host. */
const MISSING_TTL_SECONDS = 10;
const MISS_WINDOW_MS = 60_000;

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
  // Public manifests resolve the workspace by slug; everything after runs in withTenant.
  // eslint-disable-next-line no-restricted-syntax -- MT-09: tenant resolution
  const { cache, systemDb, withTenant, logger, orgShared } = fastify.container;
  const { isProduction } = fastify.config;

  const { manifestMissLimit, manifestRateLimits } = fastify.config;

  // Per-IP count of not-found responses, across all workspaces: the rate limit below is
  // keyed by workspace slug, so made-up slugs would each get a fresh quota. Per replica.
  const misses = new LRUCache<string, { count: number; resetAt: number }>({ max: 50_000 });
  const missRetryAfter = (ip: string): number => {
    const entry = misses.get(ip);
    if (!entry) return 0;
    const now = Date.now();
    if (entry.resetAt <= now) {
      misses.delete(ip);
      return 0;
    }
    return entry.count >= manifestMissLimit ? Math.ceil((entry.resetAt - now) / 1000) : 0;
  };
  const recordMiss = (ip: string) => {
    const now = Date.now();
    const entry = misses.get(ip);
    if (!entry || entry.resetAt <= now) misses.set(ip, { count: 1, resetAt: now + MISS_WINDOW_MS });
    else entry.count++;
  };

  // RL-01/02: per (workspace, client IP); shared across replicas with Redis (RL-03).
  // RL-04: the limit depends on the workspace's plan.
  const rateLimit = {
    rateLimit: {
      // An IP over the not-found limit is refused by the handler; don't look its plan up.
      max: async (req: FastifyRequest) =>
        missRetryAfter(req.ip)
          ? manifestRateLimits.hobby
          : fastify.container.plans.manifestRateLimit(
              (req.params as { workspaceSlug?: string }).workspaceSlug
            ),
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
    resolved: Resolved
  ) {
    const { built, stale, cohortId } = resolved;
    // CAN-07: the per-user cohort replaces the shared placeholder of a cached variant.
    const manifest = cohortId ? { ...built.manifest, cohortId } : built.manifest;
    reply.header('ETag', `"${built.etag}"`);
    // CAN-03: a canary variant is per user and must not be stored by shared caches.
    reply.header('Cache-Control', manifest.variant === 'canary' ? 'private, no-cache' : 'no-cache');
    if (built.canaries) {
      const vary = reply.getHeader('vary');
      reply.header(
        'Vary',
        [vary, 'X-Harmoniq-User-Id, X-Harmoniq-Context, Cookie'].filter(Boolean).join(', ')
      );
    }
    reply.header('X-Harmoniq-Variant', manifest.variant);
    reply.header('X-Harmoniq-Cohort-Id', manifest.cohortId);
    if (stale) reply.header('X-Harmoniq-Stale', 'true');

    if (etagMatches(request.headers['if-none-match'], built.etag)) {
      return reply.code(304).send();
    }
    // DX-03: human-readable output for local debugging only.
    if (!isProduction && request.query.pretty === 'true') {
      return reply.type('application/json').send(JSON.stringify(manifest, null, 2));
    }
    return reply.send(manifest);
  }

  /** Resolves the tenant and builds from the database (cache miss). */
  async function load(
    workspaceSlug: string,
    hostAppSlug: string,
    envSlug: string,
    canaryModuleIds?: string[]
  ) {
    // eslint-disable-next-line no-restricted-syntax -- MT-09: tenant resolution
    const workspace = await systemDb.workspace.findUnique({
      where: { slug: workspaceSlug },
      include: {
        HostApps: {
          where: { slug: hostAppSlug },
          include: { Environments: { where: { slug: envSlug } } },
        },
      },
    });
    // TLC-02: a deleted workspace's manifests are gone (restorable until the purge).
    if (workspace?.deletedAt) throw new GoneError('This workspace was deleted');
    const hostApp = workspace?.HostApps[0];
    const environment = hostApp?.Environments[0];
    if (!workspace || !hostApp || !environment) {
      throw new NotFoundError('Manifest not found');
    }

    const shared = await orgShared.forTarget(workspace.id, environment.slug);
    const built = await withTenant(workspace.id, (tx) =>
      buildManifest(tx, { workspaceSlug, hostApp, environment }, { canaryModuleIds, shared })
    );
    return { built, hostAppSlug: hostApp.slug };
  }

  // Concurrent cache misses for one key share a single build (per replica), so an expired
  // or invalidated popular manifest doesn't send every waiting request to the database.
  const inflight = new Map<string, Promise<Resolved>>();
  function once(key: string, build: () => Promise<Resolved>): Promise<Resolved> {
    let pending = inflight.get(key);
    if (!pending) {
      pending = build().finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    return pending;
  }

  /**
   * HST-02: the host app the legacy endpoint serves, the workspace's default (or only)
   * host app. Cached like a manifest; the last known value is used while the database
   * is unreachable, so the legacy endpoint keeps its stale fallback too.
   */
  async function defaultHost(workspaceSlug: string): Promise<string> {
    const cached = await cache.get(defaultHostKey(workspaceSlug));
    if (cached !== null) {
      if (!cached) throw new NotFoundError('Manifest not found');
      return cached;
    }
    let host: string;
    try {
      // eslint-disable-next-line no-restricted-syntax -- MT-09: tenant resolution
      const workspace = await systemDb.workspace.findUnique({
        where: { slug: workspaceSlug },
        select: {
          deletedAt: true,
          HostApps: {
            select: { slug: true, isDefault: true },
            orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
          },
        },
      });
      if (workspace?.deletedAt) throw new GoneError('This workspace was deleted');
      const hosts = workspace?.HostApps ?? [];
      host = hosts.find((h) => h.isDefault)?.slug ?? (hosts.length === 1 ? hosts[0].slug : '');
    } catch (err) {
      if (err instanceof GoneError) throw err;
      const lkg = await cache.get(lastKnownDefaultHostKey(workspaceSlug));
      if (lkg) return lkg;
      throw err;
    }
    await cache.set(
      defaultHostKey(workspaceSlug),
      host,
      host ? MANIFEST_CACHE_TTL_SECONDS : MISSING_TTL_SECONDS
    );
    if (!host) throw new NotFoundError('Manifest not found');
    await cache.set(lastKnownDefaultHostKey(workspaceSlug), host);
    return host;
  }

  /**
   * The current manifest: cache first (keyed only by URL slugs, so a hit never touches
   * the database), rebuilt on a miss, last-known-good when the database fails (MAN-06).
   * The legacy endpoint (no host app in the URL) resolves its host app first and then
   * takes exactly the same path.
   */
  async function resolveStable(
    workspaceSlug: string,
    hostAppSlug: string | null,
    envSlug: string
  ): Promise<Resolved> {
    const host = hostAppSlug ?? (await defaultHost(workspaceSlug));
    const key = manifestKey(workspaceSlug, host, envSlug);
    const cached = await cache.get(key);
    if (cached) {
      fastify.metricMeters.manifestCacheHits.add(1);
      return { built: JSON.parse(cached) as BuiltManifest, stale: false };
    }
    if (await cache.get(missingManifestKey(workspaceSlug, host, envSlug))) {
      throw new NotFoundError('Manifest not found');
    }
    fastify.metricMeters.manifestCacheMisses.add(1);

    return once(key, async () => {
      try {
        const { built } = await load(workspaceSlug, host, envSlug);
        const value = JSON.stringify(built);
        await cache.set(key, value, MANIFEST_CACHE_TTL_SECONDS);
        await cache.set(lastKnownGoodKey(workspaceSlug, host, envSlug), value);
        return { built, stale: false };
      } catch (err) {
        if (err instanceof NotFoundError) {
          await cache.set(
            missingManifestKey(workspaceSlug, host, envSlug),
            '1',
            MISSING_TTL_SECONDS
          );
          throw err;
        }
        // Never a last-known-good copy of a deleted workspace.
        if (err instanceof GoneError) throw err;
        const lkg = await cache.get(lastKnownGoodKey(workspaceSlug, host, envSlug));
        if (!lkg) throw err;
        logger.error('Serving last-known-good manifest after build failure', err as Error);
        return { built: JSON.parse(lkg) as BuiltManifest, stale: true };
      }
    });
  }

  /**
   * CAN-02: the variant for this user. The stable manifest (cached) lists the running
   * canaries; the user's cohort decides which of them apply, and each combination is
   * built once and cached under its own key. Users without a key get the stable variant.
   */
  function resolve(
    request: FastifyRequest,
    workspaceSlug: string,
    hostAppSlug: string | null,
    envSlug: string
  ): Promise<Resolved> {
    return withSpan(
      'harmoniq.manifest.resolve',
      {
        'harmoniq.workspace': workspaceSlug,
        'harmoniq.host_app': hostAppSlug ?? '(default)',
        'harmoniq.environment': envSlug,
      },
      () => resolveVariant(request, workspaceSlug, hostAppSlug, envSlug)
    );
  }

  async function resolveVariant(
    request: FastifyRequest,
    workspaceSlug: string,
    hostAppSlug: string | null,
    envSlug: string
  ): Promise<Resolved> {
    const stable = await resolveStable(workspaceSlug, hostAppSlug, envSlug);
    const canaries = stable.built.canaries;
    const userKey = userKeyFrom(request.headers);
    const attributes = attributesFrom(request.headers, userKey);
    if (!canaries || !Object.keys(attributes).length) return stable;

    const cohortId = userKey ? cohortIdFor(canaries.workspaceId, userKey) : null;
    const assigned = assignCanaries(canaries.running, cohortId, attributes);
    const withCohort = cohortId ? { cohortId } : {};
    if (!assigned.length || stable.stale) return { ...stable, ...withCohort };

    const host = stable.built.manifest.hostApp.slug;
    const key = manifestKey(workspaceSlug, host, envSlug, variantKey(assigned));
    const cached = await cache.get(key);
    if (cached) {
      return { built: JSON.parse(cached) as BuiltManifest, stale: false, ...withCohort };
    }
    const variant = await once(key, async () => {
      try {
        const { built } = await load(
          workspaceSlug,
          host,
          envSlug,
          assigned.map((c) => c.moduleId)
        );
        await cache.set(key, JSON.stringify(built), MANIFEST_CACHE_TTL_SECONDS);
        return { built, stale: false };
      } catch (err) {
        // Stable beats broken: canary users fall back to the stable variant.
        logger.error('Canary variant build failed; serving stable', err as Error);
        return stable;
      }
    });
    return { ...variant, ...withCohort };
  }

  /** Refuses IPs over the not-found limit before any lookup, and counts not-found answers. */
  async function limitMisses(
    request: FastifyRequest,
    reply: FastifyReply,
    handle: () => Promise<FastifyReply>
  ) {
    const retryAfter = missRetryAfter(request.ip);
    if (retryAfter) {
      fastify.metricMeters.manifestRateLimited.add(1, { workspace: '' });
      return reply
        .code(429)
        .header('Retry-After', String(retryAfter))
        .send({
          error: {
            code: 'RATE_LIMITED',
            message: 'Too many requests for manifests that do not exist; try again later',
          },
        });
    }
    try {
      return await handle();
    } catch (err) {
      if (err instanceof NotFoundError) recordMiss(request.ip);
      throw err;
    }
  }

  async function serve(
    request: FastifyRequest<{ Querystring: { pretty?: string } }>,
    reply: FastifyReply,
    workspaceSlug: string,
    hostAppSlug: string | null,
    envSlug: string
  ) {
    return limitMisses(request, reply, async () =>
      send(request, reply, await resolve(request, workspaceSlug, hostAppSlug, envSlug))
    );
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
    return limitMisses(request, reply, async () => {
      // Import maps are loaded by the browser itself (no user header): always stable.
      const { built, stale } = await resolveStable(workspaceSlug, hostAppSlug, env);
      // Derived from the manifest ETag: changes exactly when the manifest does (IMP-04).
      const etag = `${built.etag}.${format}`;
      reply.header('ETag', `"${etag}"`);
      reply.header('Cache-Control', 'no-cache');
      if (stale) reply.header('X-Harmoniq-Stale', 'true');
      if (etagMatches(request.headers['if-none-match'], etag)) return reply.code(304).send();
      return reply.type(contentType).send(JSON.stringify(toBody(built.manifest)));
    });
  }

  // Public JSON Schema for validating manifests in other tools.
  const schema = manifestJsonSchema();
  fastify.get('/api/schema/manifest.json', async (_request, reply) =>
    reply
      .header('Cache-Control', 'public, max-age=3600')
      .type('application/schema+json')
      .send(schema)
  );

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
