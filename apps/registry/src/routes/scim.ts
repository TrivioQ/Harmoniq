import { createHash, randomBytes } from 'crypto';
import { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { Prisma, PrismaClient, ScimUser } from '@prisma/client';
import type { TenantTx } from '@harmoniq/db';
import { NotFoundError } from '@harmoniq/core/dist/errors/AppError';
import { audit } from '../services/audit';
import {
  SCHEMA,
  ScimError,
  ScimPolicy,
  UserAttributes,
  groupResource,
  listResponse,
  paging,
  parseFilter,
  patchGroup,
  patchUser,
  scimPolicy,
  syncMembership,
  userAttributes,
  userResource,
} from '../services/scim';
import { syncOrgMember } from '../services/orgProvisioning';
import { SsoSubject, ssoProviderIds } from '../services/ssoIds';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by SCIM token authentication: whose SCIM service this is. */
    scim?: ScimContext;
    /** The resource a SCIM write touched, for its ScimAuditEvent. */
    scimResourceId?: string;
  }
}

type Json = Record<string, unknown>;
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const ACTOR = { principal: { type: 'system' as const, id: 'scim' } };

interface ScimOps {
  /** Brings the user's access in line with their SCIM state and groups. */
  sync(user: ScimUser, opts?: { fromGroups?: boolean }): Promise<void>;
  audit(event: {
    action: string;
    resourceType: string;
    resourceId: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
}

/**
 * A SCIM service provider: a workspace's (SSO-24/25) or an organization's (ORG-07).
 * `scope` selects (and stamps) its rows in the shared SCIM tables.
 */
interface ScimContext {
  scope: { workspaceId: string } | { organizationId: string };
  baseUrl: string;
  transaction<T>(fn: (tx: TenantTx, ops: ScimOps) => Promise<T>): Promise<T>;
  record(event: {
    operation: string;
    scimUserId: string;
    payload: Prisma.InputJsonValue;
    statusCode: number;
  }): Promise<void>;
}

/**
 * A workspace's SCIM: a tenant transaction with the group → role policy; afterwards,
 * ends the workspace SSO sessions of anyone it deprovisioned.
 */
function workspaceScim(fastify: FastifyInstance, workspace: { id: string; slug: string }) {
  const { systemDb, withTenant } = fastify.container;
  const context: ScimContext = {
    scope: { workspaceId: workspace.id },
    baseUrl: `${fastify.config.publicUrl}/scim/v2`,
    async transaction(fn) {
      let policy: ScimPolicy | undefined;
      const result = await withTenant(workspace.id, async (tx) => {
        const config = await tx.workspaceConfig.findUnique({
          where: { workspaceId: workspace.id },
        });
        const current = scimPolicy(config);
        policy = current;
        return fn(tx, {
          sync: (user, opts) => syncMembership(tx, workspace, current, user, opts),
          audit: async (event) => {
            await audit(tx, workspace.id, ACTOR, event);
          },
        });
      });
      if (policy?.deprovisioned.size) {
        await revokeSessions(systemDb, [...policy.deprovisioned], {
          kind: 'workspace',
          slug: workspace.slug,
        });
      }
      return result;
    },
    async record(event) {
      await withTenant(workspace.id, (tx) =>
        tx.scimAuditEvent.create({ data: { workspaceId: workspace.id, ...event } })
      );
    },
  };
  return context;
}

/**
 * ORG-07: an organization's SCIM. Users join the organization; its group rules assign
 * them to workspaces. Spans workspaces, so it runs with the system client.
 */
function orgScim(
  fastify: FastifyInstance,
  org: { id: string; slug: string; provisioning: unknown }
) {
  const { systemDb } = fastify.container;
  const context: ScimContext = {
    scope: { organizationId: org.id },
    baseUrl: `${fastify.config.publicUrl}/scim/v2/orgs/${encodeURIComponent(org.slug)}`,
    async transaction(fn) {
      const deprovisioned = new Set<string>();
      const result = await systemDb.$transaction(
        (tx) =>
          fn(tx, {
            sync: async (user) => {
              const groups = await tx.scimGroup.findMany({
                where: { organizationId: org.id, memberIds: { has: user.id } },
                select: { displayName: true },
              });
              const outcome = await syncOrgMember(tx, org, user.userId, {
                active: user.active && !user.deletedAt,
                groups: groups.map((g) => g.displayName),
                join: true,
                source: 'scim',
                actorId: 'scim',
              });
              if (outcome.deprovisioned) deprovisioned.add(user.userId);
            },
            audit: async (event) => {
              await tx.organizationAuditEvent.create({
                data: {
                  organizationId: org.id,
                  actorType: 'system',
                  actorId: 'system:scim',
                  ...event,
                  metadata: event.metadata as Prisma.InputJsonValue | undefined,
                },
              });
            },
          }),
        { timeout: 30_000 }
      );
      if (deprovisioned.size) {
        await revokeSessions(systemDb, [...deprovisioned], {
          kind: 'organization',
          slug: org.slug,
        });
      }
      return result;
    },
    async record(event) {
      await systemDb.scimAuditEvent.create({ data: { organizationId: org.id, ...event } });
    },
  };
  return context;
}

/** Sessions are system tables, outside the tenant's reach: revoked after the commit. */
const revokeSessions = (db: PrismaClient, userIds: string[], subject: SsoSubject) =>
  db.refreshToken.updateMany({
    where: { userId: { in: userIds }, provider: { in: ssoProviderIds(subject) }, revokedAt: null },
    data: { revokedAt: new Date() },
  });

/**
 * SSO-24/25, ORG-07: the SCIM 2.0 service provider, at `/scim/v2` for a workspace and at
 * `/scim/v2/orgs/:orgSlug` for an organization, authenticated by its token.
 */
const scimApi = (kind: 'workspace' | 'organization') => async (fastify: FastifyInstance) => {
  const { systemDb } = fastify.container;

  fastify.addContentTypeParser(
    'application/scim+json',
    { parseAs: 'string', bodyLimit: 1024 * 1024 },
    (_request, body, done) => {
      try {
        done(null, body ? JSON.parse(body as string) : {});
      } catch {
        done(new ScimError(400, 'Invalid JSON', 'invalidSyntax'), undefined);
      }
    }
  );

  fastify.setErrorHandler((err, request, reply) => {
    const status =
      err instanceof ScimError
        ? err.status
        : err.name === 'ZodError'
          ? 400
          : ((err as { statusCode?: number }).statusCode ?? 500);
    if (status >= 500) request.log.error(err);
    return reply
      .code(status)
      .type('application/scim+json')
      .send({
        schemas: [SCHEMA.error],
        status: String(status),
        ...(err instanceof ScimError && err.scimType && { scimType: err.scimType }),
        detail: status >= 500 ? 'Internal server error' : err.message,
      });
  });

  fastify.addHook('onRequest', async (request) => {
    const header = request.headers.authorization ?? '';
    const token = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
    if (!token) throw new ScimError(401, 'Invalid SCIM token');
    if (kind === 'workspace') {
      const config = await systemDb.workspaceConfig.findUnique({
        where: { scimTokenHash: hashToken(token) },
        include: { workspace: { select: { slug: true } } },
      });
      if (!config?.scimEnabled) throw new ScimError(401, 'Invalid SCIM token');
      request.scim = workspaceScim(fastify, {
        id: config.workspaceId,
        slug: config.workspace.slug,
      });
    } else {
      const org = await systemDb.organization.findUnique({
        where: { scimTokenHash: hashToken(token) },
      });
      const { orgSlug } = request.params as { orgSlug?: string };
      if (!org?.scimEnabled || org.deletedAt || org.slug !== orgSlug) {
        throw new ScimError(401, 'Invalid SCIM token');
      }
      request.scim = orgScim(fastify, org);
    }
  });

  fastify.addHook('onSend', async (_request, reply, payload) => {
    if (reply.getHeader('content-type')?.toString().startsWith('application/json')) {
      reply.type('application/scim+json');
    }
    return payload;
  });

  // Every write is recorded with its outcome (SSO-28); passwords never are.
  fastify.addHook('onResponse', async (request, reply) => {
    if (request.method === 'GET' || !request.scim) return;
    const body = { ...((request.body ?? {}) as Json) };
    delete body.password;
    const route =
      request.routeOptions.url?.replace(/^\/scim\/v2(\/orgs\/:orgSlug)?/, '') ?? request.url;
    try {
      await request.scim.record({
        operation: `${request.method} ${route}`,
        scimUserId:
          request.scimResourceId ?? (request.params as { id?: string } | undefined)?.id ?? '',
        payload: body as Prisma.InputJsonValue,
        statusCode: reply.statusCode,
      });
    } catch (err) {
      request.log.error({ err }, 'Recording a SCIM audit event failed');
    }
  });

  const ctx = (request: FastifyRequest) => request.scim!;

  const findUser = async (tx: TenantTx, context: ScimContext, id: string) => {
    const user = await tx.scimUser.findFirst({
      where: { id, ...context.scope, deletedAt: null },
      include: { user: { select: { email: true } } },
    });
    if (!user) throw new ScimError(404, 'User not found');
    return user;
  };

  const renderUser = async (
    tx: TenantTx,
    context: ScimContext,
    user: ScimUser & { user: { email: string } }
  ) => {
    const groups = await tx.scimGroup.findMany({
      where: { ...context.scope, memberIds: { has: user.id } },
      select: { id: true, displayName: true },
    });
    return userResource(context.baseUrl, { ...user, email: user.user.email }, groups);
  };

  const attributesOf = (user: ScimUser & { user: { email: string } }): UserAttributes => ({
    userName: user.userName,
    externalId: user.externalId,
    displayName: user.displayName,
    givenName: user.givenName,
    familyName: user.familyName,
    email: user.user.email,
    active: user.active,
  });

  /** Saves attributes onto a SCIM user and brings the membership in line. */
  const applyUser = async (
    tx: TenantTx,
    context: ScimContext,
    ops: ScimOps,
    id: string,
    attrs: UserAttributes
  ) => {
    if (!attrs.userName) throw new ScimError(400, 'userName is required', 'invalidValue');
    const clash = await tx.scimUser.findFirst({
      where: { ...context.scope, userName: attrs.userName, id: { not: id } },
    });
    if (clash) throw new ScimError(409, 'userName is already in use', 'uniqueness');
    const updated = await tx.scimUser.update({
      where: { id },
      data: {
        userName: attrs.userName,
        externalId: attrs.externalId,
        displayName: attrs.displayName,
        givenName: attrs.givenName,
        familyName: attrs.familyName,
        active: attrs.active ?? true,
      },
      include: { user: { select: { email: true } } },
    });
    await ops.sync(updated);
    return updated;
  };

  // ─── Discovery (RFC 7643 §5–7) ────────────────────────────────────────────

  fastify.get('/ServiceProviderConfig', async () => ({
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: 'oauthbearertoken',
        name: 'Bearer token',
        description: 'The SCIM token from the workspace or organization provisioning settings',
        primary: true,
      },
    ],
  }));

