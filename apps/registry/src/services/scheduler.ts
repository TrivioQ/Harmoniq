import type { FastifyInstance } from 'fastify';
import type { Prisma, ScheduledOperation } from '@prisma/client';
import type { ScheduledOperationSpec } from '@harmoniq/core/dist/schemas/ScheduledOperationSchema';
import { audit } from './audit';

/** Operations stuck in `running` this long (a replica died mid-call) are marked failed. */
const STALE_RUNNING_MS = 10 * 60_000;
const BATCH = 20;

const enc = encodeURIComponent;

/** The API call a scheduled operation stands for. */
export function toRequest(workspaceSlug: string, spec: ScheduledOperationSpec) {
  const base = `/api/workspaces/${enc(workspaceSlug)}/modules/${enc(spec.module)}`;
  const calls: Record<ScheduledOperationSpec['type'], { method: 'POST' | 'PUT'; path: string }> = {
    deploy: { method: 'POST', path: `${base}/deploy` },
    promote: { method: 'POST', path: `${base}/promote` },
    rollback: { method: 'POST', path: `${base}/rollback` },
    canary_traffic: { method: 'PUT', path: `${base}/canary` },
    canary_promote: { method: 'POST', path: `${base}/canary/promote` },
    canary_abort: { method: 'POST', path: `${base}/canary/abort` },
    kill_switch: { method: 'PUT', path: `${base}/kill-switch` },
  };
  return { ...calls[spec.type], body: spec.request };
}

/** The environment an operation changes, for listings. */
export function environmentOf(spec: ScheduledOperationSpec): string | null {
  const request = spec.request as { environment?: string; toEnvironment?: string };
  return request.toEnvironment ?? request.environment ?? null;
}

/** Claims due operations; `FOR UPDATE SKIP LOCKED` hands each to exactly one replica. */
async function claimDue(app: FastifyInstance, now: Date): Promise<ScheduledOperation[]> {
  return app.container.systemDb.$queryRaw<ScheduledOperation[]>`
    UPDATE "ScheduledOperation" SET "status" = 'running', "startedAt" = ${now}
     WHERE "id" IN (
       SELECT "id" FROM "ScheduledOperation"
        WHERE "status" = 'pending' AND "runAt" <= ${now}
        ORDER BY "runAt"
        LIMIT ${BATCH}
        FOR UPDATE SKIP LOCKED)
    RETURNING *`;
}

/** Runs one claimed operation as its creator and records the outcome. */
async function execute(app: FastifyInstance, op: ScheduledOperation) {
  const { systemDb, withTenant, webhooks, logger } = app.container;
  let statusCode = 0;
  let body: unknown = null;
  let error: string | null = null;
  try {
    const res = await app.inject({
      method: op.method as 'POST' | 'PUT',
      url: op.path,
      payload: op.body as object,
      headers: app.internalHeaders({
        type: op.createdByType === 'apiKey' ? 'apiKey' : 'user',
        id: op.createdById,
      }),
    });
    statusCode = res.statusCode;
    body = res.json();
    if (statusCode >= 400) {
      error = (body as { error?: { message?: string } })?.error?.message ?? `HTTP ${statusCode}`;
    }
  } catch (err) {
    error = (err as Error).message;
  }

  const status = error ? 'failed' : 'done';
  await systemDb.scheduledOperation.update({
    where: { id: op.id },
    data: {
      status,
      finishedAt: new Date(),
      error,
      result: { statusCode, body } as Prisma.InputJsonValue,
    },
  });
  await withTenant(op.workspaceId, (tx) =>
    audit(
      tx,
      op.workspaceId,
      { principal: { type: 'system', id: `schedule:${op.id}` } },
      {
        action: error ? 'schedule.failed' : 'schedule.executed',
        resourceType: 'scheduledOperation',
        resourceId: op.id,
        metadata: {
          type: op.type,
          module: op.module,
          environment: op.environment,
          statusCode,
          ...(error && { error }),
        },
      }
    )
  ).catch((err) => logger.error(`Audit for scheduled operation ${op.id} failed`, err as Error));
  await webhooks
    .dispatch(op.workspaceId, error ? 'schedule.failed' : 'schedule.executed', {
      id: op.id,
      type: op.type,
      module: op.module,
      environment: op.environment,
      statusCode,
      ...(error && { error }),
    })
    .catch((err) => logger.error('Webhook dispatch for scheduled operation failed', err as Error));
  return { id: op.id, status, statusCode, error };
}

/** The `schedule.run` job (every minute). */
export async function runScheduled(app: FastifyInstance, now = new Date()) {
  const { systemDb } = app.container;
  await systemDb.scheduledOperation.updateMany({
    where: { status: 'running', startedAt: { lt: new Date(now.getTime() - STALE_RUNNING_MS) } },
    data: { status: 'failed', finishedAt: now, error: 'Interrupted (registry restarted)' },
  });
  const results = [];
  for (const op of await claimDue(app, now)) results.push(await execute(app, op));
  return results;
}
