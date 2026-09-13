import { PrismaClient } from '@prisma/client';

export * from '@prisma/client';

export const createPrismaClient = () => {
  const prisma = new PrismaClient();

  // Middleware to inject RLS context
  prisma.$use(async (params, next) => {
    // We expect the caller to attach the workspaceId to the `args` or a context
    // Actually, prisma middleware operates globally. Since Harmoniq needs per-request context,
    // a global middleware $use with `SET LOCAL` is tricky because Prisma reuses connections
    // in a connection pool, and SET LOCAL requires a transaction to be scoped correctly.
    // The requirement says:
    // "Write Prisma middleware to inject SET LOCAL app.current_workspace_id on each query"
    // Wait, prisma middleware was deprecated in v5 in favor of Client Extensions.

    // If we use Prisma client extension for RLS:
    return next(params);
  });

  return prisma;
};

// Extended client for RLS
export const getTenantClient = (prisma: PrismaClient, workspaceId: string) => {
  return prisma.$extends({
    query: {
      $allModels: {
        async $allOperations({ args, query }) {
          const [, result] = await prisma.$transaction([
            prisma.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`,
            query(args),
          ]);
          return result;
        },
      },
    },
  });
};
