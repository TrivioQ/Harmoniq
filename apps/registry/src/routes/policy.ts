// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { Prisma } from '@prisma/client';
import type { TenantTx } from '@harmoniq/db';
import { BadRequestError, ConflictError, NotFoundError } from '@harmoniq/core/dist/errors/AppError';
import {
  OrgFreezeOverrideSchema,
  OrgPolicySchema,
} from '@harmoniq/core/dist/schemas/OrgPolicySchema';
import {
  activeOrgFreeze,
  approvalDefaultFor,
  effectiveApproval,
  freezeWindows,
  ipAllowed,
  normalizePolicy,
  orgPolicyFor,
  policyChanges,
  policyDto,
} from '../services/policy';

type OrgParams = { orgSlug: string };
type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
type OrgAudit = (
  request: FastifyRequest,
  event: {
    action: string;
    resourceType: string;
    resourceId: string;
    metadata?: Record<string, unknown>;
  },
  tx?: TenantTx
) => Promise<unknown>;

/** POL-01, POL-05: the organization's policy and its freeze-window overrides. */
export function orgPolicyRoutes(
  fastify: FastifyInstance,
  deps: {
    admin: { preHandler: Handler };
    /** PPL-08: auditors read the policy. */
    reader: { preHandler: Handler };
    orgAudit: OrgAudit;
  }
) {
  const { withOrg } = fastify.container;
  const inOrg = <T>(request: FastifyRequest, fn: (tx: TenantTx) => Promise<T>) =>
    withOrg(request.org!.id, fn);

  fastify.get<{ Params: OrgParams }>('/api/orgs/:orgSlug/policy', deps.reader, async (request) => {
    const policy = await inOrg(request, (tx) => orgPolicyFor(tx, request.org!.id));
    return policyDto(policy);
  });

  fastify.put<{ Params: OrgParams }>('/api/orgs/:orgSlug/policy', deps.admin, async (request) => {
    const body = OrgPolicySchema.parse(request.body ?? {});
    const organizationId = request.org!.id;
    // POL-08: an allowlist that leaves out the admin saving it would lock them out.
    if (body.ipAllowlist.length && !ipAllowed(body.ipAllowlist, request.ip)) {
      throw new ConflictError(
        `The allowlist doesn't include your address (${request.ip}); saving it would lock you out`
      );
    }
    return inOrg(request, async (tx) => {
      const previous = await orgPolicyFor(tx, organizationId);
      const data = { ...normalizePolicy(body, previous), updatedBy: request.principal!.id };
      const saved = await tx.orgPolicy.upsert({
        where: { organizationId },
        create: { organizationId, ...data },
        update: data,
      });
      const after = policyDto(saved);
      const changes = policyChanges(policyDto(previous), after);
      if (Object.keys(changes).length) {
        // POL-01: every changed field, before and after.
        await deps.orgAudit(
          request,
          {
            action: 'org.policy_updated',
            resourceType: 'org_policy',
            resourceId: organizationId,
            metadata: { changes },
          },
          tx
        );
      }
      return after;
    }).finally(() => fastify.forgetOrgPolicy(organizationId));
  });

  /**
   * POL-05: an org admin lets changes through an org freeze window until `until`, for a
   * reason (ENV-FRZ-03 semantics: every change made through it records the override).
   */
  fastify.post<{ Params: OrgParams & { windowId: string } }>(
    '/api/orgs/:orgSlug/policy/freeze-windows/:windowId/override',
    deps.admin,
    async (request) => {
      const { until, reason } = OrgFreezeOverrideSchema.parse(request.body);
      if (until <= new Date()) throw new BadRequestError('`until` must be in the future');
      return setOverride(request, {
        until: until.toISOString(),
        reason,
        by: request.principal!.id,
      });
    }
  );

  fastify.delete<{ Params: OrgParams & { windowId: string } }>(
    '/api/orgs/:orgSlug/policy/freeze-windows/:windowId/override',
    deps.admin,
    async (request) => setOverride(request, null)
  );

  async function setOverride(
    request: FastifyRequest<{ Params: OrgParams & { windowId: string } }>,
    override: { until: string; reason: string; by: string } | null
  ) {
    const organizationId = request.org!.id;
    return inOrg(request, async (tx) => {
      const policy = await orgPolicyFor(tx, organizationId);
      const windows = freezeWindows(policy);
      const window = windows.find((w) => w.id === request.params.windowId);
      if (!policy || !window) throw new NotFoundError('Freeze window not found');
      window.override = override;
      await tx.orgPolicy.update({
        where: { organizationId },
        data: { freezeWindows: windows as unknown as Prisma.InputJsonValue },
      });
      await deps.orgAudit(
        request,
        {
          action: override ? 'org.freeze_override' : 'org.freeze_override_end',
          resourceType: 'org_policy',
          resourceId: organizationId,
          metadata: {
            window: window.id,
            environmentPattern: window.environmentPattern,
            freezeReason: window.reason,
            ...(override && { until: override.until, reason: override.reason }),
          },
        },
        tx
      );
      return window;
    });
  }
}

