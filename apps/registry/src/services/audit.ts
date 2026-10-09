import type { Prisma } from '@prisma/client';
import type { TenantTx } from '@harmoniq/db';
import type { Principal } from '../plugins/authenticate';

export interface AuditActor {
  principal: Principal | { type: 'system'; id: string };
  ip?: string;
}

/** AUD-01/02: one append-only event per state change, written in the same transaction. */
export function audit(
  tx: TenantTx,
  workspaceId: string,
  actor: AuditActor,
  event: {
    action: string;
    resourceType: string;
    resourceId: string;
    metadata?: Record<string, unknown>;
  }
) {
  return tx.auditEvent.create({
    data: {
      workspaceId,
      // `system`: background jobs such as an alert's auto-rollback.
      actorType: actor.principal.type,
      actorId:
        actor.principal.type === 'system' ? `system:${actor.principal.id}` : actor.principal.id,
      action: event.action,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      metadata: (event.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
      ip: actor.ip,
    },
  });
}
