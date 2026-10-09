import { createHash } from 'crypto';
import { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { IdentityError, IdentityUserInfo } from '@harmoniq/core/dist/ports/IdentityProvider';
import {
  AuthCallbackRequestSchema,
  AuthProviderSummary,
  AuthStartRequestSchema,
  DevLoginRequestSchema,
  EmailLoginRequestSchema,
  EmailLoginVerifySchema,
  MeResponse,
  RefreshRequestSchema,
} from '@harmoniq/core/dist/schemas/AuthSchemas';
import { EmailIdentityProvider } from '../adapters/identity/EmailIdentityProvider';
import { AuthService } from '../services/authService';
import { ssoScope } from '../plugins/authenticate';
import { provisionSsoMember, workspaceProviderId } from '../services/sso';
import { samlProviderId } from '../services/saml';
import { openSecret, sealSecret } from '../services/crypto';
import { Prisma } from '@prisma/client';

const LOGIN_RATE_LIMIT = { rateLimit: { max: 20, timeWindow: '1 minute' } };
// Per session, not per IP: every refresh arrives from the dashboard's server, so an IP
// limit would be shared by all users. Runs after body parsing to see the token.
const REFRESH_RATE_LIMIT = {
  rateLimit: {
    max: 30,
    timeWindow: '1 minute',
    hook: 'preHandler' as const,
    keyGenerator: (request: FastifyRequest) => {
      const token = (request.body as { refreshToken?: unknown } | undefined)?.refreshToken;
      return typeof token === 'string'
        ? `refresh:${createHash('sha256').update(token).digest('base64url')}`
        : `refresh-ip:${request.ip}`;
    },
  },
};

const authRoutes: FastifyPluginAsync = async (fastify) => {
  const { config } = fastify;
  const { systemDb, logger, mailer } = fastify.container;
  // GitHub, instance OIDC and per-workspace OIDC (`oidc:<workspace>`).
  const providers = fastify.ssoProviders;
  const auth = new AuthService(systemDb, config.jwtSecret, logger, {
    seal: (plain) => sealSecret(plain, config.encryptionKey),
    open: (sealed) => openSecret(sealed, config.encryptionKey),
    check: (provider, token) => providers.checkSession(provider, token),
  });

  // Email sign-in needs a way to send mail (SMTP, or the console mailer outside production).
  const email = mailer ? new EmailIdentityProvider(systemDb, mailer) : null;

  const badRequest = (reply: FastifyReply, error: ZodError | string) =>
    reply.code(400).send({
      error: {
        code: 'BAD_REQUEST',
        message: typeof error === 'string' ? error : 'Invalid request',
        ...(typeof error !== 'string' && { details: error.flatten() }),
      },
    });

  // Codes must only ever be sent back to the dashboard (no open redirect / code injection).
  const isAllowedRedirect = (uri: string) => {
    try {
      return new URL(uri).origin === new URL(config.webOrigin).origin;
    } catch {
      return false;
    }
  };

  const identityFailure = (reply: FastifyReply, err: unknown) => {
    if (err instanceof IdentityError) {
      const status = err.code === 'provider_unavailable' ? 502 : 401;
      return reply
        .code(status)
        .send({ error: { code: err.code.toUpperCase(), message: err.message } });
    }
    throw err;
  };

  fastify.get('/api/auth/providers', async () => {
    const list: AuthProviderSummary[] = providers.list().map((p) => ({
      id: p.id,
      kind: p.kind,
      displayName: p.displayName,
    }));
    if (email) list.push({ id: email.id, kind: email.kind, displayName: email.displayName });
    if (config.devLogin) {
      list.push({ id: 'dev', kind: 'dev', displayName: 'Development login' });
    }
    return { providers: list };
  });

  // "Sign in with SSO": the workspace whose OIDC trusts this email's domain (SSO discovery).
  fastify.get<{ Querystring: { email?: string } }>(
    '/api/auth/sso/discover',
    { config: LOGIN_RATE_LIMIT },
    async (request, reply) => {
      const domain = request.query.email?.trim().toLowerCase().split('@')[1];
      if (!domain) return badRequest(reply, 'email is required');
      const configs = await systemDb.workspaceConfig.findMany({
        where: {
          OR: [{ oidcConfig: { not: Prisma.DbNull } }, { samlConfig: { not: Prisma.DbNull } }],
        },
        include: { workspace: { select: { slug: true, name: true } } },
      });
      const trusts = (config: unknown) =>
        ((config as { trustedDomains?: string[] } | null)?.trustedDomains ?? []).includes(domain);
      const match = configs.find((c) => trusts(c.oidcConfig) || trusts(c.samlConfig));
      if (!match) {
        return reply
          .code(404)
          .send({ error: { code: 'NOT_FOUND', message: 'No single sign-on for this domain' } });
      }
      return {
        // OIDC when both are set up.
        provider: trusts(match.oidcConfig)
          ? workspaceProviderId(match.workspace.slug)
          : samlProviderId(match.workspace.slug),
        workspace: { slug: match.workspace.slug, name: match.workspace.name },
      };
    }
  );

  /** Session for a proven identity; workspace SSO also provisions the membership. */
  async function finishLogin(info: IdentityUserInfo, providerId: string, ip: string) {
    const { user, response } = await auth.login(info, providerId);
    const sso = await providers.policyFor(providerId);
    if (sso) await provisionSsoMember(fastify, sso.slug, providerId, sso.policy, user.id, info, ip);
    return response;
  }

  // SSO-09: IdP-initiated SAML logins have no browser state to bind to (the workspace
  // opts in); the dashboard redeems the one-time code the ACS issued.
  fastify.post<{ Body: { code?: string; provider?: string } }>(
    '/api/auth/saml/redeem',
    { config: LOGIN_RATE_LIMIT },
    async (request, reply) => {
      const { code, provider } = request.body ?? {};
      if (!code || !provider?.startsWith('saml:'))
        return badRequest(reply, 'code and provider are required');
      try {
        const info = await providers.samlService.redeem(code, null, provider);
        return await finishLogin(info, provider, request.ip);
      } catch (err) {
        return identityFailure(reply, err);
      }
    }
  );

  fastify.post<{ Params: { provider: string } }>(
    '/api/auth/:provider/start',
    { config: LOGIN_RATE_LIMIT },
    async (request, reply) => {
      const provider = await providers.get(request.params.provider);
      if (!provider) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Unknown provider' } });
      }
      const parsed = AuthStartRequestSchema.safeParse(request.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      if (!isAllowedRedirect(parsed.data.redirectUri)) {
        return badRequest(reply, 'redirectUri must be on the dashboard origin');
      }
      try {
        return { authorizationUrl: await provider.getAuthorizationUrl(parsed.data) };
      } catch (err) {
        return identityFailure(reply, err);
      }
    }
  );

  fastify.post<{ Params: { provider: string } }>(
    '/api/auth/:provider/callback',
    { config: LOGIN_RATE_LIMIT },
    async (request, reply) => {
      const provider = await providers.get(request.params.provider);
      if (!provider) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Unknown provider' } });
      }
      const parsed = AuthCallbackRequestSchema.safeParse(request.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      if (!isAllowedRedirect(parsed.data.redirectUri)) {
        return badRequest(reply, 'redirectUri must be on the dashboard origin');
      }
      try {
        const info = await provider.handleCallback(parsed.data);
        return await finishLogin(info, provider.id, request.ip);
      } catch (err) {
        return identityFailure(reply, err);
      }
    }
  );

  // Development only (refused at startup in production): sign in as any email.
  if (config.devLogin) {
    fastify.post('/api/auth/dev/login', { config: LOGIN_RATE_LIMIT }, async (request, reply) => {
      const parsed = DevLoginRequestSchema.safeParse(request.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      return auth.completeLogin(
        {
          providerUserId: parsed.data.email.toLowerCase(),
          email: parsed.data.email,
          emailVerified: true,
          name: parsed.data.name,
        },
        'dev'
      );
    });
  }

  if (email) {
    // Always 202, whether or not an account exists (no user enumeration).
    fastify.post(
      '/api/auth/email/request',
      { config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } },
      async (request, reply) => {
        const parsed = EmailLoginRequestSchema.safeParse(request.body);
        if (!parsed.success) return badRequest(reply, parsed.error);
        if (!isAllowedRedirect(parsed.data.redirectUri)) {
          return badRequest(reply, 'redirectUri must be on the dashboard origin');
        }
        await email.requestLogin(parsed.data);
        return reply.code(202).send({ status: 'sent' });
      }
    );

    fastify.post('/api/auth/email/verify', { config: LOGIN_RATE_LIMIT }, async (request, reply) => {
      const parsed = EmailLoginVerifySchema.safeParse(request.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        const info = await email.verifyLogin(parsed.data);
        return await auth.completeLogin(info, email.id);
      } catch (err) {
        return identityFailure(reply, err);
      }
    });
  }

  fastify.post('/api/auth/refresh', { config: REFRESH_RATE_LIMIT }, async (request, reply) => {
    const parsed = RefreshRequestSchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const session = await auth.refresh(parsed.data.refreshToken);
    if (!session) {
      return reply
        .code(401)
        .send({ error: { code: 'UNAUTHORIZED', message: 'Refresh token is invalid or expired' } });
    }
    return session;
  });

  fastify.post('/api/auth/logout', { config: REFRESH_RATE_LIMIT }, async (request, reply) => {
    const parsed = RefreshRequestSchema.safeParse(request.body);
    if (parsed.success) await auth.logout(parsed.data.refreshToken);
    return reply.code(204).send();
  });

  fastify.get('/api/me', { preHandler: fastify.authenticate }, async (request, reply) => {
    const principal = request.principal!;
    if (principal.type !== 'user') {
      return reply
        .code(400)
        .send({ error: { code: 'BAD_REQUEST', message: '/api/me requires a user session' } });
    }
    const user = await auth.sessionUser(principal.id);
    if (!user)
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'User not found' } });

    const scope = ssoScope(principal);
    const memberships = await systemDb.workspaceMember.findMany({
      // A workspace-SSO session only sees that workspace.
      where: {
        userId: principal.id,
        joinedAt: { not: null },
        ...(scope && { workspace: { slug: scope } }),
      },
      include: { workspace: true },
      orderBy: { workspace: { name: 'asc' } },
    });
    const body: MeResponse = {
      // Instance-admin powers never come from a workspace's IdP.
      user: scope ? { ...user, isInstanceAdmin: false } : user,
      workspaces: memberships.map((m) => ({
        slug: m.workspace.slug,
        name: m.workspace.name,
        role: m.role,
      })),
    };
    return body;
  });
};

export default authRoutes;
