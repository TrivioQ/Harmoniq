// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes } from 'crypto';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import type { TenantTx } from '@harmoniq/db';
import { BadRequestError, NotFoundError } from '@harmoniq/core/dist/errors/AppError';
import { IdentityError } from '@harmoniq/core/dist/ports/IdentityProvider';
import {
  OrgOidcConfigSchema,
  OrgProvisioningSchema,
  OrgSamlConfigSchema,
} from '@harmoniq/core/dist/schemas/SsoSchema';
import { maskSecret, openSecret, sealSecret } from '../services/crypto';
import { orgProvisioning } from '../services/orgProvisioning';
import { StoredSamlConfig, generateSpKeyPair, parseIdpMetadata, samlUrls } from '../services/saml';
import { type StoredOidcConfig, disabledProtocol } from '../services/sso';
import { SsoSubject, ssoProviderId } from '../services/ssoIds';

type OrgParams = { orgSlug: string };
type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * ORG-05..07: an organization's single sign-on (OIDC and SAML, inherited by workspaces
 * without their own), its group rules, and its SCIM token. Org admins only.
 */
export function orgSsoRoutes(
  fastify: FastifyInstance,
  deps: {
    admin: { preHandler: Handler };
    /** PPL-08: reads are also open to org auditors. */
    reader: { preHandler: Handler };
    orgAudit: (
      request: FastifyRequest,
      event: {
        action: string;
        resourceType: string;
        resourceId: string;
        metadata?: Record<string, unknown>;
      }
    ) => Promise<unknown>;
  }
) {
  // MT-07/08: everything here is the request's organization (RLS-scoped).
  const inOrg = <T>(request: FastifyRequest, fn: (tx: TenantTx) => Promise<T>) =>
    fastify.container.withOrg(request.org!.id, fn);
  const { encryptionKey, publicUrl } = fastify.config;
  const { admin, reader, orgAudit } = deps;
  const samlService = fastify.ssoProviders.samlService;
  const base = '/api/orgs/:orgSlug';
  const subjectOf = (request: FastifyRequest): SsoSubject => ({
    kind: 'organization',
    slug: request.org!.slug,
  });
  const configAudit = (request: FastifyRequest, action: string, metadata = {}) =>
    orgAudit(request, {
      action,
      resourceType: 'organization',
      resourceId: request.org!.id,
      metadata,
    });

  /** Which workspaces use the organization's SSO, and which override it with their own. */
  fastify.get<{ Params: OrgParams }>(`${base}/sso`, reader, async (request) => {
    const org = request.org!;
    const workspaces = await inOrg(request, (tx) =>
      tx.workspace.findMany({
        where: { organizationId: org.id },
        include: { WorkspaceConfig: { select: { oidcConfig: true, samlConfig: true } } },
        orderBy: { name: 'asc' },
      })
    );
    return {
      forceSso: org.forceSso,
      trustedDomains: org.trustedDomains,
      workspaces: workspaces.map((ws) => ({
        slug: ws.slug,
        name: ws.name,
        // ORG-05: a workspace's own SSO overrides the organization's.
        own: ws.WorkspaceConfig?.oidcConfig
          ? 'oidc'
          : ws.WorkspaceConfig?.samlConfig
            ? 'saml'
            : null,
      })),
    };
  });

  // ─── OIDC ─────────────────────────────────────────────────────────────────

  const oidcDto = (request: FastifyRequest, stored: StoredOidcConfig, forceSso: boolean) => ({
    ...stored,
    clientSecret: maskSecret(openSecret(stored.clientSecret, encryptionKey)),
    forceSso,
    providerId: ssoProviderId('oidc', subjectOf(request)),
  });

  fastify.get<{ Params: OrgParams }>(`${base}/sso/oidc`, reader, async (request) => {
    const org = request.org!;
    const stored = org.oidcConfig as StoredOidcConfig | null;
    return { oidc: stored ? oidcDto(request, stored, org.forceSso) : null };
  });

  fastify.put<{ Params: OrgParams }>(`${base}/sso/oidc`, admin, async (request) => {
    if (!fastify.ssoProviders.protocolEnabled('oidc')) throw disabledProtocol('oidc');
    const body = OrgOidcConfigSchema.parse(request.body);
    const org = request.org!;
    const previous = org.oidcConfig as StoredOidcConfig | null;
    const secret =
      body.clientSecret ?? (previous && openSecret(previous.clientSecret, encryptionKey));
    if (!secret) throw new BadRequestError('clientSecret is required');
    const { forceSso, ...rest } = body;
    const stored: StoredOidcConfig = { ...rest, clientSecret: sealSecret(secret, encryptionKey) };
    // Prove the issuer works (and is allowed) before anyone depends on it.
    try {
      await fastify.ssoProviders
        .build(subjectOf(request), { ...stored, clientSecret: secret })
        .metadata();
    } catch (err) {
      if (err instanceof IdentityError) throw new BadRequestError(err.message);
      throw err;
    }
    await inOrg(request, (tx) =>
      tx.organization.update({
        where: { id: org.id },
        data: {
          oidcConfig: stored as unknown as Prisma.InputJsonValue,
          forceSso,
          trustedDomains: body.trustedDomains,
        },
      })
    );
    await configAudit(request, 'sso.config_update', {
      protocol: 'oidc',
      issuer: body.issuer,
      clientId: body.clientId,
      trustedDomains: body.trustedDomains,
      forceSso,
      secretChanged: !!body.clientSecret,
    });
    fastify.ssoProviders.invalidate(subjectOf(request));
    return { oidc: oidcDto(request, stored, forceSso) };
  });

  fastify.delete<{ Params: OrgParams }>(`${base}/sso/oidc`, admin, async (request, reply) => {
    const org = request.org!;
    if (!org.oidcConfig) throw new NotFoundError('No single sign-on configured');
    await inOrg(request, (tx) =>
      tx.organization.update({
        where: { id: org.id },
        data: { oidcConfig: Prisma.DbNull, ...(!org.samlConfig && { forceSso: false }) },
      })
    );
    await configAudit(request, 'sso.config_delete', { protocol: 'oidc' });
    fastify.ssoProviders.invalidate(subjectOf(request));
    return reply.code(204).send();
  });

  // ─── SAML (ORG-06) ──────────────────────────────────────────────────────────

  const samlDto = (
    request: FastifyRequest,
    stored: StoredSamlConfig | null,
    forceSso: boolean
  ) => ({
    serviceProvider: { ...samlUrls(publicUrl, subjectOf(request)), cert: stored?.spCert ?? null },
    saml: stored && {
      ...stored,
      spPrivateKey: undefined,
      forceSso,
      providerId: ssoProviderId('saml', subjectOf(request)),
    },
  });

  fastify.get<{ Params: OrgParams }>(`${base}/sso/saml`, reader, async (request) =>
    samlDto(request, request.org!.samlConfig as StoredSamlConfig | null, request.org!.forceSso)
  );

  fastify.put<{ Params: OrgParams }>(`${base}/sso/saml`, admin, async (request) => {
    if (!fastify.ssoProviders.protocolEnabled('saml')) throw disabledProtocol('saml');
    const body = OrgSamlConfigSchema.parse(request.body);
    const org = request.org!;
    await fastify.container.plans.requireForOrg(org.id, 'saml');
    const previous = org.samlConfig as StoredSamlConfig | null;
    // SSO-18: generated once per organization, the private key sealed at rest.
    const keys = previous
      ? { spPrivateKey: previous.spPrivateKey, spCert: previous.spCert }
      : await (async () => {
          const pair = await generateSpKeyPair(`org-${org.slug}`);
          return { spPrivateKey: sealSecret(pair.privateKey, encryptionKey), spCert: pair.cert };
        })();
    const { forceSso, ...rest } = body;
    const stored: StoredSamlConfig = { ...rest, ...keys };
    await inOrg(request, (tx) =>
      tx.organization.update({
        where: { id: org.id },
        data: {
          samlConfig: stored as unknown as Prisma.InputJsonValue,
          forceSso,
          trustedDomains: body.trustedDomains,
        },
      })
    );
    await configAudit(request, 'sso.config_update', {
      protocol: 'saml',
      idpEntityId: body.idpEntityId,
      trustedDomains: body.trustedDomains,
      forceSso,
      allowIdpInitiated: body.allowIdpInitiated,
    });
    return samlDto(request, stored, forceSso);
  });

  fastify.delete<{ Params: OrgParams }>(`${base}/sso/saml`, admin, async (request, reply) => {
    const org = request.org!;
    if (!org.samlConfig) throw new NotFoundError('SAML is not set up');
    await inOrg(request, (tx) =>
      tx.organization.update({
        where: { id: org.id },
        data: { samlConfig: Prisma.DbNull, ...(!org.oidcConfig && { forceSso: false }) },
      })
    );
    await configAudit(request, 'sso.config_delete', { protocol: 'saml' });
    return reply.code(204).send();
  });

  fastify.post<{ Params: OrgParams; Body: { metadataXml?: string } }>(
    `${base}/sso/saml/import`,
    { ...admin, bodyLimit: 1024 * 1024 },
    async (request) => {
      try {
        return parseIdpMetadata(String(request.body?.metadataXml ?? ''));
      } catch (err) {
        throw new BadRequestError((err as Error).message);
      }
    }
  );

  fastify.post<{ Params: OrgParams }>(`${base}/sso/saml/test`, admin, async (request) => {
    const test = await samlService.testUrl(subjectOf(request));
    if (!test) throw new NotFoundError('SAML is not set up');
    return test;
  });

  fastify.get<{ Params: OrgParams & { testId: string } }>(
    `${base}/sso/saml/test/:testId`,
    reader,
    async (request) => {
      const result = await samlService.testResult(request.params.testId);
      if (!result) throw new NotFoundError('No result for this test (it expires after 10 minutes)');
      return JSON.parse(result);
    }
  );

  // ─── Group rules (ORG-07) ─────────────────────────────────────────────────

  fastify.get<{ Params: OrgParams }>(`${base}/provisioning`, reader, async (request) =>
    orgProvisioning(request.org!.provisioning)
  );

  /** Applies at the next SSO login or SCIM change of each user. */
  fastify.put<{ Params: OrgParams }>(`${base}/provisioning`, admin, async (request) => {
    const body = OrgProvisioningSchema.parse(request.body);
    const org = request.org!;
    const slugs = [...new Set(body.rules.map((r) => r.workspace))];
    const found = await inOrg(request, (tx) =>
      tx.workspace.findMany({
        where: { organizationId: org.id, slug: { in: slugs } },
        select: { slug: true },
      })
    );
    const missing = slugs.filter((s) => !found.some((w) => w.slug === s));
    if (missing.length) {
      throw new BadRequestError(`Not workspaces of this organization: ${missing.join(', ')}`);
    }
    await inOrg(request, (tx) =>
      tx.organization.update({
        where: { id: org.id },
        data: { provisioning: body as unknown as Prisma.InputJsonValue },
      })
    );
    await configAudit(request, 'org.provisioning_update', {
      rules: body.rules.length,
      adminGroups: body.adminGroups,
    });
    return body;
  });

  // ─── SCIM (ORG-07) ────────────────────────────────────────────────────────

  const scimBaseUrl = (request: FastifyRequest) =>
    `${publicUrl}/scim/v2/orgs/${encodeURIComponent(request.org!.slug)}`;

  fastify.get<{ Params: OrgParams }>(`${base}/scim`, reader, async (request) => {
    const org = request.org!;
    const [users, groups] = await Promise.all([
      inOrg(request, (tx) =>
        tx.scimUser.count({ where: { organizationId: org.id, deletedAt: null, active: true } })
      ),
      inOrg(request, (tx) => tx.scimGroup.count({ where: { organizationId: org.id } })),
    ]);
    return {
      enabled: org.scimEnabled,
      baseUrl: scimBaseUrl(request),
      tokenCreatedAt: org.scimTokenCreatedAt,
      users,
      groups,
    };
  });

  // Creates or rotates the token (shown once); the old one stops working at once.
  fastify.post<{ Params: OrgParams }>(`${base}/scim/token`, admin, async (request) => {
    await fastify.container.plans.requireForOrg(request.org!.id, 'scim');
    const token = `hq_scim_${randomBytes(32).toString('base64url')}`;
    await inOrg(request, (tx) =>
      tx.organization.update({
        where: { id: request.org!.id },
        data: {
          scimEnabled: true,
          scimTokenHash: hashToken(token),
          scimTokenCreatedAt: new Date(),
        },
      })
    );
    await configAudit(request, 'scim.token_rotated');
    return { token, baseUrl: scimBaseUrl(request) };
  });

  fastify.delete<{ Params: OrgParams }>(`${base}/scim`, admin, async (request, reply) => {
    const { count } = await inOrg(request, (tx) =>
      tx.organization.updateMany({
        where: { id: request.org!.id, scimEnabled: true },
        data: { scimEnabled: false, scimTokenHash: null, scimTokenCreatedAt: null },
      })
    );
    if (!count) throw new NotFoundError('SCIM is not enabled');
    await configAudit(request, 'scim.disabled');
    return reply.code(204).send();
  });

  fastify.get<{ Params: OrgParams; Querystring: { limit?: string } }>(
    `${base}/scim/events`,
    reader,
    async (request) => {
      const take = Math.min(200, Math.max(1, Number(request.query.limit) || 50));
      const events = await inOrg(request, (tx) =>
        tx.scimAuditEvent.findMany({
          where: { organizationId: request.org!.id },
          orderBy: { createdAt: 'desc' },
          take,
        })
      );
      return { events };
    }
  );
}