  fastify.get('/ResourceTypes', async () =>
    listResponse(
      [
        { id: 'User', name: 'User', endpoint: '/Users', schema: SCHEMA.user },
        { id: 'Group', name: 'Group', endpoint: '/Groups', schema: SCHEMA.group },
      ].map((r) => ({ schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], ...r })),
      2,
      1
    )
  );

  // ─── Users ────────────────────────────────────────────────────────────────

  fastify.get<{ Querystring: { filter?: string; startIndex?: string; count?: string } }>(
    '/Users',
    async (request) => {
      const filter = parseFilter(request.query.filter, ['userName', 'externalId', 'emails.value']);
      const page = paging(request.query);
      const context = ctx(request);
      return context.transaction(async (tx) => {
        const where: Prisma.ScimUserWhereInput = {
          ...context.scope,
          deletedAt: null,
          ...(filter?.attribute === 'userName' && {
            userName: { equals: filter.value, mode: 'insensitive' },
          }),
          ...(filter?.attribute === 'externalId' && { externalId: filter.value }),
          ...(filter?.attribute === 'emails.value' && {
            user: { email: filter.value.toLowerCase() },
          }),
        };
        const [total, users] = await Promise.all([
          tx.scimUser.count({ where }),
          tx.scimUser.findMany({
            where,
            include: { user: { select: { email: true } } },
            orderBy: { createdAt: 'asc' },
            skip: page.skip,
            take: page.take,
          }),
        ]);
        const resources = await Promise.all(users.map((u) => renderUser(tx, context, u)));
        return listResponse(resources, total, page.startIndex);
      });
    }
  );

  fastify.get<{ Params: { id: string } }>('/Users/:id', async (request) => {
    const context = ctx(request);
    return context.transaction(async (tx) =>
      renderUser(tx, context, await findUser(tx, context, request.params.id))
    );
  });

  fastify.post('/Users', async (request, reply) => {
    const attrs = userAttributes((request.body ?? {}) as Json);
    if (!attrs.userName) throw new ScimError(400, 'userName is required', 'invalidValue');
    const email = (attrs.email ?? (attrs.userName.includes('@') ? attrs.userName : ''))
      .trim()
      .toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) {
      throw new ScimError(400, 'An email address is required (emails or userName)', 'invalidValue');
    }
    // Users are global; the SCIM user links the IdP account to one.
    const user =
      (await systemDb.user.findUnique({ where: { email } })) ??
      (await systemDb.user.create({
        data: {
          email,
          name:
            attrs.displayName ??
            ([attrs.givenName, attrs.familyName].filter(Boolean).join(' ') || null),
        },
      }));

    const context = ctx(request);
    const created = await context.transaction(async (tx, ops) => {
      const existing = await tx.scimUser.findFirst({
        where: {
          ...context.scope,
          OR: [{ userId: user.id }, { userName: { equals: attrs.userName, mode: 'insensitive' } }],
        },
      });
      // A deleted user coming back is the same resource again.
      if (existing && !existing.deletedAt) {
        throw new ScimError(409, 'The user already exists', 'uniqueness');
      }
      const row =
        existing ??
        (await tx.scimUser.create({
          data: { ...context.scope, userId: user.id, userName: attrs.userName! },
        }));
      if (existing) {
        await tx.scimUser.update({
          where: { id: row.id },
          data: { deletedAt: null, userId: user.id },
        });
      }
      const saved = await applyUser(tx, context, ops, row.id, attrs);
      return renderUser(tx, context, saved);
    });
    request.scimResourceId = created.id;
    return reply.code(201).header('location', created.meta.location).send(created);
  });

  fastify.put<{ Params: { id: string } }>('/Users/:id', async (request) => {
    const context = ctx(request);
    return context.transaction(async (tx, ops) => {
      await findUser(tx, context, request.params.id);
      const attrs = userAttributes((request.body ?? {}) as Json);
      const saved = await applyUser(tx, context, ops, request.params.id, attrs);
      return renderUser(tx, context, saved);
    });
  });

  fastify.patch<{ Params: { id: string } }>('/Users/:id', async (request) => {
    const context = ctx(request);
    return context.transaction(async (tx, ops) => {
      const current = await findUser(tx, context, request.params.id);
      const attrs = patchUser(attributesOf(current), (request.body ?? {}) as Json);
      const saved = await applyUser(tx, context, ops, current.id, attrs);
      return renderUser(tx, context, saved);
    });
  });

  // SSO-25: deprovisioning. The row stays (deleted) so SSO can't re-add the user.
  fastify.delete<{ Params: { id: string } }>('/Users/:id', async (request, reply) => {
    const context = ctx(request);
    await context.transaction(async (tx, ops) => {
      const current = await findUser(tx, context, request.params.id);
      const deleted = await tx.scimUser.update({
        where: { id: current.id },
        data: { active: false, deletedAt: new Date() },
      });
      // Out of every group, so re-provisioning starts clean.
      const groups = await tx.scimGroup.findMany({
        where: { ...context.scope, memberIds: { has: current.id } },
      });
      for (const g of groups) {
        await tx.scimGroup.update({
          where: { id: g.id },
          data: { memberIds: g.memberIds.filter((m) => m !== current.id) },
        });
      }
      await ops.sync(deleted);
    });
    return reply.code(204).send();
  });

  // ─── Groups ───────────────────────────────────────────────────────────────

  const renderGroup = async (
    tx: TenantTx,
    context: ScimContext,
    group: Prisma.ScimGroupGetPayload<object>
  ) => {
    const members = await tx.scimUser.findMany({
      where: { id: { in: group.memberIds }, deletedAt: null },
      select: { id: true, userName: true },
    });
    return groupResource(context.baseUrl, group, members);
  };

  const findGroup = async (tx: TenantTx, context: ScimContext, id: string) => {
    const group = await tx.scimGroup.findFirst({ where: { id, ...context.scope } });
    if (!group) throw new ScimError(404, 'Group not found');
    return group;
  };

  /** Saves a group and re-syncs everyone whose groups changed. */
  const saveGroup = async (
    tx: TenantTx,
    context: ScimContext,
    ops: ScimOps,
    id: string | null,
    change: { displayName?: string; externalId?: string | null; members: Set<string> },
    previous: string[] = []
  ) => {
    if (!change.displayName) throw new ScimError(400, 'displayName is required', 'invalidValue');
    const clash = await tx.scimGroup.findFirst({
      where: {
        ...context.scope,
        displayName: change.displayName,
        ...(id && { id: { not: id } }),
      },
    });
    if (clash) throw new ScimError(409, 'displayName is already in use', 'uniqueness');
    // Only this provider's live users can be members.
    const known = await tx.scimUser.findMany({
      where: { ...context.scope, id: { in: [...change.members] }, deletedAt: null },
      select: { id: true },
    });
    const data = {
      displayName: change.displayName,
      externalId: change.externalId ?? null,
      memberIds: known.map((u) => u.id),
    };
    const group = id
      ? await tx.scimGroup.update({ where: { id }, data })
      : await tx.scimGroup.create({ data: { ...context.scope, ...data } });
    const affected = await tx.scimUser.findMany({
      where: { id: { in: [...new Set([...previous, ...data.memberIds])] }, deletedAt: null },
    });
    for (const user of affected) {
      await ops.sync(user, { fromGroups: true });
    }
    await ops.audit({
      action: id ? 'scim.group_updated' : 'scim.group_created',
      resourceType: 'scim_group',
      resourceId: group.id,
      metadata: { displayName: group.displayName, members: group.memberIds.length },
    });
    return group;
  };

  fastify.get<{ Querystring: { filter?: string; startIndex?: string; count?: string } }>(
    '/Groups',
    async (request) => {
      const filter = parseFilter(request.query.filter, ['displayName', 'externalId']);
      const page = paging(request.query);
      const context = ctx(request);
      return context.transaction(async (tx) => {
        const where: Prisma.ScimGroupWhereInput = {
          ...context.scope,
          ...(filter?.attribute === 'displayName' && { displayName: filter.value }),
          ...(filter?.attribute === 'externalId' && { externalId: filter.value }),
        };
        const [total, groups] = await Promise.all([
          tx.scimGroup.count({ where }),
          tx.scimGroup.findMany({
            where,
            orderBy: { createdAt: 'asc' },
            skip: page.skip,
            take: page.take,
          }),
        ]);
        const resources = await Promise.all(groups.map((g) => renderGroup(tx, context, g)));
        return listResponse(resources, total, page.startIndex);
      });
    }
  );

  fastify.get<{ Params: { id: string } }>('/Groups/:id', async (request) => {
    const context = ctx(request);
    return context.transaction(async (tx) =>
      renderGroup(tx, context, await findGroup(tx, context, request.params.id))
    );
  });

  const membersOf = (body: Json) =>
    new Set(
      (Array.isArray(body.members) ? (body.members as Json[]) : [])
        .map((m) => m.value)
        .filter((v): v is string => typeof v === 'string')
    );

  fastify.post('/Groups', async (request, reply) => {
    const body = (request.body ?? {}) as Json;
    const context = ctx(request);
    const created = await context.transaction(async (tx, ops) =>
      renderGroup(
        tx,
        context,
        await saveGroup(tx, context, ops, null, {
          displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
          externalId: typeof body.externalId === 'string' ? body.externalId : null,
          members: membersOf(body),
        })
      )
    );
    request.scimResourceId = created.id;
    return reply.code(201).header('location', created.meta.location).send(created);
  });

  fastify.put<{ Params: { id: string } }>('/Groups/:id', async (request) => {
    const context = ctx(request);
    return context.transaction(async (tx, ops) => {
      const current = await findGroup(tx, context, request.params.id);
      const body = (request.body ?? {}) as Json;
      const saved = await saveGroup(
        tx,
        context,
        ops,
        current.id,
        {
          displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
          externalId: typeof body.externalId === 'string' ? body.externalId : null,
          members: membersOf(body),
        },
        current.memberIds
      );
      return renderGroup(tx, context, saved);
    });
  });

  fastify.patch<{ Params: { id: string } }>('/Groups/:id', async (request) => {
    const context = ctx(request);
    return context.transaction(async (tx, ops) => {
      const current = await findGroup(tx, context, request.params.id);
      const change = patchGroup(
        {
          displayName: current.displayName,
          externalId: current.externalId,
          members: new Set(current.memberIds),
        },
        (request.body ?? {}) as Json
      );
      return renderGroup(
        tx,
        context,
        await saveGroup(tx, context, ops, current.id, change, current.memberIds)
      );
    });
  });

  fastify.delete<{ Params: { id: string } }>('/Groups/:id', async (request, reply) => {
    const context = ctx(request);
    await context.transaction(async (tx, ops) => {
      const current = await findGroup(tx, context, request.params.id);
      await tx.scimGroup.delete({ where: { id: current.id } });
      const affected = await tx.scimUser.findMany({
        where: { id: { in: current.memberIds }, deletedAt: null },
      });
      for (const user of affected) {
        await ops.sync(user, { fromGroups: true });
      }
      await ops.audit({
        action: 'scim.group_deleted',
        resourceType: 'scim_group',
        resourceId: current.id,
        metadata: { displayName: current.displayName },
      });
    });
    return reply.code(204).send();
  });
};

