// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { FastifyPluginAsync } from 'fastify';
import { audit } from '../services/audit';
import { sendTenantExport, workspaceRecords } from '../services/tenantExport';

/**
 * TLC-07: a workspace's data as a JSON Lines download (config, members, modules,
 * versions, audit log), for exit, backup or review. Workspace admins; each export is
 * itself audited.
 */
const exportRoutes: FastifyPluginAsync = async (fastify) => {
  const { withTenant } = fastify.container;

  fastify.get<{ Params: { workspaceSlug: string } }>(
    '/api/workspaces/:workspaceSlug/export',
    { preHandler: fastify.requireWorkspace('workspace:admin') },
    async (request, reply) => {
      const workspace = request.workspace!;
      await withTenant(workspace.id, (tx) =>
        audit(
          tx,
          workspace.id,
          { principal: request.principal!, ip: request.ip },
          { action: 'workspace.export', resourceType: 'workspace', resourceId: workspace.id }
        )
      );
      return sendTenantExport(
        reply,
        { kind: 'workspace', slug: workspace.slug },
        workspaceRecords((fn) => withTenant(workspace.id, fn), workspace)
      );
    }
  );
};

export default exportRoutes;