/** POL-09: what a workspace actually enforces, and where each value comes from. */
const workspacePolicyRoutes: FastifyPluginAsync = async (fastify) => {
  const { withTenant } = fastify.container;

  fastify.get<{ Params: { workspaceSlug: string } }>(
    '/api/workspaces/:workspaceSlug/policy',
    { preHandler: fastify.requireWorkspace('workspace:read') },
    async (request) => {
      const workspace = request.workspace!;
      const data = await withTenant(workspace.id, async (tx) => ({
        org: await orgPolicyFor(tx, workspace.organizationId),
        row: await tx.workspace.findUniqueOrThrow({
          where: { id: workspace.id },
          select: { retentionDays: true },
        }),
        own: await tx.approvalPolicy.findMany(),
        envs: await tx.environment.findMany({
          select: { id: true, slug: true, hostApp: { select: { slug: true } } },
          orderBy: [{ hostApp: { slug: 'asc' } }, { slug: 'asc' }],
        }),
        sso: await tx.workspaceConfig.findUnique({
          where: { workspaceId: workspace.id },
          select: { oidcConfig: true, samlConfig: true },
        }),
      }));
      const org = data.org;
      const floor = org?.minRetentionDays ?? null;
      const now = new Date();
      const from = (value: unknown): 'organization' | null =>
        value === null || value === undefined || (Array.isArray(value) && !value.length)
          ? null
          : 'organization';

      return {
        organization: workspace.organizationId ? { id: workspace.organizationId } : null,
        retentionDays: {
          value: Math.max(data.row.retentionDays, floor ?? 0),
          workspace: data.row.retentionDays,
          minimum: floor,
          source: floor && floor > data.row.retentionDays ? 'organization' : 'workspace',
        },
        approvals: data.envs.map((env) => {
          const own = data.own.find((p) => p.environmentId === env.id) ?? null;
          const effective = effectiveApproval(own, approvalDefaultFor(org, env.slug));
          return {
            hostApp: env.hostApp.slug,
            environment: env.slug,
            policy: effective?.rule ?? null,
            source: effective?.source ?? null,
            locked: !!approvalDefaultFor(org, env.slug),
          };
        }),
        freezes: data.envs.flatMap((env) => {
          const active = activeOrgFreeze(org, env.slug, now);
          return active
            ? [
                {
                  hostApp: env.hostApp.slug,
                  environment: env.slug,
                  windowId: active.window.id,
                  reason: active.window.reason,
                  until: active.window.until ?? null,
                  override: active.overridden ? active.window.override : null,
                  source: 'organization' as const,
                },
              ]
            : [];
        }),
        apiKeys: {
          maxDays: { value: org?.maxApiKeyDays ?? null, source: from(org?.maxApiKeyDays) },
          allowedScopes: {
            value: org?.allowedKeyScopes ?? [],
            source: from(org?.allowedKeyScopes),
          },
        },
        sso: {
          locked: !!org?.lockSso,
          ownConfigured: !!(data.sso?.oidcConfig || data.sso?.samlConfig),
          source: org?.lockSso ? 'organization' : 'workspace',
        },
        session: {
          maxHours: { value: org?.sessionMaxHours ?? null, source: from(org?.sessionMaxHours) },
          idleTimeoutMinutes: {
            value: org?.idleTimeoutMinutes ?? null,
            source: from(org?.idleTimeoutMinutes),
          },
        },
        ipAllowlist: {
          value: org?.ipAllowlist ?? [],
          manifests: org?.ipAllowlistManifests ?? false,
          source: from(org?.ipAllowlist),
        },
      };
    }
  );
};

export default workspacePolicyRoutes;
