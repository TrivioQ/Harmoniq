// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DeploymentRequest, Prisma } from '@prisma/client';
import { BadRequestError, NotFoundError } from '@harmoniq/core/dist/errors/AppError';
import { CHANGE_TICKET_HEADER } from '@harmoniq/core/dist/schemas/ApprovalPolicySchema';
import { audit } from './audit';
import { approvalsUrl } from './links';
import { approvalDefaultFor, effectiveApproval, orgPolicyFor } from './policy';

/** Marks the in-process execution of an approved request (trusted only when `internal`). */
export const APPROVED_REQUEST_HEADER = 'x-harmoniq-approved-request';

declare module 'fastify' {
  interface FastifyRequest {
    /** APR-18: set while executing an approved (or bypassed) request. */
    approvalContext?: Record<string, unknown>;
  }
}

export type ApprovalType =
  | 'deploy'
  | 'rollback'
  | 'promote'
  | 'canary_traffic'
  | 'canary_promote'
  | 'canary_abort'
  | 'canary_advance';

export interface PendingApproval {
  status: 'pending_approval';
  requestId: string;
  requiredApprovers: number;
  expiresAt: string;
  changeTicket: { id: string; url: string | null } | null;
  /** The dashboard's approval queue. */
  approvalUrl: string;
}

/**
 * APR-01, POL-02: the rule an environment enforces: its own policy tightened by the
 * organization's default for its slug (or the default alone). Null: no approval needed.
 */
export async function approvalRuleFor(
  tx: Prisma.TransactionClient,
  workspace: { id: string; organizationId: string | null },
  environmentId: string,
  environmentSlug: string
) {
  const [own, org] = await Promise.all([
    tx.approvalPolicy.findUnique({
      where: { workspaceId_environmentId: { workspaceId: workspace.id, environmentId } },
    }),
    orgPolicyFor(tx, workspace.organizationId),
  ]);
  return effectiveApproval(own, approvalDefaultFor(org, environmentSlug))?.rule ?? null;
}

const header = (request: FastifyRequest, name: string) => {
  const value = request.headers[name];
  return (Array.isArray(value) ? value[0] : value)?.trim() || undefined;
};

/**
 * APR-04: when the target environment has an approval policy, records the call as a
 * request and returns what to answer (202) instead of running it. Returns null when the
 * call may proceed: no policy, or this is the execution of an approved request.
 */
export async function interceptForApproval(
  app: FastifyInstance,
  request: FastifyRequest,
  change: { type: ApprovalType; moduleId: string; environmentId: string; environment: string }
): Promise<PendingApproval | null> {
  const workspace = request.workspace!;
  const principal = request.principal!;
  const { withTenant, webhooks } = app.container;

  const approvedId = header(request, APPROVED_REQUEST_HEADER);
  if (approvedId && request.internal) {
    const approved = await withTenant(workspace.id, (tx) =>
      tx.deploymentRequest.findUnique({
        where: { id: approvedId },
        include: { DeploymentApprovals: true },
      })
    );
    if (approved?.status === 'executing') {
      request.approvalContext = {
        requestId: approved.id,
        approvers: approved.DeploymentApprovals.filter((a) => a.decision === 'approved').map(
          (a) => a.approverId
        ),
        ...(approved.bypassed && { bypassed: true, justification: approved.bypassJustification }),
        ...(approved.changeTicketId && { changeTicket: approved.changeTicketId }),
      };
      return null;
    }
  }

  const policy = await withTenant(workspace.id, (tx) =>
    approvalRuleFor(tx, workspace, change.environmentId, change.environment)
  );
  if (!policy) return null;

  const ticketId = header(request, CHANGE_TICKET_HEADER)?.slice(0, 100);
  if (policy.requireChangeTicket && !ticketId) {
    throw new BadRequestError(
      `Changes to "${change.environment}" need a change ticket (header X-Harmoniq-Change-Ticket)`
    );
  }
  const ticketUrl =
    ticketId && policy.ticketUrlPattern
      ? policy.ticketUrlPattern.replace('{id}', encodeURIComponent(ticketId))
      : null;
  const expiresAt = new Date(Date.now() + policy.expiryHours * 3_600_000);

  const created = await withTenant(workspace.id, async (tx) => {
    const created = await tx.deploymentRequest.create({
      data: {
        workspaceId: workspace.id,
        moduleId: change.moduleId,
        environmentId: change.environmentId,
        type: change.type,
        requestedBy: principal.id,
        requestedByType: principal.type,
        method: request.method,
        path: request.url,
        payload: (request.body ?? {}) as Prisma.InputJsonValue,
        status: 'pending_approval',
        requiredApprovers: policy.requiredApprovers,
        changeTicketId: ticketId,
        changeTicketUrl: ticketUrl,
        expiresAt,
      },
    });
    await audit(
      tx,
      workspace.id,
      { principal, ip: request.ip },
      {
        action: 'deploy.approval_requested',
        resourceType: 'deploymentRequest',
        resourceId: created.id,
        metadata: {
          type: change.type,
          environment: change.environment,
          requiredApprovers: policy.requiredApprovers,
          ...(ticketId && { changeTicket: ticketId, changeTicketUrl: ticketUrl }),
        },
      }
    );
    return created;
  });

  // APR-17: eligible approvers are told through webhooks.
  await webhooks.dispatch(workspace.id, 'deploy.approval_requested', {
    requestId: created.id,
    type: change.type,
    environment: change.environment,
    requestedBy: principal.id,
    requiredApprovers: policy.requiredApprovers,
    eligibleRoles: policy.eligibleRoles,
    expiresAt: expiresAt.toISOString(),
    ...(ticketId && { changeTicket: ticketId, changeTicketUrl: ticketUrl }),
  });

  return {
    status: 'pending_approval',
    requestId: created.id,
    requiredApprovers: policy.requiredApprovers,
    expiresAt: expiresAt.toISOString(),
    changeTicket: ticketId ? { id: ticketId, url: ticketUrl } : null,
    approvalUrl: approvalsUrl(app.config, workspace.slug),
  };
}

