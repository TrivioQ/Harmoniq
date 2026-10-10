import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { ValidateInResponseTo } from '@node-saml/node-saml';
import { BadRequestError, NotFoundError } from '@harmoniq/core/dist/errors/AppError';
import { disabledProtocol as disabled } from '../services/sso';
import { IdentityError } from '@harmoniq/core/dist/ports/IdentityProvider';
import { SamlConfigSchema } from '@harmoniq/core/dist/schemas/SsoSchema';
import { audit } from '../services/audit';
import { sealSecret } from '../services/crypto';
import {
  StoredSamlConfig,
  generateSpKeyPair,
  parseIdpMetadata,
  samlProviderId,
  samlUrls,
} from '../services/saml';
import { ssoProviderId } from '../services/ssoIds';

type SlugParams = { workspaceSlug: string };

// SSO-09..20, ORG-06. Public SP endpoints for workspaces and organizations, and the
// workspace settings API (organization settings live with the org routes).
const samlRoutes: FastifyPluginAsync = async (fastify) => {
  const { withTenant, systemDb } = fastify.container;
  const { encryptionKey, publicUrl, webOrigin } = fastify.config;
  const service = fastify.ssoProviders.samlService;
  const actor = (request: FastifyRequest) => ({ principal: request.principal!, ip: request.ip });

  // IdPs post form-encoded SAMLResponse / SAMLRequest.
  fastify.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 1024 * 1024 },
    (_request, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string)))
  );

  const loginError = (code: string) => `${webOrigin}/auth/login?error=${encodeURIComponent(code)}`;

  // ─── Service provider endpoints (public) ──────────────────────────────────
  // A workspace's at /auth/saml/:slug, an organization's at /auth/org-saml/:slug (ORG-06).

  for (const kind of ['workspace', 'organization'] as const) {
    const base = kind === 'workspace' ? '/auth/saml/:slug' : '/auth/org-saml/:slug';
    const subjectOf = (request: FastifyRequest) => ({
      kind,
      slug: (request.params as { slug: string }).slug,
    });

    fastify.get(`${base}/metadata`, async (request, reply) => {
      const xml = await service.metadata(subjectOf(request));
      if (!xml) throw new NotFoundError(`SAML is not set up for this ${kind}`);
      return reply.type('application/samlmetadata+xml').send(xml);
    });

    // SSO-10/14: the assertion consumer service.
    fastify.post(
      `${base}/acs`,
      { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
      async (request, reply) => {
        try {
          const target = await service.acs(
            subjectOf(request),
            (request.body ?? {}) as Record<string, string>
          );
          return reply.redirect(target, 303);
        } catch (err) {
          if (err instanceof IdentityError) {
            request.log.warn({ err }, 'SAML response refused');
            return reply.redirect(loginError(err.code), 303);
          }
          throw err;
        }
      }
    );

    // SSO-12: SP-initiated login starts in the dashboard (state + PKCE), then the IdP.
    fastify.get(`${base}/login`, async (request, reply) =>
      reply.redirect(
        `${webOrigin}/api/auth/login/${encodeURIComponent(ssoProviderId('saml', subjectOf(request)))}`,
        302
      )
    );

    // SSO-13: logout at the IdP after signing out here (the dashboard clears its session).
    fastify.get(`${base}/logout`, async (request, reply) => {
      const loaded = await service.load(subjectOf(request));
      return reply.redirect(loaded?.config.idpSloUrl ?? `${webOrigin}/auth/login`, 302);
    });

    // SSO-13: IdP-initiated single logout ends the user's sessions from this IdP.
    fastify.post(`${base}/slo`, async (request, reply) => {
      const subject = subjectOf(request);
      const loaded = await service.load(subject);
      if (!loaded) throw new NotFoundError(`SAML is not set up for this ${kind}`);
      const saml = service.saml(subject, loaded.config, ValidateInResponseTo.never);
      const body = (request.body ?? {}) as Record<string, string>;
      let profile;
      try {
        ({ profile } = await saml.validatePostRequestAsync(body));
      } catch (err) {
        throw new BadRequestError(`Invalid logout request: ${(err as Error).message}`);
      }
      if (!profile) throw new BadRequestError('Invalid logout request');
      const email = (profile.nameID ?? '').toLowerCase();
      const user = email ? await systemDb.user.findFirst({ where: { email } }) : null;
      if (user) {
        await systemDb.refreshToken.updateMany({
          where: { userId: user.id, provider: ssoProviderId('saml', subject), revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
      return reply.redirect(
        await saml.getLogoutResponseUrlAsync(profile, body.RelayState ?? '', {}, true),
        302
      );
    });
  }

  // ─── Settings (admins) ────────────────────────────────────────────────────

  const settingsPath = '/api/workspaces/:workspaceSlug/sso/saml';
  const dto = (slug: string, stored: StoredSamlConfig | null, forceSso: boolean) => ({
    // The SP side, to register at the IdP.
    serviceProvider: {
      ...samlUrls(publicUrl, { kind: 'workspace', slug }),
      cert: stored?.spCert ?? null,
    },
    saml: stored && {
      ...stored,
      spPrivateKey: undefined,
      forceSso,
      providerId: samlProviderId(slug),
    },
  });

  fastify.get<{ Params: SlugParams }>(
    settingsPath,
    { preHandler: fastify.requireWorkspace('workspace:admin') },
    async (request) => {
      const workspace = request.workspace!;
      const config = await withTenant(workspace.id, (tx) =>
        tx.workspaceConfig.findUnique({ where: { workspaceId: workspace.id } })
      );
      return dto(
        workspace.slug,
        (config?.samlConfig as StoredSamlConfig | null) ?? null,
        config?.forceSso ?? false
      );
    }
  );

  fastify.put<{ Params: SlugParams }>(
    settingsPath,
    { preHandler: fastify.requireWorkspace('workspace:admin') },
    async (request) => {
      if (!fastify.ssoProviders.protocolEnabled('saml')) throw disabled('saml');
      const body = SamlConfigSchema.parse(request.body);
      const workspace = request.workspace!;
      const current = await withTenant(workspace.id, (tx) =>
        tx.workspaceConfig.findUnique({ where: { workspaceId: workspace.id } })
      );
      const previous = current?.samlConfig as StoredSamlConfig | null | undefined;
      // SSO-18: generated once per workspace, the private key sealed at rest.
      const keys = previous
        ? { spPrivateKey: previous.spPrivateKey, spCert: previous.spCert }
        : (() => {
            const pair = generateSpKeyPair(workspace.slug);
            return { spPrivateKey: sealSecret(pair.privateKey, encryptionKey), spCert: pair.cert };
          })();
      const { forceSso, ...rest } = body;
      const stored: StoredSamlConfig = { ...rest, ...keys };
      await withTenant(workspace.id, async (tx) => {
        const data = {
          samlConfig: stored as unknown as Prisma.InputJsonValue,
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
          metadata: {
            protocol: 'saml',
            idpEntityId: body.idpEntityId,
            trustedDomains: body.trustedDomains,
            forceSso,
            allowIdpInitiated: body.allowIdpInitiated,
          },
        });
      });
      return dto(workspace.slug, stored, forceSso);
    }
  );

  fastify.delete<{ Params: SlugParams }>(
    settingsPath,
    { preHandler: fastify.requireWorkspace('workspace:admin') },
    async (request, reply) => {
      const workspace = request.workspace!;
      await withTenant(workspace.id, async (tx) => {
        const { count } = await tx.workspaceConfig.updateMany({
          where: { workspaceId: workspace.id, samlConfig: { not: Prisma.DbNull } },
          data: { samlConfig: Prisma.DbNull },
        });
        if (!count) throw new NotFoundError('SAML is not set up');
        await audit(tx, workspace.id, actor(request), {
          action: 'sso.config_delete',
          resourceType: 'workspace',
          resourceId: workspace.id,
          metadata: { protocol: 'saml' },
        });
      });
      return reply.code(204).send();
    }
  );

  // SSO-17: read the IdP settings from its metadata XML (not saved; the form is filled).
  fastify.post<{ Params: SlugParams; Body: { metadataXml?: string } }>(
    `${settingsPath}/import`,
    { preHandler: fastify.requireWorkspace('workspace:admin'), bodyLimit: 1024 * 1024 },
    async (request) => {
      try {
        return parseIdpMetadata(String(request.body?.metadataXml ?? ''));
      } catch (err) {
        throw new BadRequestError((err as Error).message);
      }
    }
  );

  // SSO-20: a test login showing the assertion's attributes; no session is created.
  fastify.post<{ Params: SlugParams }>(
    `${settingsPath}/test`,
    { preHandler: fastify.requireWorkspace('workspace:admin') },
    async (request) => {
      const test = await service.testUrl({ kind: 'workspace', slug: request.workspace!.slug });
      if (!test) throw new NotFoundError('SAML is not set up');
      return test;
    }
  );

  fastify.get<{ Params: SlugParams & { testId: string } }>(
    `${settingsPath}/test/:testId`,
    { preHandler: fastify.requireWorkspace('workspace:admin') },
    async (request) => {
      const result = await service.testResult(request.params.testId);
      if (!result) throw new NotFoundError('No result for this test (it expires after 10 minutes)');
      return JSON.parse(result);
    }
  );
};

export default samlRoutes;
