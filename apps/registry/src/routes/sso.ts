// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { BadRequestError, NotFoundError } from '@harmoniq/core/dist/errors/AppError';
import { IdentityError } from '@harmoniq/core/dist/ports/IdentityProvider';
import { OidcConfigSchema } from '@harmoniq/core/dist/schemas/SsoSchema';
import { audit } from '../services/audit';
import { maskSecret, openSecret, sealSecret } from '../services/crypto';
import {
  StoredOidcConfig,
  disabledProtocol as disabled,
  workspaceProviderId,
} from '../services/sso';

// SSO-03: a workspace's OIDC settings (admins). The client secret is write-only and
// stored sealed (AES-256-GCM).
const ssoRoutes: FastifyPluginAsync = async (fastify) => {
  const { withTenant } = fastify.container;
  const { encryptionKey } = fastify.config;
  const path = '/api/workspaces/:workspaceSlug/sso/oidc';
  const actor = (request: FastifyRequest) => ({ principal: request.principal!, ip: request.ip });

  const dto = (slug: string, stored: StoredOidcConfig, forceSso: boolean) => ({
    ...stored,
    clientSecret: maskSecret(openSecret(stored.clientSecret, encryptionKey)),
    forceSso,
    providerId: workspaceProviderId(slug),
  });

  fastify.get<{ Params: { workspaceSlug: string } }>(
    path,
    { preHandler: fastify.requireWorkspace('workspace:admin') },
    async (request) => {
      const workspace = request.workspace!;
      const config = await withTenant(workspace.id, (tx) =>
        tx.workspaceConfig.findUnique({ where: { workspaceId: workspace.id } })
      );
      const stored = config?.oidcConfig as StoredOidcConfig | null | undefined;
      return { oidc: stored ? dto(workspace.slug, stored, config!.forceSso) : null };
    }
  );

  fastify.put<{ Params: { workspaceSlug: string } }>(
    path,
    { preHandler: fastify.requireWorkspace('workspace:admin') },
    async (request) => {
      if (!fastify.ssoProviders.protocolEnabled('oidc')) throw disabled('oidc');
      const body = OidcConfigSchema.parse(request.body);
      const workspace = request.workspace!;
      const current = await withTenant(workspace.id, (tx) =>
        tx.workspaceConfig.findUnique({ where: { workspaceId: workspace.id } })
      );
      const previous = current?.oidcConfig as StoredOidcConfig | null | undefined;
      const secret =
        body.clientSecret ?? (previous && openSecret(previous.clientSecret, encryptionKey));
      if (!secret) throw new BadRequestError('clientSecret is required');
      const { forceSso, ...rest } = body;
      const stored: StoredOidcConfig = { ...rest, clientSecret: sealSecret(secret, encryptionKey) };

      // Prove the issuer works (and is allowed) before anyone depends on it.
      try {
        await fastify.ssoProviders
          .build({ kind: 'workspace', slug: workspace.slug }, { ...stored, clientSecret: secret })
          .metadata();
      } catch (err) {
        if (err instanceof IdentityError) throw new BadRequestError(err.message);
        throw err;
      }

      await withTenant(workspace.id, async (tx) => {
        const data = {
          oidcConfig: stored as unknown as Prisma.InputJsonValue,
          forceSso,
          trustedDomains: body.trustedDomains,
          defaultSsoRole: body.defaultRole,
        };
        await tx.workspaceConfig.upsert({
          where: { workspaceId: workspace.id },
          create: { workspaceId: workspace.id, ...data },
          update: data,
        });
        await audit(tx, workspace.id, actor(request), {
          action: 'sso.config_update',
          resourceType: 'workspace',
          resourceId: workspace.id,
          // Never the secret.
          metadata: {
            issuer: body.issuer,
            clientId: body.clientId,
            trustedDomains: body.trustedDomains,
            forceSso,
            secretChanged: !!body.clientSecret,
          },
        });
      });
      fastify.ssoProviders.invalidate({ kind: 'workspace', slug: workspace.slug });
      return { oidc: dto(workspace.slug, stored, forceSso) };
    }
  );

  fastify.delete<{ Params: { workspaceSlug: string } }>(
    path,
    { preHandler: fastify.requireWorkspace('workspace:admin') },
    async (request, reply) => {
      const workspace = request.workspace!;
      await withTenant(workspace.id, async (tx) => {
        const { count } = await tx.workspaceConfig.updateMany({
          where: { workspaceId: workspace.id, oidcConfig: { not: Prisma.DbNull } },
          data: { oidcConfig: Prisma.DbNull, forceSso: false },
        });
        if (!count) throw new NotFoundError('No single sign-on configured');
        await audit(tx, workspace.id, actor(request), {
          action: 'sso.config_delete',
          resourceType: 'workspace',
          resourceId: workspace.id,
        });
      });
      fastify.ssoProviders.invalidate({ kind: 'workspace', slug: workspace.slug });
      return reply.code(204).send();
    }
  );
};

export default ssoRoutes;
