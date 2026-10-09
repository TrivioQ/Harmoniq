import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { BadRequestError, NotFoundError } from '@harmoniq/core/dist/errors/AppError';
import { HealthReportSchema } from '@harmoniq/core/dist/schemas/HealthReportSchema';
import { findEnvironment, resolveModule } from '../services/modules';
import {
  HEALTH_WINDOW_MS,
  LiveVersionsCache,
  acceptEvents,
  hourlySeries,
  topErrors,
  trendOf,
  windowStats,
} from '../services/health';

type IngestParams = { workspaceSlug: string; hostAppSlug: string; env: string };

const healthRoutes: FastifyPluginAsync = async (fastify) => {
  const { systemDb, withTenant } = fastify.container;
  const live = new LiveVersionsCache(systemDb, withTenant);

  // HLT-01: public, like the manifest. Browsers send it with navigator.sendBeacon as
  // text/plain (no CORS preflight), so both JSON and text bodies are accepted.
  fastify.post<{ Params: IngestParams }>(
    '/api/health/:workspaceSlug/:hostAppSlug/:env',
    {
      bodyLimit: 64 * 1024,
      config: {
        rateLimit: {
          max: 120,
          timeWindow: '1 minute',
          keyGenerator: (req: FastifyRequest) =>
            `health:${(req.params as IngestParams).workspaceSlug}:${req.ip}`,
        },
      },
    },
    async (request, reply) => {
      let body: unknown = request.body;
      if (typeof body === 'string') {
        try {
          body = JSON.parse(body);
        } catch {
          throw new BadRequestError('Body must be JSON');
        }
      }
      const report = HealthReportSchema.parse(body);
      const { workspaceSlug, hostAppSlug, env } = request.params;
      let target = await live.get(workspaceSlug, hostAppSlug, env);
      if (!target) throw new NotFoundError('Environment not found');

      let { rows, rejected } = acceptEvents(target, report.events, report.client);
      if (rejected) {
        // Maybe a version deployed since the cache was filled: look again (at most every 2s).
        target = (await live.get(workspaceSlug, hostAppSlug, env, 2_000)) ?? target;
        ({ rows, rejected } = acceptEvents(target, report.events, report.client));
      }
      if (rows.length) {
        await withTenant(target.workspaceId, (tx) =>
          tx.moduleHealthEvent.createMany({ data: rows })
        );
      }
      return reply.code(202).send({ accepted: rows.length, rejected });
    }
  );

  // HLT-02/03: the last 5 minutes per variant, with trend, top errors and 24h of hours.
  fastify.get<{
    Params: { workspaceSlug: string; moduleRef: string };
    Querystring: { environment?: string };
  }>(
    '/api/workspaces/:workspaceSlug/modules/:moduleRef/health',
    { preHandler: fastify.requireWorkspace('workspace:read') },
    async (request) => {
      if (!request.query.environment) throw new BadRequestError('environment is required');
      return withTenant(request.workspace!.id, async (tx) => {
        const module = await resolveModule(tx, request.params.moduleRef);
        const env = findEnvironment(module, request.query.environment!);
        const to = new Date();
        const from = new Date(to.getTime() - HEALTH_WINDOW_MS);
        const previousFrom = new Date(from.getTime() - HEALTH_WINDOW_MS);

        const hourlySince = new Date(to.getTime() - 24 * 3_600_000);
        const [current, previous, errors, hourly] = await Promise.all([
          windowStats(tx, module.id, env.id, from, to),
          windowStats(tx, module.id, env.id, previousFrom, from),
          topErrors(tx, module.id, env.id, from),
          hourlySeries(tx, hourlySince, {
            moduleId: module.id,
            environmentId: env.id,
          }),
        ]);
        return {
          module: module.slug,
          environment: env.slug,
          windowMinutes: HEALTH_WINDOW_MS / 60_000,
          from: from.toISOString(),
          to: to.toISOString(),
          ...current.overall,
          trend: trendOf(current.overall, previous.overall),
          variants: current.variants,
          topErrors: errors,
          hourlySince: hourlySince.toISOString(),
          hourly: hourly.map(({ hour, sampleCount, errorCount }) => ({
            hour,
            sampleCount,
            errorCount,
          })),
        };
      });
    }
  );

  // HLT-04: hourly series for every module and environment (sparklines).
  fastify.get<{ Params: { workspaceSlug: string }; Querystring: { hours?: string } }>(
    '/api/workspaces/:workspaceSlug/health',
    { preHandler: fastify.requireWorkspace('workspace:read') },
    async (request) => {
      const hours = Math.min(Math.max(Number(request.query.hours) || 24, 1), 24 * 30);
      const since = new Date(Date.now() - hours * 3_600_000);
      return withTenant(request.workspace!.id, async (tx) => {
        const [points, environments] = await Promise.all([
          hourlySeries(tx, since),
          tx.environment.findMany({ select: { id: true, slug: true } }),
        ]);
        const envSlug = new Map(environments.map((e) => [e.id, e.slug]));
        const series = new Map<
          string,
          { moduleId: string; environment: string; hourly: object[] }
        >();
        for (const p of points) {
          const key = `${p.moduleId}:${p.environmentId}`;
          const entry = series.get(key) ?? {
            moduleId: p.moduleId,
            environment: envSlug.get(p.environmentId) ?? p.environmentId,
            hourly: [],
          };
          entry.hourly.push({ hour: p.hour, sampleCount: p.sampleCount, errorCount: p.errorCount });
          series.set(key, entry);
        }
        return { since: since.toISOString(), hours, series: [...series.values()] };
      });
    }
  );
};

export default healthRoutes;
