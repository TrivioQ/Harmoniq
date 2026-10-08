import { FastifyPluginAsync } from 'fastify';
import { createHash, timingSafeEqual } from 'crypto';
import { Prisma } from '@prisma/client';
import { signAccessToken } from '../auth/tokens';

// InstanceConfig key marking the one-time setup token as consumed (INST-04).
const SETUP_COMPLETED_KEY = 'setup.completed';

function tokensMatch(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string') return false;
  // Hash first so lengths match and comparison time doesn't depend on the input.
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

const adminRoutes: FastifyPluginAsync = async (fastify, _options) => {
  fastify.post<{
    Body: { setupToken: string; email: string; name?: string };
  }>(
    '/api/admin/setup',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { setupToken, email, name } = request.body ?? {};

      const expectedToken = fastify.config.setupToken;
      if (!expectedToken || !tokensMatch(setupToken, expectedToken)) {
        reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Invalid setup token' } });
        return;
      }
      if (typeof email !== 'string' || !email.includes('@')) {
        reply
          .code(400)
          .send({ error: { code: 'BAD_REQUEST', message: 'A valid email is required' } });
        return;
      }

      let newAdmin;
      try {
        newAdmin = await fastify.container.systemDb.$transaction(async (tx) => {
          // Unique key: a concurrent second setup fails here instead of creating two admins.
          await tx.instanceConfig.create({
            data: {
              key: SETUP_COMPLETED_KEY,
              value: { at: new Date().toISOString(), email },
              updatedBy: 'setup',
            },
          });

          const user =
            (await tx.user.findUnique({ where: { email } })) ??
            (await tx.user.create({ data: { email, name: name || 'Admin' } }));

          // Upsert: the user may hold a previously revoked admin grant.
          return tx.instanceAdmin.upsert({
            where: { userId: user.id },
            create: { userId: user.id, grantedBy: 'system' },
            update: { revokedAt: null, grantedBy: 'system' },
            include: { user: true },
          });
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          reply
            .code(400)
            .send({ error: { code: 'BAD_REQUEST', message: 'Instance already initialized' } });
          return;
        }
        throw err;
      }

      // Interim: until dashboard sign-in lands (M0.4), setup hands back an access token.
      const token = await signAccessToken(
        { userId: newAdmin.user.id, email: newAdmin.user.email },
        fastify.config.jwtSecret
      );

      reply.send({
        message: 'Admin created successfully',
        user: newAdmin.user,
        token,
      });
    }
  );

  fastify.get(
    '/api/admin/health',
    {
      preHandler: fastify.requireInstanceAdmin,
    },
    async (request, reply) => {
      // Collect some basic metrics
      const workspacesCount = await fastify.container.systemDb.workspace.count();
      const modulesCount = await fastify.container.systemDb.remoteModule.count();
      const usersCount = await fastify.container.systemDb.user.count();

      reply.send({
        status: 'ok',
        version: '1.0.0',
        stats: {
          workspaces: workspacesCount,
          modules: modulesCount,
          users: usersCount,
        },
      });
    }
  );

  fastify.get(
    '/api/admin/workspaces',
    {
      preHandler: fastify.requireInstanceAdmin,
    },
    async (request, reply) => {
      const workspaces = await fastify.container.systemDb.workspace.findMany({
        include: {
          _count: {
            select: { RemoteModules: true, WorkspaceMembers: true },
          },
        },
        orderBy: { createdAt: 'desc' },
      });

      reply.send(workspaces);
    }
  );
};

export default adminRoutes;
