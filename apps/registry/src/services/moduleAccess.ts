import type { Role } from '@prisma/client';
import type { TenantTx } from '@harmoniq/db';
import { canAccessModule, Principal } from '../plugins/authenticate';

/**
 * RBAC-02/03/04: who may change a module (deploy, rollback, promote, canary, kill switch).
 * Workspace admins and owners always; API keys within their `moduleIds`; developers when
 * the module has no owners or they are one of them.
 */
export async function canWriteModule(
  tx: TenantTx,
  principal: Principal,
  role: Role | undefined,
  moduleId: string
): Promise<boolean> {
  if (principal.type === 'apiKey') return canAccessModule(principal, moduleId);
  if (role === 'admin' || role === 'owner') return true;
  const owners = await tx.moduleOwnership.findMany({
    where: { remoteModuleId: moduleId },
    include: { workspaceMember: { select: { userId: true } } },
  });
  return owners.length === 0 || owners.some((o) => o.workspaceMember.userId === principal.id);
}

/** RBAC-01: a module's owners, as workspace members. */
export async function ownersOf(tx: TenantTx, moduleId: string) {
  const rows = await tx.moduleOwnership.findMany({
    where: { remoteModuleId: moduleId },
    include: { workspaceMember: { include: { user: { select: { email: true, name: true } } } } },
  });
  return rows.map((r) => ({
    memberId: r.workspaceMemberId,
    userId: r.workspaceMember.userId,
    email: r.workspaceMember.user.email,
    name: r.workspaceMember.user.name,
  }));
}
