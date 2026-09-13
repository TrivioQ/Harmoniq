import fp from 'fastify-plugin';
import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import fastifyJwt from '@fastify/jwt';

declare module 'fastify' {
  interface FastifyRequest {
    adminUser?: {
      id: string;
      email: string;
    };
  }

  interface FastifyInstance {
    verifyAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

const adminAuthPlugin: FastifyPluginAsync = async (fastify, options) => {
  // Register the JWT plugin
  await fastify.register(fastifyJwt, {
    secret: process.env.JWT_SECRET || 'changeme',
  });

  fastify.decorate('verifyAdmin', async function (request: FastifyRequest, reply: FastifyReply) {
    try {
      await request.jwtVerify();
      const decoded = request.user as { id: string; email: string };
      
      const adminRecord = await fastify.container.db.instanceAdmin.findUnique({
        where: { userId: decoded.id },
      });

      if (!adminRecord || adminRecord.revokedAt) {
        reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Not an active Instance Admin' } });
        return;
      }

      request.adminUser = decoded;
    } catch (err) {
      reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid token' } });
    }
  });
};

export default fp(adminAuthPlugin, {
  name: 'admin-auth-middleware',
  dependencies: ['app-container']
});
