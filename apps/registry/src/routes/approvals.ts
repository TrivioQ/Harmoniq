import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ApprovalPolicy, DeploymentApproval, DeploymentRequest } from '@prisma/client';
import { ConflictError, ForbiddenError, NotFoundError } from '@harmoniq/core/dist/errors/AppError';
import { ApprovalPolicySchema } from '@harmoniq/core/dist/schemas/ApprovalPolicySchema';
import {
  ApprovalBypassSchema,
  ApprovalDecisionSchema,
} from '@harmoniq/core/dist/schemas/ApprovalDecisionSchema';
import { audit } from '../services/audit';
import { claim, decisionEligibility, executeRequest } from '../services/approvals';

type EnvParams = { workspaceSlug: string; hostAppSlug: string; envSlug: string };
type RequestParams = { workspaceSlug: string; requestId: string };

function policyDto(p: ApprovalPolicy, env?: { slug: string; hostApp: string }) {
  return {
    id: p.id,
    environmentId: p.environmentId,
    ...(env && { environment: env.slug, hostApp: env.hostApp }),
    requiredApprovers: p.requiredApprovers,
    eligibleRoles: p.eligibleRoles,
    requireChangeTicket: p.requireChangeTicket,
    ticketUrlPattern: p.ticketUrlPattern,
    expiryHours: p.expiryHours,
  };
}

