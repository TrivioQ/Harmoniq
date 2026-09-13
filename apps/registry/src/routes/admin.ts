import { FastifyPluginAsync } from 'fastify';

const adminRoutes: FastifyPluginAsync = async (fastify, _options) => {
  fastify.post<{
    Body: { setupToken: string; email: string; name?: string };
  }>('/api/admin/setup', async (request, reply) => {
    const { setupToken, email, name } = request.body;

    const expectedToken = process.env.HARMONIQ_SETUP_TOKEN;
    if (!expectedToken || expectedToken !== setupToken) {
      reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Invalid setup token' } });
      return;
    }

    const existingAdmin = await fastify.container.db.instanceAdmin.findFirst();
    if (existingAdmin) {
      reply
        .code(400)
        .send({ error: { code: 'BAD_REQUEST', message: 'Instance already initialized' } });
      return;
    }

    const newAdmin = await fastify.container.db.$transaction(async (tx) => {
      let user = await tx.user.findUnique({ where: { email } });
      if (!user) {
        user = await tx.user.create({
          data: {
            email,
            name: name || 'Admin',
          },
        });
      }

      return tx.instanceAdmin.create({
        data: {
          userId: user.id,
          grantedBy: 'system',
        },
        include: { user: true },
      });
    });

    const token = fastify.jwt.sign({ id: newAdmin.user.id, email: newAdmin.user.email });

    reply.send({
      message: 'Admin created successfully',
      user: newAdmin.user,
      token,
    });
  });

  fastify.get(
    '/api/admin/health',
    {
      preHandler: [fastify.verifyAdmin],
    },
    async (request, reply) => {
      // Collect some basic metrics
      const workspacesCount = await fastify.container.db.workspace.count();
      const modulesCount = await fastify.container.db.remoteModule.count();
      const usersCount = await fastify.container.db.user.count();

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
      preHandler: [fastify.verifyAdmin],
    },
    async (request, reply) => {
      const workspaces = await fastify.container.db.workspace.findMany({
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
