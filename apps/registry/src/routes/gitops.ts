// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { FastifyPluginAsync } from 'fastify';
import { BadRequestError } from '@harmoniq/core/dist/errors/AppError';
import {
  GitOpsApplyRequestSchema,
  GitOpsConfigSchema,
} from '@harmoniq/core/dist/schemas/GitOpsConfigSchema';
import { audit } from '../services/audit';
import { invalidateDefaultHost, invalidateManifest } from '../services/cacheKeys';
import { exportConfig, reconcile } from '../services/gitops';
import { gitopsJsonSchema } from '../services/manifestJsonSchema';

type Params = { workspaceSlug: string };

// IaC-09..12: `harmoniq plan` / `apply` / `import` (workspace admins and admin keys).
const gitopsRoutes: FastifyPluginAsync = async (fastify) => {
  const { withTenant, systemDb, cache, publisher, webhooks } = fastify.container;
  const admin = { preHandler: fastify.requireWorkspace('workspace:admin') };

  fastify.post<{ Params: Params }>(
    '/api/workspaces/:workspaceSlug/apply',
    admin,
    async (request) => {
      const workspace = request.workspace!;
      const body = GitOpsApplyRequestSchema.parse(request.body ?? {});
      const parsed = GitOpsConfigSchema.safeParse(body.config);
      if (!parsed.success) {
        throw new BadRequestError('harmoniq.yaml is not valid', {
          issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(file)'}: ${i.message}`),
        });
      }
      // PLN-03: declaring approval policies needs the plan that has them.
      if (parsed.data.hostApps?.some((h) => h.environments?.some((e) => e.approvalPolicy))) {
        await fastify.container.plans.requireForWorkspace(workspace.id, 'approvals');
      }
      const outcome = await withTenant(
        workspace.id,
        async (tx) => {
          const result = await reconcile(
            tx,
            {
              workspaceId: workspace.id,
              workspaceSlug: workspace.slug,
              actorId: request.principal!.id,
              encryptionKey: fastify.config.encryptionKey,
              dryRun: body.dryRun,
              prune: body.prune,
            },
            parsed.data
          );
          const applied = result.changes.filter((c) => !c.blocked);
          if (!body.dryRun && applied.length) {
            await audit(
              tx,
              workspace.id,
              { principal: request.principal!, ip: request.ip },
              {
                action: 'gitops.apply',
                resourceType: 'workspace',
                resourceId: workspace.id,
                // Keys and field names only; secrets never.
                metadata: { prune: body.prune, changes: applied },
              }
            );
          }
          return result;
        },
        { timeout: 30_000 }
      );

      if (!body.dryRun) {
        // Host apps may have been created, deleted or made the default (legacy endpoint).
        if (outcome.changes.some((c) => c.type === 'hostApp' && !c.blocked)) {
          await invalidateDefaultHost(cache, workspace.slug);
        }
        // Manifests and import maps of changed host apps (e.g. a new specifier).
        for (const slug of outcome.touchedHostApps) {
          const envs = await systemDb.environment.findMany({
            where: { hostApp: { workspaceId: workspace.id, slug } },
          });
          for (const env of envs) {
            await invalidateManifest(cache, workspace.slug, slug, env.slug);
            await publisher.publish(env.id).catch(() => undefined); // recorded on the environment
          }
        }
        for (const f of outcome.freezes) {
          await webhooks.dispatch(workspace.id, f.frozen ? 'env.frozen' : 'env.unfrozen', {
            workspace: workspace.slug,
            hostApp: f.hostApp,
            environment: f.environment,
            ...(f.reason && { reason: f.reason }),
          });
        }
      }

      const count = (action: string) =>
        outcome.changes.filter((c) => c.action === action && !c.blocked).length;
      return {
        dryRun: body.dryRun,
        prune: body.prune,
        changes: outcome.changes,
        summary: {
          create: count('create'),
          update: count('update'),
          delete: count('delete'),
          blocked: outcome.changes.filter((c) => c.blocked).length,
        },
        // Generated webhook secrets, shown once.
        ...(Object.keys(outcome.secrets).length && { secrets: outcome.secrets }),
      };
    }
  );

  // IaC-09: for editors (`yaml-language-server`) and CI validation.
  const schema = gitopsJsonSchema();
  fastify.get('/api/schema/harmoniq.json', async (_request, reply) =>
    reply.header('Cache-Control', 'public, max-age=3600').send(schema)
  );

  /** IaC-12: the current state as a `harmoniq.yaml` document (JSON). */
  fastify.get<{ Params: Params }>(
    '/api/workspaces/:workspaceSlug/config',
    admin,
    async (request) => {
      const workspace = request.workspace!;
      return withTenant(workspace.id, (tx) => exportConfig(tx, workspace));
    }
  );
};

export default gitopsRoutes;
