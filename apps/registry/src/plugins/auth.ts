import fp from 'fastify-plugin';
import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import argon2 from 'argon2';

declare module 'fastify' {
  interface FastifyRequest {
    apiKey?: {
      id: string;
      workspaceId: string;
      scopes: string[];
    };
  }

  interface FastifyInstance {
    verifyApiKey: (
      scopes?: string[]
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

const authPlugin: FastifyPluginAsync = async (fastify, _options) => {
  fastify.decorate('verifyApiKey', function (requiredScopes?: string[]) {
    return async function (request: FastifyRequest, reply: FastifyReply) {
      const authHeader = request.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        reply.code(401).send({
          error: { code: 'UNAUTHORIZED', message: 'Missing or invalid Authorization header' },
        });
        return;
      }

      const token = authHeader.substring(7);

      // In a real implementation, we would extract the ID prefix from the token,
      // e.g. hq_abc123_xyz, to look up the DB record instead of scanning all keys.
      // Assuming token is just the secret part for this mock, or we use a hashed lookup.
      // Wait, we can't easily look up a hash without the prefix.
      // Let's assume the token format is: <keyId>.<secret>
      const parts = token.split('.');
      if (parts.length !== 2) {
        reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid token format' } });
        return;
      }

      const [keyId, secret] = parts;

      const apiKeyRecord = await fastify.container.db.apiKey.findUnique({
        where: { id: keyId },
      });

      if (!apiKeyRecord || apiKeyRecord.revokedAt) {
        reply
          .code(401)
          .send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or revoked API key' } });
        return;
      }

      // Verify argon2 hash
      const isValid = await argon2.verify(apiKeyRecord.keyHash, secret);
      if (!isValid) {
        reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid API key' } });
        return;
      }

      // Check scopes
      if (requiredScopes && requiredScopes.length > 0) {
        const hasScope = requiredScopes.every((scope) => apiKeyRecord.scopes.includes(scope));
        if (!hasScope) {
          reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Insufficient scopes' } });
          return;
        }
      }

      // Decorate request
      request.apiKey = {
        id: apiKeyRecord.id,
        workspaceId: apiKeyRecord.workspaceId,
        scopes: apiKeyRecord.scopes,
      };
    };
  });
};

export default fp(authPlugin, {
  name: 'auth-middleware',
  dependencies: ['app-container'],
});