/** Settings → Provisioning: the SCIM endpoint and its token (admins). */
const scimSettings = async (fastify: FastifyInstance) => {
  const { withTenant } = fastify.container;
  const path = '/api/workspaces/:workspaceSlug/scim';
  const baseUrl = `${fastify.config.publicUrl}/scim/v2`;
  const admin = { preHandler: fastify.requireWorkspace('workspace:admin') };
  const actor = (request: FastifyRequest) => ({ principal: request.principal!, ip: request.ip });

  fastify.get<{ Params: { workspaceSlug: string } }>(path, admin, async (request) => {
    const workspace = request.workspace!;
    return withTenant(workspace.id, async (tx) => {
      const [config, users, groups] = await Promise.all([
        tx.workspaceConfig.findUnique({ where: { workspaceId: workspace.id } }),
        tx.scimUser.count({ where: { workspaceId: workspace.id, deletedAt: null, active: true } }),
        tx.scimGroup.count({ where: { workspaceId: workspace.id } }),
      ]);
      return {
        enabled: config?.scimEnabled ?? false,
        baseUrl,
        tokenCreatedAt: config?.scimTokenCreatedAt ?? null,
        users,
        groups,
      };
    });
  });

  // Creates or rotates the token (shown once); the old one stops working at once.
  fastify.post<{ Params: { workspaceSlug: string } }>(`${path}/token`, admin, async (request) => {
    const workspace = request.workspace!;
    // SSO-24: an enterprise feature.
    await fastify.container.plans.requireForWorkspace(workspace.id, 'scim');
    const token = `hq_scim_${randomBytes(32).toString('base64url')}`;
    const data = {
      scimEnabled: true,
      scimTokenHash: hashToken(token),
      scimTokenCreatedAt: new Date(),
    };
    await withTenant(workspace.id, async (tx) => {
      await tx.workspaceConfig.upsert({
        where: { workspaceId: workspace.id },
        create: { workspaceId: workspace.id, ...data },
        update: data,
      });
      await audit(tx, workspace.id, actor(request), {
        action: 'scim.token_rotated',
        resourceType: 'workspace',
        resourceId: workspace.id,
      });
    });
    return { token, baseUrl };
  });

  fastify.delete<{ Params: { workspaceSlug: string } }>(path, admin, async (request, reply) => {
    const workspace = request.workspace!;
    await withTenant(workspace.id, async (tx) => {
      const { count } = await tx.workspaceConfig.updateMany({
        where: { workspaceId: workspace.id, scimEnabled: true },
        data: { scimEnabled: false, scimTokenHash: null, scimTokenCreatedAt: null },
      });
      if (!count) throw new NotFoundError('SCIM is not enabled');
      await audit(tx, workspace.id, actor(request), {
        action: 'scim.disabled',
        resourceType: 'workspace',
        resourceId: workspace.id,
      });
    });
    return reply.code(204).send();
  });

  fastify.get<{ Params: { workspaceSlug: string }; Querystring: { limit?: string } }>(
    `${path}/events`,
    admin,
    async (request) => {
      const workspace = request.workspace!;
      const take = Math.min(200, Math.max(1, Number(request.query.limit) || 50));
      const events = await withTenant(workspace.id, (tx) =>
        tx.scimAuditEvent.findMany({
          where: { workspaceId: workspace.id },
          orderBy: { createdAt: 'desc' },
          take,
        })
      );
      return { events };
    }
  );
};

const scimRoutes: FastifyPluginAsync = async (fastify) => {
  await fastify.register(scimApi('workspace'), { prefix: '/scim/v2' });
  await fastify.register(scimApi('organization'), { prefix: '/scim/v2/orgs/:orgSlug' });
  await fastify.register(scimSettings);
};

export default scimRoutes;