/** Whether `request`'s user may decide on `dr` (APR-05/15). */
export async function decisionEligibility(
  app: FastifyInstance,
  request: FastifyRequest,
  dr: Pick<DeploymentRequest, 'environmentId' | 'requestedBy' | 'status' | 'id'>
): Promise<{ eligible: boolean; reason?: string }> {
  const principal = request.principal!;
  if (principal.type !== 'user')
    return { eligible: false, reason: 'Approvals need a signed-in user' };
  if (dr.status !== 'pending_approval')
    return { eligible: false, reason: `The request is ${dr.status}` };
  if (dr.requestedBy === principal.id) {
    return { eligible: false, reason: 'You cannot approve your own request' };
  }
  const workspace = request.workspace!;
  return app.container.withTenant(workspace.id, async (tx) => {
    const env = await tx.environment.findUnique({
      where: { id: dr.environmentId },
      select: { slug: true },
    });
    const policy = await approvalRuleFor(tx, workspace, dr.environmentId, env?.slug ?? '');
    const role = request.workspaceRole;
    if (!role || !(policy?.eligibleRoles ?? ['admin', 'owner']).includes(role)) {
      return { eligible: false, reason: 'Your role is not eligible to approve here' };
    }
    const decided = await tx.deploymentApproval.findUnique({
      where: {
        deploymentRequestId_approverId: { deploymentRequestId: dr.id, approverId: principal.id },
      },
    });
    return decided ? { eligible: false, reason: 'You already decided' } : { eligible: true };
  });
}

/**
 * APR-07: runs the stored call as the requester. Only the caller that moved the request
 * from `pending_approval` to `executing` gets here, so it runs exactly once.
 */
export async function executeRequest(app: FastifyInstance, id: string) {
  const { systemDb } = app.container;
  const dr = await systemDb.deploymentRequest.findUniqueOrThrow({ where: { id } });
  let statusCode = 0;
  let body: unknown = null;
  try {
    const res = await app.inject({
      method: dr.method as 'POST' | 'PUT',
      url: dr.path,
      payload: dr.payload as object,
      headers: {
        ...app.internalHeaders({
          type: dr.requestedByType === 'apiKey' ? 'apiKey' : 'user',
          id: dr.requestedBy,
        }),
        [APPROVED_REQUEST_HEADER]: dr.id,
      },
    });
    statusCode = res.statusCode;
    body = res.json();
  } catch (err) {
    body = { error: { message: (err as Error).message } };
  }
  const ok = statusCode >= 200 && statusCode < 300;
  const versionId =
    ok && ['deploy', 'promote'].includes(dr.type) ? ((body as { id?: string })?.id ?? null) : null;
  return systemDb.deploymentRequest.update({
    where: { id },
    data: {
      status: ok ? 'executed' : 'failed',
      resolvedAt: new Date(),
      result: { statusCode, body } as Prisma.InputJsonValue,
      resultVersionId: versionId,
    },
  });
}

/** Moves a pending request to `executing`; false if someone else already did. */
export async function claim(app: FastifyInstance, workspaceId: string, id: string, data = {}) {
  const { count } = await app.container.withTenant(workspaceId, (tx) =>
    tx.deploymentRequest.updateMany({
      where: { id, status: 'pending_approval', expiresAt: { gt: new Date() } },
      data: { status: 'executing', ...data },
    })
  );
  return count === 1;
}

/** APR-09: the expiry job. */
export async function expireRequests(app: FastifyInstance, now = new Date()) {
  const { systemDb, webhooks } = app.container;
  const due = await systemDb.deploymentRequest.findMany({
    where: { status: 'pending_approval', expiresAt: { lte: now } },
  });
  for (const dr of due) {
    const { count } = await systemDb.deploymentRequest.updateMany({
      where: { id: dr.id, status: 'pending_approval' },
      data: { status: 'expired', resolvedAt: now },
    });
    if (count) {
      await webhooks.dispatch(dr.workspaceId, 'deploy.approval_expired', {
        requestId: dr.id,
        type: dr.type,
        requestedBy: dr.requestedBy,
      });
    }
  }
  return due.length;
}

export function assertFound<T>(value: T | null, what = 'Approval request'): T {
  if (!value) throw new NotFoundError(`${what} not found`);
  return value;
}
