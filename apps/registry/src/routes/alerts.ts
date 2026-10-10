// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { AlertRule, Environment, RemoteModule } from '@prisma/client';
import { NotFoundError } from '@harmoniq/core/dist/errors/AppError';
import {
  CreateAlertRuleSchema,
  UpdateAlertRuleSchema,
} from '@harmoniq/core/dist/schemas/AlertRuleSchema';
import { audit } from '../services/audit';
import { findEnvironment, resolveModule } from '../services/modules';

type RuleRow = AlertRule & { remoteModule: RemoteModule | null; environment: Environment | null };
type RuleParams = { workspaceSlug: string; ruleId: string };

const include = { remoteModule: true, environment: true } as const;

function ruleDto(r: RuleRow) {
  return {
    id: r.id,
    name: r.name,
    condition: r.condition,
    threshold: r.threshold,
    action: r.action,
    module: r.remoteModule ? { id: r.remoteModule.id, slug: r.remoteModule.slug } : null,
    environment: r.environment?.slug ?? null,
    windowMinutes: r.windowMinutes,
    minSamples: r.minSamples,
    cooldownMinutes: r.cooldownMinutes,
    enabled: r.enabled,
    state: r.state,
    lastValue: r.lastValue,
    lastEvaluatedAt: r.lastEvaluatedAt?.toISOString() ?? null,
    lastTriggeredAt: r.lastTriggeredAt?.toISOString() ?? null,
    lastError: r.lastError,
    createdAt: r.createdAt.toISOString(),
  };
}

// ALT-01: alert rules. Rules with `auto_rollback` change production, so writes need admin.
const alertRoutes: FastifyPluginAsync = async (fastify) => {
  const { withTenant } = fastify.container;
  const actor = (request: FastifyRequest) => ({ principal: request.principal!, ip: request.ip });

  fastify.get<{ Params: { workspaceSlug: string } }>(
    '/api/workspaces/:workspaceSlug/alerts',
    { preHandler: fastify.requireWorkspace('workspace:read') },
    async (request) => {
      const rules = await withTenant(request.workspace!.id, (tx) =>
        tx.alertRule.findMany({ include, orderBy: { createdAt: 'asc' } })
      );
      return { rules: rules.map(ruleDto) };
    }
  );

  fastify.post<{ Params: { workspaceSlug: string } }>(
    '/api/workspaces/:workspaceSlug/alerts',
    { preHandler: fastify.requireWorkspace('workspace:admin') },
    async (request, reply) => {
      const body = CreateAlertRuleSchema.parse(request.body);
      const workspace = request.workspace!;
      const rule = await withTenant(workspace.id, async (tx) => {
        const module = body.module ? await resolveModule(tx, body.module) : null;
        const environment =
          module && body.environment ? findEnvironment(module, body.environment) : null;
        const created = await tx.alertRule.create({
          data: {
            workspaceId: workspace.id,
            name: body.name,
            condition: body.condition,
            threshold: body.threshold,
            action: body.action,
            actionConfig: {},
            remoteModuleId: module?.id,
            environmentId: environment?.id,
            windowMinutes: body.windowMinutes,
            minSamples: body.minSamples,
            cooldownMinutes: body.cooldownMinutes,
            enabled: body.enabled,
          },
          include,
        });
        await audit(tx, workspace.id, actor(request), {
          action: 'alert.create',
          resourceType: 'alertRule',
          resourceId: created.id,
          metadata: { name: body.name, condition: body.condition, action: body.action },
        });
        return created;
      });
      return reply.code(201).send(ruleDto(rule));
    }
  );

  fastify.patch<{ Params: RuleParams }>(
    '/api/workspaces/:workspaceSlug/alerts/:ruleId',
    { preHandler: fastify.requireWorkspace('workspace:admin') },
    async (request) => {
      const body = UpdateAlertRuleSchema.parse(request.body);
      const workspace = request.workspace!;
      const rule = await withTenant(workspace.id, async (tx) => {
        const existing = await tx.alertRule.findUnique({ where: { id: request.params.ruleId } });
        if (!existing) throw new NotFoundError('Alert rule not found');
        const updated = await tx.alertRule.update({
          where: { id: existing.id },
          // Disabling resets the state, so re-enabling starts from a clean slate.
          data: { ...body, ...(body.enabled === false && { state: 'ok' }) },
          include,
        });
        await audit(tx, workspace.id, actor(request), {
          action: 'alert.update',
          resourceType: 'alertRule',
          resourceId: existing.id,
          metadata: body,
        });
        return updated;
      });
      return ruleDto(rule);
    }
  );

  fastify.delete<{ Params: RuleParams }>(
    '/api/workspaces/:workspaceSlug/alerts/:ruleId',
    { preHandler: fastify.requireWorkspace('workspace:admin') },
    async (request, reply) => {
      const workspace = request.workspace!;
      await withTenant(workspace.id, async (tx) => {
        const existing = await tx.alertRule.findUnique({ where: { id: request.params.ruleId } });
        if (!existing) throw new NotFoundError('Alert rule not found');
        await tx.alertRule.delete({ where: { id: existing.id } });
        await audit(tx, workspace.id, actor(request), {
          action: 'alert.delete',
          resourceType: 'alertRule',
          resourceId: existing.id,
          metadata: { name: existing.name },
        });
      });
      return reply.code(204).send();
    }
  );
};

export default alertRoutes;