// APR-01..18: approval policies per environment and the requests they create.
const approvalRoutes: FastifyPluginAsync = async (fastify) => {
  const { withTenant, webhooks } = fastify.container;
  const actor = (request: FastifyRequest) => ({ principal: request.principal!, ip: request.ip });

  async function findEnv(request: FastifyRequest<{ Params: EnvParams }>) {
    const workspace = request.workspace!;
    return withTenant(workspace.id, async (tx) => {
      const env = await tx.environment.findFirst({
        where: {
          slug: request.params.envSlug,
          hostApp: { workspaceId: workspace.id, slug: request.params.hostAppSlug },
        },
      });
      if (!env) throw new NotFoundError('Environment not found');
      return env;
    });
  }

  // ─── Policies (APR-01..03, 13) ────────────────────────────────────────────

  fastify.get<{ Params: { workspaceSlug: string } }>(
    '/api/workspaces/:workspaceSlug/approval-policies',
    { preHandler: fastify.requireWorkspace('workspace:read') },
    async (request) => {
      const workspace = request.workspace!;
      return withTenant(workspace.id, async (tx) => {
        const [policies, envs] = await Promise.all([
          tx.approvalPolicy.findMany(),
          tx.environment.findMany({ include: { hostApp: { select: { slug: true } } } }),
        ]);
        return {
          policies: policies.map((p) => {
            const env = envs.find((e) => e.id === p.environmentId);
            return policyDto(p, env && { slug: env.slug, hostApp: env.hostApp.slug });
          }),
        };
      });
    }
  );

  const policyPath =
    '/api/workspaces/:workspaceSlug/host-apps/:hostAppSlug/environments/:envSlug/approval-policy';

  fastify.put<{ Params: EnvParams }>(
    policyPath,
    { preHandler: fastify.requireWorkspace('workspace:admin') },
    async (request) => {
      const body = ApprovalPolicySchema.parse(request.body);
      const env = await findEnv(request);
      const workspace = request.workspace!;
      await fastify.container.plans.requireForWorkspace(workspace.id, 'approvals');
      return withTenant(workspace.id, async (tx) => {
        const data = { ...body, ticketUrlPattern: body.ticketUrlPattern ?? null };
        const policy = await tx.approvalPolicy.upsert({
          where: {
            workspaceId_environmentId: { workspaceId: workspace.id, environmentId: env.id },
          },
          create: { workspaceId: workspace.id, environmentId: env.id, ...data },
          update: data,
        });
        await audit(tx, workspace.id, actor(request), {
          action: 'approval_policy.set',
          resourceType: 'approvalPolicy',
          resourceId: policy.id,
          metadata: { environment: env.slug, ...body },
        });
        return policyDto(policy, { slug: env.slug, hostApp: request.params.hostAppSlug });
      });
    }
  );

  fastify.delete<{ Params: EnvParams }>(
    policyPath,
    { preHandler: fastify.requireWorkspace('workspace:admin') },
    async (request, reply) => {
      const env = await findEnv(request);
      const workspace = request.workspace!;
      await withTenant(workspace.id, async (tx) => {
        const { count } = await tx.approvalPolicy.deleteMany({ where: { environmentId: env.id } });
        if (!count) throw new NotFoundError('No approval policy for this environment');
        await audit(tx, workspace.id, actor(request), {
          action: 'approval_policy.delete',
          resourceType: 'environment',
          resourceId: env.id,
          metadata: { environment: env.slug },
        });
      });
      return reply.code(204).send();
    }
  );

  // ─── Requests (APR-04..18) ────────────────────────────────────────────────

  async function requestDto(
    request: FastifyRequest,
    dr: DeploymentRequest & { DeploymentApprovals: DeploymentApproval[] },
    names: {
      modules: Map<string, string>;
      envs: Map<string, string>;
      users: Map<string, string>;
    }
  ) {
    const eligibility = await decisionEligibility(fastify, request, dr);
    return {
      id: dr.id,
      type: dr.type,
      module: names.modules.get(dr.moduleId) ?? dr.moduleId,
      environment: names.envs.get(dr.environmentId) ?? dr.environmentId,
      status: dr.status,
      requestedBy: {
        type: dr.requestedByType,
        id: dr.requestedBy,
        email: names.users.get(dr.requestedBy) ?? null,
      },
      request: dr.payload,
      requiredApprovers: dr.requiredApprovers,
      approvals: dr.DeploymentApprovals.map((a) => ({
        approverId: a.approverId,
        approverEmail: names.users.get(a.approverId) ?? null,
        decision: a.decision,
        comment: a.comment,
        decidedAt: a.decidedAt.toISOString(),
      })),
      changeTicket: dr.changeTicketId ? { id: dr.changeTicketId, url: dr.changeTicketUrl } : null,
      bypassed: dr.bypassed,
      bypassJustification: dr.bypassJustification,
      expiresAt: dr.expiresAt.toISOString(),
      resolvedAt: dr.resolvedAt?.toISOString() ?? null,
      result: dr.result,
      createdAt: dr.createdAt.toISOString(),
      // APR-16: whether you can decide on it now, and if not why.
      canDecide: eligibility.eligible,
      ...(!eligibility.eligible &&
        dr.status === 'pending_approval' && {
          cannotDecideBecause: eligibility.reason,
        }),
    };
  }

  async function names(workspaceId: string) {
    return withTenant(workspaceId, async (tx) => {
      const [modules, envs, members] = await Promise.all([
        tx.remoteModule.findMany({ select: { id: true, slug: true } }),
        tx.environment.findMany({ select: { id: true, slug: true } }),
        tx.workspaceMember.findMany({ include: { user: { select: { id: true, email: true } } } }),
      ]);
      return {
        modules: new Map(modules.map((m) => [m.id, m.slug])),
        envs: new Map(envs.map((e) => [e.id, e.slug])),
        users: new Map(members.map((m) => [m.user.id, m.user.email])),
      };
    });
  }

  async function loadRequest(request: FastifyRequest<{ Params: RequestParams }>) {
    const dr = await withTenant(request.workspace!.id, (tx) =>
      tx.deploymentRequest.findUnique({
        where: { id: request.params.requestId },
        include: { DeploymentApprovals: true },
      })
    );
    if (!dr) throw new NotFoundError('Approval request not found');
    return dr;
  }

  async function reload(request: FastifyRequest<{ Params: RequestParams }>) {
    return requestDto(request, await loadRequest(request), await names(request.workspace!.id));
  }

  fastify.get<{ Params: { workspaceSlug: string }; Querystring: { status?: string } }>(
    '/api/workspaces/:workspaceSlug/approvals',
    { preHandler: fastify.requireWorkspace('workspace:read') },
    async (request) => {
      const workspace = request.workspace!;
      const requests = await withTenant(workspace.id, (tx) =>
        tx.deploymentRequest.findMany({
          where: request.query.status ? { status: request.query.status } : {},
          include: { DeploymentApprovals: { orderBy: { decidedAt: 'asc' } } },
          orderBy: { createdAt: 'desc' },
          take: 100,
        })
      );
      const n = await names(workspace.id);
      return { requests: await Promise.all(requests.map((dr) => requestDto(request, dr, n))) };
    }
  );

  fastify.get<{ Params: RequestParams }>(
    '/api/workspaces/:workspaceSlug/approvals/:requestId',
    { preHandler: fastify.requireWorkspace('workspace:read') },
    (request) => reload(request)
  );

  async function decide(request: FastifyRequest<{ Params: RequestParams }>, approve: boolean) {
    const { comment } = ApprovalDecisionSchema.parse(request.body ?? {});
    const workspace = request.workspace!;
    const dr = await loadRequest(request);
    const eligibility = await decisionEligibility(fastify, request, dr);
    if (!eligibility.eligible) {
      throw dr.status === 'pending_approval'
        ? new ForbiddenError(eligibility.reason!)
        : new ConflictError(eligibility.reason!);
    }
    const approvals = await withTenant(workspace.id, async (tx) => {
      await tx.deploymentApproval.create({
        data: {
          deploymentRequestId: dr.id,
          approverId: request.principal!.id,
          decision: approve ? 'approved' : 'rejected',
          comment,
        },
      });
      await audit(tx, workspace.id, actor(request), {
        action: approve ? 'deploy.approve' : 'deploy.reject',
        resourceType: 'deploymentRequest',
        resourceId: dr.id,
        metadata: { type: dr.type, ...(comment && { comment }) },
      });
      return tx.deploymentApproval.count({
        where: { deploymentRequestId: dr.id, decision: 'approved' },
      });
    });

    if (!approve) {
      // APR-08: one rejection ends it.
      await withTenant(workspace.id, (tx) =>
        tx.deploymentRequest.updateMany({
          where: { id: dr.id, status: 'pending_approval' },
          data: { status: 'rejected', resolvedAt: new Date(), resolvedBy: request.principal!.id },
        })
      );
      await webhooks.dispatch(workspace.id, 'deploy.rejected', {
        requestId: dr.id,
        type: dr.type,
        rejectedBy: request.principal!.id,
        ...(comment && { comment }),
      });
    } else if (
      approvals >= dr.requiredApprovers &&
      (await claim(fastify, workspace.id, dr.id, { resolvedBy: request.principal!.id }))
    ) {
      // APR-07: exactly one approver gets here and runs it.
      const executed = await executeRequest(fastify, dr.id);
      await webhooks.dispatch(workspace.id, 'deploy.approved', {
        requestId: dr.id,
        type: dr.type,
        status: executed.status,
      });
    }
    return reload(request);
  }

  fastify.post<{ Params: RequestParams }>(
    '/api/workspaces/:workspaceSlug/approvals/:requestId/approve',
    { preHandler: fastify.requireWorkspace('workspace:read') },
    (request) => decide(request, true)
  );

  fastify.post<{ Params: RequestParams }>(
    '/api/workspaces/:workspaceSlug/approvals/:requestId/reject',
    { preHandler: fastify.requireWorkspace('workspace:read') },
    (request) => decide(request, false)
  );

  // APR-10/11: owners execute a pending request now, with a written justification.
  fastify.post<{ Params: RequestParams }>(
    '/api/workspaces/:workspaceSlug/approvals/:requestId/bypass',
    { preHandler: fastify.requireWorkspace('workspace:owner') },
    async (request) => {
      if (request.principal!.type !== 'user') {
        throw new ForbiddenError('Emergency bypass needs a signed-in owner');
      }
      const { bypassJustification } = ApprovalBypassSchema.parse(request.body);
      const workspace = request.workspace!;
      const dr = await loadRequest(request);
      const claimed = await claim(fastify, workspace.id, dr.id, {
        bypassed: true,
        bypassJustification,
        resolvedBy: request.principal!.id,
      });
      if (!claimed) throw new ConflictError(`The request is ${dr.status}`);
      await withTenant(workspace.id, (tx) =>
        audit(tx, workspace.id, actor(request), {
          action: 'deploy.emergency_bypass',
          resourceType: 'deploymentRequest',
          resourceId: dr.id,
          metadata: { type: dr.type, justification: bypassJustification, requestId: dr.id },
        })
      );
      const executed = await executeRequest(fastify, dr.id);
      await webhooks.dispatch(workspace.id, 'deploy.emergency_bypass', {
        requestId: dr.id,
        type: dr.type,
        bypassedBy: request.principal!.id,
        justification: bypassJustification,
        status: executed.status,
      });
      return reload(request);
    }
  );
};

export default approvalRoutes;
