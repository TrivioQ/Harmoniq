// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { WorkspaceStorageConfig } from '@prisma/client';
import { BadRequestError, NotFoundError } from '@harmoniq/core/dist/errors/AppError';
import {
  WorkspaceStorageConfigDto,
  WorkspaceStorageConfigSchema,
  WorkspaceStorageConfigResponse,
  storageCredentialsProblem,
} from '@harmoniq/core/dist/schemas/WorkspaceStorageConfigSchema';
import { storageTarget, workspaceStorage } from '../adapters/storage/createStorage';
import { audit } from '../services/audit';
import { checkPublicUrl } from '../services/bundleValidator';
import { decryptJson, encryptJson, isEncryptedValue, maskSecret } from '../services/crypto';
import { probeStorage } from '../services/instanceHealth';
import { recordStorageCheck } from '../services/overview';

type Params = { workspaceSlug: string };

// BYOB-01..06, 13: a workspace's own bucket. Credentials are write-only and sealed; every
// save is verified with a write-read-delete cycle first.
const workspaceRoutes: FastifyPluginAsync = async (fastify) => {
  const { encryptionKey, isProduction } = fastify.config;
  const { withTenant } = fastify.container;
  const admin = {
    preHandler: fastify.requireWorkspace('workspace:admin', { allowInstanceAdmin: true }),
  };
  const path = '/api/workspaces/:workspaceSlug/storage';
  const actor = (request: FastifyRequest) => ({ principal: request.principal!, ip: request.ip });

  // Legacy plaintext rows (pre-encryption) still read; re-saving encrypts them.
  const credentialsOf = (config: WorkspaceStorageConfig) =>
    isEncryptedValue(config.credentialsEncrypted)
      ? decryptJson<Record<string, string>>(config.credentialsEncrypted, encryptionKey)
      : ((config.credentialsEncrypted ?? {}) as Record<string, string>);

  // Credentials are never returned, only masked (report §3.4).
  function toResponse(config: WorkspaceStorageConfig): WorkspaceStorageConfigResponse {
    return {
      provider: config.provider as WorkspaceStorageConfigResponse['provider'],
      bucket: config.bucket,
      region: config.region,
      endpoint: config.endpoint ?? undefined,
      cdnPrefix: config.cdnPrefix ?? undefined,
      pathPrefix: config.pathPrefix ?? undefined,
      maskedCredentials: Object.fromEntries(
        Object.entries(credentialsOf(config)).map(([name, value]) => [name, maskSecret(value)])
      ),
      lastVerifiedAt: config.lastVerifiedAt?.toISOString() ?? null,
      updatedAt: config.updatedAt.toISOString(),
    };
  }

  const current = (workspaceId: string) =>
    withTenant(workspaceId, (tx) =>
      tx.workspaceStorageConfig.findUnique({ where: { workspaceId } })
    );

  /**
   * The candidate config with credentials: the new ones, or the stored ones when omitted
   * (only for the same provider: credentials don't carry over between providers).
   */
  async function candidate(
    body: WorkspaceStorageConfigDto,
    existing: WorkspaceStorageConfig | null
  ) {
    const credentials =
      body.credentials ??
      (existing && existing.provider === body.provider ? credentialsOf(existing) : null);
    if (!credentials) {
      throw new BadRequestError(
        existing ? 'Changing the provider needs new credentials' : 'credentials are required'
      );
    }
    const problem = storageCredentialsProblem(body.provider, credentials);
    if (problem) throw new BadRequestError(problem);
    // The registry connects to this endpoint: in production, public HTTPS only (SSRF).
    if (body.endpoint && isProduction) {
      const blocked = await checkPublicUrl(body.endpoint, { allowHttp: false });
      if (blocked) throw new BadRequestError(`endpoint: ${blocked}`);
    }
    return { ...body, credentials };
  }

  /** BYOB-04/05: write, read back and delete a probe object under the path prefix. */
  async function verify(config: Awaited<ReturnType<typeof candidate>>) {
    let result;
    try {
      const storage = workspaceStorage(
        { ...config, endpoint: config.endpoint ?? null },
        config.credentials
      );
      result = await probeStorage(
        storageTarget(
          { pathPrefix: config.pathPrefix ?? null, cdnPrefix: config.cdnPrefix ?? null },
          storage
        )
      );
    } catch (err) {
      result = { ok: false, latencyMs: 0, error: (err as Error).message };
    }
    return result;
  }

  fastify.get<{ Params: Params }>(path, admin, async (request) => {
    const config = await current(request.workspace!.id);
    return { storageConfig: config ? toResponse(config) : null };
  });

  // BYOB-04/06: verified before anything is saved; 400 with the storage's error otherwise.
  fastify.post<{ Params: Params }>(path, admin, async (request) => {
    const workspace = request.workspace!;
    // BYOB-01: a plan feature.
    await fastify.container.plans.requireForWorkspace(workspace.id, 'byob');
    const body = WorkspaceStorageConfigSchema.parse(request.body);
    const existing = await current(workspace.id);
    const config = await candidate(body, existing);
    const check = await verify(config);
    if (!check.ok) {
      throw new BadRequestError(`The storage test failed: ${check.error}`, { check });
    }
    const { credentials, ...fields } = config;
    const data = {
      provider: fields.provider,
      bucket: fields.bucket,
      region: fields.region,
      endpoint: fields.endpoint ?? null,
      cdnPrefix: fields.cdnPrefix ?? null,
      pathPrefix: fields.pathPrefix ?? null,
      credentialsEncrypted: { ...encryptJson(credentials, encryptionKey) },
      lastVerifiedAt: new Date(),
    };
    const saved = await withTenant(workspace.id, async (tx) => {
      const row = await tx.workspaceStorageConfig.upsert({
        where: { workspaceId: workspace.id },
        create: { workspaceId: workspace.id, ...data },
        update: data,
      });
      await audit(tx, workspace.id, actor(request), {
        action: 'storage.config_update',
        resourceType: 'workspace',
        resourceId: workspace.id,
        // Never the credentials.
        metadata: {
          provider: data.provider,
          bucket: data.bucket,
          region: data.region,
          cdnPrefix: data.cdnPrefix,
          credentialsChanged: !!body.credentials,
          firstTime: !existing,
        },
      });
      return row;
    });
    return {
      message: 'Storage config updated',
      storageConfig: toResponse(saved),
      check,
      // BYOB-11/12: modules already deployed keep serving from where they are.
      ...(!existing && { firstTime: true }),
    };
  });

  /**
   * BYOB-05: Test Connection without saving. With a body, tests that config (omitted
   * credentials: the stored ones); without one, the saved config.
   */
  fastify.post<{ Params: Params }>(`${path}/test`, admin, async (request) => {
    const workspace = request.workspace!;
    const existing = await current(workspace.id);
    const hasBody = !!request.body && Object.keys(request.body as object).length > 0;
    if (!hasBody) {
      if (!existing) throw new NotFoundError('No storage configured');
      const check = await verify({
        provider: existing.provider as WorkspaceStorageConfigDto['provider'],
        bucket: existing.bucket,
        region: existing.region,
        endpoint: existing.endpoint ?? undefined,
        cdnPrefix: existing.cdnPrefix ?? undefined,
        pathPrefix: existing.pathPrefix ?? undefined,
        credentials: credentialsOf(existing),
      });
      // INST-27: a failure stays visible to instance admins until a check succeeds.
      await withTenant(workspace.id, (tx) => recordStorageCheck(tx, workspace.id, check));
      return check;
    }
    const body = WorkspaceStorageConfigSchema.parse(request.body);
    return verify(await candidate(body, existing));
  });

  /** Back to the instance default storage (new deploys only, BYOB-11). */
  fastify.delete<{ Params: Params }>(path, admin, async (request, reply) => {
    const workspace = request.workspace!;
    await withTenant(workspace.id, async (tx) => {
      const { count } = await tx.workspaceStorageConfig.deleteMany({
        where: { workspaceId: workspace.id },
      });
      if (!count) throw new NotFoundError('No storage configured');
      await audit(tx, workspace.id, actor(request), {
        action: 'storage.config_delete',
        resourceType: 'workspace',
        resourceId: workspace.id,
      });
    });
    return reply.code(204).send();
  });
};

export default workspaceRoutes;
