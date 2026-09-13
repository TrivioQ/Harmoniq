import { FastifyPluginAsync } from 'fastify';

const manifestRoutes: FastifyPluginAsync = async (fastify, options) => {
  
  // HST-01: Canonical GET /api/manifest/:workspaceSlug/:hostAppSlug/:env
  fastify.get<{
    Params: { workspaceSlug: string, hostAppSlug: string, env: string }
  }>('/api/manifest/:workspaceSlug/:hostAppSlug/:env', async (request, reply) => {
    const { workspaceSlug, hostAppSlug, env } = request.params;
    const cacheKey = `manifest:${workspaceSlug}:${hostAppSlug}:${env}`;

    try {
      // 1. Check cache
      const cached = await fastify.container.cache.get(cacheKey);
      if (cached) {
        fastify.metricMeters.manifestCacheHits.add(1);
        const manifestObj = JSON.parse(cached);
        // ETag handling
        const etag = manifestObj.integrity || 'W/\"cached\"'; // Simplification for now
        if (request.headers['if-none-match'] === etag) {
          reply.code(304).send();
          return;
        }

        reply.header('ETag', etag);
        reply.header('Cache-Control', 'no-cache');
        reply.header('X-Harmoniq-Variant', 'stable');
        return reply.send(manifestObj);
      }

      // 2. Cache miss -> DB Query
      fastify.metricMeters.manifestCacheMisses.add(1);
      
      // Find workspace
      const workspace = await fastify.container.db.workspace.findUnique({
        where: { slug: workspaceSlug },
        include: {
          HostApps: {
            where: { slug: hostAppSlug },
            include: {
              Environments: {
                where: { slug: env }
              }
            }
          }
        }
      });

      if (!workspace || workspace.HostApps.length === 0 || workspace.HostApps[0].Environments.length === 0) {
        reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Manifest not found' } });
        return;
      }

      const hostApp = workspace.HostApps[0];
      const environment = hostApp.Environments[0];

      // Get active module versions
      const activeVersions = await fastify.container.db.moduleVersion.findMany({
        where: {
          workspaceId: workspace.id,
          environmentId: environment.id,
          status: 'active'
        },
        include: {
          remoteModule: true
        }
      });

      // Build manifest JSON
      const manifest = {
        schemaVersion: 2,
        hostApp: hostApp.slug,
        environment: environment.slug,
        modules: activeVersions.reduce((acc, v) => {
          acc[v.remoteModule.slug] = {
            version: v.version,
            url: v.url,
            integrity: v.integrity
          };
          return acc;
        }, {} as Record<string, any>),
        timestamp: new Date().toISOString()
      };

      const manifestStr = JSON.stringify(manifest);
      
      // We should really generate a real ETag hash here.
      // Using a simple Base64 or hash would be better, but for MVP:
      const etag = `W/"${Buffer.from(manifestStr).toString('base64').substring(0, 27)}"`;
      
      // Save to cache
      await fastify.container.cache.set(cacheKey, JSON.stringify({ ...manifest, _etag: etag }), 3600);

      if (request.headers['if-none-match'] === etag) {
        reply.code(304).send();
        return;
      }

      reply.header('ETag', etag);
      reply.header('Cache-Control', 'no-cache');
      reply.header('X-Harmoniq-Variant', 'stable');
      return reply.send(manifest);

    } catch (error) {
      fastify.container.logger.error('Error fetching manifest', error as Error);
      reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Failed to build manifest' } });
    }
  });

};

export default manifestRoutes;
