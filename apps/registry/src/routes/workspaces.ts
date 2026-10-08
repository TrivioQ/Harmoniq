import { FastifyPluginAsync } from 'fastify';
import type { WorkspaceStorageConfig } from '@prisma/client';
import {
  WorkspaceStorageConfigSchema,
  WorkspaceStorageConfigResponse,
} from '@harmoniq/core/dist/schemas/WorkspaceStorageConfigSchema';
import { decryptJson, encryptJson, isEncryptedValue, maskSecret } from '../services/crypto';

type Params = { workspaceSlug: string };

const workspaceRoutes: FastifyPluginAsync = async (fastify) => {
  const { encryptionKey } = fastify.config;

  // Credentials are never returned, only masked (report §3.4).
  function toResponse(config: WorkspaceStorageConfig): WorkspaceStorageConfigResponse {
    // Legacy plaintext rows (pre-encryption) are still masked for display; using them
    // requires running packages/db/scripts/encrypt-existing-credentials.ts.
    const creds = isEncryptedValue(config.credentialsEncrypted)
      ? decryptJson<Record<string, string>>(config.credentialsEncrypted, encryptionKey)
      : ((config.credentialsEncrypted ?? {}) as Record<string, string>);
    return {
      provider: config.provider as WorkspaceStorageConfigResponse['provider'],
      bucket: config.bucket,
      region: config.region,
      cdnPrefix: config.cdnPrefix ?? undefined,
      pathPrefix: config.pathPrefix ?? undefined,
      maskedCredentials: Object.fromEntries(
        Object.entries(creds).map(([name, value]) => [name, maskSecret(value)])
      ),
      lastVerifiedAt: config.lastVerifiedAt?.toISOString() ?? null,
      updatedAt: config.updatedAt.toISOString(),
    };
  }

  fastify.get<{ Params: Params }>(
    '/api/workspaces/:workspaceSlug/storage',
    { preHandler: fastify.requireWorkspace('workspace:admin', { allowInstanceAdmin: true }) },
    async (request, reply) => {
      const workspace = request.workspace!;
      const config = await fastify.container.withTenant(workspace.id, (tx) =>
        tx.workspaceStorageConfig.findUnique({ where: { workspaceId: workspace.id } })
      );
      reply.send({ storageConfig: config ? toResponse(config) : null });
    }
  );

  fastify.post<{ Params: Params }>(
    '/api/workspaces/:workspaceSlug/storage',
    { preHandler: fastify.requireWorkspace('workspace:admin', { allowInstanceAdmin: true }) },
    async (request, reply) => {
      const workspace = request.workspace!;
      const parsed = WorkspaceStorageConfigSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: { code: 'BAD_REQUEST', message: 'Invalid storage config', details: parsed.error },
        });
      }
      const { credentials, ...fields } = parsed.data;

      const updated = await fastify.container.withTenant(workspace.id, async (tx) => {
        const existing = await tx.workspaceStorageConfig.findUnique({
          where: { workspaceId: workspace.id },
        });
        if (!credentials && !existing) {
          return null;
        }
        const data = {
          ...fields,
          cdnPrefix: fields.cdnPrefix ?? null,
          pathPrefix: fields.pathPrefix ?? null,
          ...(credentials && {
            credentialsEncrypted: { ...encryptJson(credentials, encryptionKey) },
          }),
          // New bucket or credentials have not been verified yet (BYOB-04 lands in M4.9).
          lastVerifiedAt: null,
        };
        return existing
          ? tx.workspaceStorageConfig.update({ where: { workspaceId: workspace.id }, data })
          : tx.workspaceStorageConfig.create({
              data: {
                ...data,
                workspaceId: workspace.id,
                credentialsEncrypted: { ...encryptJson(credentials, encryptionKey) },
              },
            });
      });

      if (!updated) {
        return reply.code(400).send({
          error: {
            code: 'BAD_REQUEST',
            message: 'credentials are required for a new storage config',
          },
        });
      }
      reply.send({ message: 'Storage config updated', storageConfig: toResponse(updated) });
    }
  );
};

export default workspaceRoutes;
