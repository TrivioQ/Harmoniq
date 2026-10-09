import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { Prisma, ScheduledOperation } from '@prisma/client';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '@harmoniq/core/dist/errors/AppError';
import { CreateScheduledOperationSchema } from '@harmoniq/core/dist/schemas/ScheduledOperationSchema';
import { canWriteModule } from '../services/moduleAccess';
import { audit } from '../services/audit';
import { resolveModule } from '../services/modules';
import { environmentOf, toRequest } from '../services/scheduler';

const MAX_AHEAD_MS = 366 * 86_400_000;

function operationDto(op: ScheduledOperation) {
  return {
    id: op.id,
    type: op.type,
    module: op.module,
    environment: op.environment,
    description: op.description,
    runAt: op.runAt.toISOString(),
    status: op.status,
    request: op.body,
    createdBy: { type: op.createdByType, id: op.createdById },
    startedAt: op.startedAt?.toISOString() ?? null,
    finishedAt: op.finishedAt?.toISOString() ?? null,
    result: op.result,
    error: op.error,
    createdAt: op.createdAt.toISOString(),
  };
}

// M3.6: scheduled operations. Creating one needs the permission the operation itself
// needs; it then runs as its creator, so access is checked again at run time.
const scheduledRoutes: FastifyPluginAsync = async (fastify) => {
  const { withTenant } = fastify.container;
  const actor = (request: FastifyRequest) => ({ principal: request.principal!, ip: request.ip });

  fastify.get<{ Params: { workspaceSlug: string }; Querystring: { status?: string } }>(
    '/api/workspaces/:workspaceSlug/scheduled-operations',
    { preHandler: fastify.requireWorkspace('workspace:read') },
    async (request) => {
      const operations = await withTenant(request.workspace!.id, (tx) =>
        tx.scheduledOperation.findMany({
          where: request.query.status ? { status: request.query.status } : {},
          orderBy: [{ runAt: 'desc' }],
          take: 100,
        })
      );
      return { operations: operations.map(operationDto) };
    }
  );

  fastify.post<{ Params: { workspaceSlug: string } }>(
    '/api/workspaces/:workspaceSlug/scheduled-operations',
    { preHandler: fastify.requireWorkspace('module:deploy') },
    async (request, reply) => {
      const body = CreateScheduledOperationSchema.parse(request.body);
      const runAt = new Date(body.runAt);
      if (runAt.getTime() < Date.now() - 60_000) throw new BadRequestError('runAt is in the past');
      if (runAt.getTime() > Date.now() + MAX_AHEAD_MS) {
        throw new BadRequestError('runAt is more than a year away');
      }
      const workspace = request.workspace!;
      const principal = request.principal!;
      const spec = body.operation;

      const created = await withTenant(workspace.id, async (tx) => {
        const module = await resolveModule(tx, spec.module);
        // The operation will need write access to the module (RBAC-02); so does scheduling it.
        if (!(await canWriteModule(tx, principal, request.workspaceRole, module.id))) {
          throw new ForbiddenError(
            principal.type === 'apiKey'
              ? 'API key is not scoped to this module'
              : `Only the owners of "${module.slug}" or workspace admins can change it`
          );
        }
        // Stored by id so a later slug change or a same-named module can't redirect it.
        const call = toRequest(workspace.slug, { ...spec, module: module.id });
        const op = await tx.scheduledOperation.create({
          data: {
            workspaceId: workspace.id,
            type: spec.type,
            module: module.slug,
            environment: environmentOf(spec),
            description: body.description,
            method: call.method,
            path: call.path,
            body: call.body as Prisma.InputJsonValue,
            runAt,
            createdById: principal.id,
            createdByType: principal.type,
          },
        });
        await audit(tx, workspace.id, actor(request), {
          action: 'schedule.create',
          resourceType: 'scheduledOperation',
          resourceId: op.id,
          metadata: {
            type: op.type,
            module: op.module,
            environment: op.environment,
            runAt: op.runAt.toISOString(),
          },
        });
        return op;
      });
      return reply.code(201).send(operationDto(created));
    }
  );

  fastify.delete<{ Params: { workspaceSlug: string; id: string } }>(
    '/api/workspaces/:workspaceSlug/scheduled-operations/:id',
    { preHandler: fastify.requireWorkspace('module:deploy') },
    async (request) => {
      const workspace = request.workspace!;
      const cancelled = await withTenant(workspace.id, async (tx) => {
        const op = await tx.scheduledOperation.findUnique({ where: { id: request.params.id } });
        if (!op) throw new NotFoundError('Scheduled operation not found');
        // Only a pending operation can be cancelled; the conditional update closes the
        // race with the job claiming it.
        const { count } = await tx.scheduledOperation.updateMany({
          where: { id: op.id, status: 'pending' },
          data: { status: 'cancelled', finishedAt: new Date() },
        });
        if (!count) throw new ConflictError(`The operation is already ${op.status}`);
        await audit(tx, workspace.id, actor(request), {
          action: 'schedule.cancel',
          resourceType: 'scheduledOperation',
          resourceId: op.id,
          metadata: { type: op.type, module: op.module, environment: op.environment },
        });
        return tx.scheduledOperation.findUniqueOrThrow({ where: { id: op.id } });
      });
      return operationDto(cancelled);
    }
  );
};

export default scheduledRoutes;
