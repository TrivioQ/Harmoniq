// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { FastifyPluginAsync } from 'fastify';
import { reportDays, sendUsageCsv, workspaceUsage } from '../services/usageReport';

/** USG-03: a workspace's usage against its quotas, with daily history (admins). */
const usageRoutes: FastifyPluginAsync = async (fastify) => {
  const { withTenant, plans, quotas } = fastify.container;

  fastify.get<{
    Params: { workspaceSlug: string };
    Querystring: { days?: string; format?: string };
  }>(
    '/api/workspaces/:workspaceSlug/usage',
    { preHandler: fastify.requireWorkspace('workspace:admin') },
    async (request, reply) => {
      const workspace = request.workspace!;
      const days = reportDays(request.query.days);
      const usage = await withTenant(workspace.id, (tx) =>
        workspaceUsage({ plans, quotas }, tx, [workspace], days)
      );
      if (request.query.format === 'csv') return sendUsageCsv(reply, workspace.slug, usage);
      return { days, workspace: usage[0], warnAt: 0.8 };
    }
  );
};

export default usageRoutes;
