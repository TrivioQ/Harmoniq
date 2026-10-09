import { createHash, randomBytes } from 'crypto';
import { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { Prisma, ScimUser } from '@prisma/client';
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

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by SCIM token authentication. */
    scim?: { workspaceId: string; slug: string };
    /** The resource a SCIM write touched, for its ScimAuditEvent. */
    scimResourceId?: string;
  }
}

type Json = Record<string, unknown>;
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** SSO-24/25: the SCIM 2.0 service provider at `/scim/v2`, authenticated by the workspace's token. */
const scimApi = async (fastify: FastifyInstance) => {
  const { systemDb, withTenant } = fastify.container;
  const baseUrl = `${fastify.config.publicUrl}/scim/v2`;

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
    const config = token
      ? await systemDb.workspaceConfig.findUnique({
          where: { scimTokenHash: hashToken(token) },
          include: { workspace: { select: { slug: true } } },
        })
      : null;
    if (!config?.scimEnabled) throw new ScimError(401, 'Invalid SCIM token');
    request.scim = { workspaceId: config.workspaceId, slug: config.workspace.slug };
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
    const route = request.routeOptions.url?.replace('/scim/v2', '') ?? request.url;
    try {
      await withTenant(request.scim.workspaceId, (tx) =>
        tx.scimAuditEvent.create({
          data: {
            workspaceId: request.scim!.workspaceId,
            operation: `${request.method} ${route}`,
            scimUserId:
              request.scimResourceId ?? (request.params as { id?: string } | undefined)?.id ?? '',
            payload: body as Prisma.InputJsonValue,
            statusCode: reply.statusCode,
          },
        })
      );
    } catch (err) {
      request.log.error({ err }, 'Recording a SCIM audit event failed');
    }
  });

  /**
   * A tenant transaction with the workspace and its group → role policy; afterwards, ends
   * the workspace SSO sessions of anyone it deprovisioned.
   */
  const inTenant = async <T>(
    request: FastifyRequest,
    fn: (tx: TenantTx, workspace: { id: string; slug: string }, policy: ScimPolicy) => Promise<T>
  ) => {
    const workspace = { id: request.scim!.workspaceId, slug: request.scim!.slug };
    let policy: ScimPolicy | undefined;
    const result = await withTenant(workspace.id, async (tx) => {
      const config = await tx.workspaceConfig.findUnique({ where: { workspaceId: workspace.id } });
      policy = scimPolicy(config);
      return fn(tx, workspace, policy);
    });
    if (policy?.deprovisioned.size) {
      await systemDb.refreshToken.updateMany({
        where: {
          userId: { in: [...policy.deprovisioned] },
          provider: { in: [`oidc:${workspace.slug}`, `saml:${workspace.slug}`] },
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      });
    }
    return result;
  };

  const findUser = async (tx: TenantTx, workspaceId: string, id: string) => {
    const user = await tx.scimUser.findFirst({
      where: { id, workspaceId, deletedAt: null },
      include: { user: { select: { email: true } } },
    });
    if (!user) throw new ScimError(404, 'User not found');
    return user;
  };

  const renderUser = async (
    tx: TenantTx,
    workspaceId: string,
    user: ScimUser & { user: { email: string } }
  ) => {
    const groups = await tx.scimGroup.findMany({
      where: { workspaceId, memberIds: { has: user.id } },
      select: { id: true, displayName: true },
    });
    return userResource(baseUrl, { ...user, email: user.user.email }, groups);
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
    workspace: { id: string; slug: string },
    policy: ScimPolicy,
    id: string,
    attrs: UserAttributes
  ) => {
    if (!attrs.userName) throw new ScimError(400, 'userName is required', 'invalidValue');
    const clash = await tx.scimUser.findFirst({
      where: { workspaceId: workspace.id, userName: attrs.userName, id: { not: id } },
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
    await syncMembership(tx, workspace, policy, updated);
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
        description: 'The SCIM token from Settings → Provisioning',
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
      const workspaceId = request.scim!.workspaceId;
      return inTenant(request, async (tx) => {
        const where: Prisma.ScimUserWhereInput = {
          workspaceId,
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
        const resources = await Promise.all(users.map((u) => renderUser(tx, workspaceId, u)));
        return listResponse(resources, total, page.startIndex);
      });
    }
  );

  fastify.get<{ Params: { id: string } }>('/Users/:id', async (request) =>
    inTenant(request, async (tx, workspace) =>
      renderUser(tx, workspace.id, await findUser(tx, workspace.id, request.params.id))
    )
  );

  fastify.post('/Users', async (request, reply) => {
    const attrs = userAttributes((request.body ?? {}) as Json);
    if (!attrs.userName) throw new ScimError(400, 'userName is required', 'invalidValue');
    const email = (attrs.email ?? (attrs.userName.includes('@') ? attrs.userName : ''))
      .trim()
      .toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) {
      throw new ScimError(400, 'An email address is required (emails or userName)', 'invalidValue');
    }
    // Users are global; the SCIM user links the workspace's IdP account to one.
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

    const created = await inTenant(request, async (tx, workspace, policy) => {
      const existing = await tx.scimUser.findFirst({
        where: {
          workspaceId: workspace.id,
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
          data: { workspaceId: workspace.id, userId: user.id, userName: attrs.userName! },
        }));
      if (existing) {
        await tx.scimUser.update({
          where: { id: row.id },
          data: { deletedAt: null, userId: user.id },
        });
      }
      const saved = await applyUser(tx, workspace, policy, row.id, attrs);
      return renderUser(tx, workspace.id, saved);
    });
    request.scimResourceId = created.id;
    return reply.code(201).header('location', created.meta.location).send(created);
  });

  fastify.put<{ Params: { id: string } }>('/Users/:id', async (request) =>
    inTenant(request, async (tx, workspace, policy) => {
      await findUser(tx, workspace.id, request.params.id);
      const attrs = userAttributes((request.body ?? {}) as Json);
      const saved = await applyUser(tx, workspace, policy, request.params.id, attrs);
      return renderUser(tx, workspace.id, saved);
    })
  );

  fastify.patch<{ Params: { id: string } }>('/Users/:id', async (request) =>
    inTenant(request, async (tx, workspace, policy) => {
      const current = await findUser(tx, workspace.id, request.params.id);
      const attrs = patchUser(attributesOf(current), (request.body ?? {}) as Json);
      const saved = await applyUser(tx, workspace, policy, current.id, attrs);
      return renderUser(tx, workspace.id, saved);
    })
  );

  // SSO-25: deprovisioning. The row stays (deleted) so SSO can't re-add the user.
  fastify.delete<{ Params: { id: string } }>('/Users/:id', async (request, reply) => {
    await inTenant(request, async (tx, workspace, policy) => {
      const current = await findUser(tx, workspace.id, request.params.id);
      const deleted = await tx.scimUser.update({
        where: { id: current.id },
        data: { active: false, deletedAt: new Date() },
      });
      // Out of every group, so re-provisioning starts clean.
      const groups = await tx.scimGroup.findMany({
        where: { workspaceId: workspace.id, memberIds: { has: current.id } },
      });
      for (const g of groups) {
        await tx.scimGroup.update({
          where: { id: g.id },
          data: { memberIds: g.memberIds.filter((m) => m !== current.id) },
        });
      }
      await syncMembership(tx, workspace, policy, deleted);
    });
    return reply.code(204).send();
  });

  // ─── Groups ───────────────────────────────────────────────────────────────

  const renderGroup = async (tx: TenantTx, group: Prisma.ScimGroupGetPayload<object>) => {
    const members = await tx.scimUser.findMany({
      where: { id: { in: group.memberIds }, deletedAt: null },
      select: { id: true, userName: true },
    });
    return groupResource(baseUrl, group, members);
  };

  const findGroup = async (tx: TenantTx, workspaceId: string, id: string) => {
    const group = await tx.scimGroup.findFirst({ where: { id, workspaceId } });
    if (!group) throw new ScimError(404, 'Group not found');
    return group;
  };

  /** Saves a group and re-syncs everyone whose groups changed. */
  const saveGroup = async (
    tx: TenantTx,
    workspace: { id: string; slug: string },
    policy: ScimPolicy,
    id: string | null,
    change: { displayName?: string; externalId?: string | null; members: Set<string> },
    previous: string[] = []
  ) => {
    if (!change.displayName) throw new ScimError(400, 'displayName is required', 'invalidValue');
    const clash = await tx.scimGroup.findFirst({
      where: {
        workspaceId: workspace.id,
        displayName: change.displayName,
        ...(id && { id: { not: id } }),
      },
    });
    if (clash) throw new ScimError(409, 'displayName is already in use', 'uniqueness');
    // Only this workspace's live users can be members.
    const known = await tx.scimUser.findMany({
      where: { workspaceId: workspace.id, id: { in: [...change.members] }, deletedAt: null },
      select: { id: true },
    });
    const data = {
      displayName: change.displayName,
      externalId: change.externalId ?? null,
      memberIds: known.map((u) => u.id),
    };
    const group = id
      ? await tx.scimGroup.update({ where: { id }, data })
      : await tx.scimGroup.create({ data: { workspaceId: workspace.id, ...data } });
    const affected = await tx.scimUser.findMany({
      where: { id: { in: [...new Set([...previous, ...data.memberIds])] }, deletedAt: null },
    });
    for (const user of affected) {
      await syncMembership(tx, workspace, policy, user, { fromGroups: true });
    }
    await audit(
      tx,
      workspace.id,
      { principal: { type: 'system', id: 'scim' } },
      {
        action: id ? 'scim.group_updated' : 'scim.group_created',
        resourceType: 'scim_group',
        resourceId: group.id,
        metadata: { displayName: group.displayName, members: group.memberIds.length },
      }
    );
    return group;
  };

  fastify.get<{ Querystring: { filter?: string; startIndex?: string; count?: string } }>(
    '/Groups',
    async (request) => {
      const filter = parseFilter(request.query.filter, ['displayName', 'externalId']);
      const page = paging(request.query);
      return inTenant(request, async (tx, workspace) => {
        const where: Prisma.ScimGroupWhereInput = {
          workspaceId: workspace.id,
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
        const resources = await Promise.all(groups.map((g) => renderGroup(tx, g)));
        return listResponse(resources, total, page.startIndex);
      });
    }
  );

  fastify.get<{ Params: { id: string } }>('/Groups/:id', async (request) =>
    inTenant(request, async (tx, workspace) =>
      renderGroup(tx, await findGroup(tx, workspace.id, request.params.id))
    )
  );

  const membersOf = (body: Json) =>
    new Set(
      (Array.isArray(body.members) ? (body.members as Json[]) : [])
        .map((m) => m.value)
        .filter((v): v is string => typeof v === 'string')
    );

  fastify.post('/Groups', async (request, reply) => {
    const body = (request.body ?? {}) as Json;
    const created = await inTenant(request, async (tx, workspace, policy) =>
      renderGroup(
        tx,
        await saveGroup(tx, workspace, policy, null, {
          displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
          externalId: typeof body.externalId === 'string' ? body.externalId : null,
          members: membersOf(body),
        })
      )
    );
    request.scimResourceId = created.id;
    return reply.code(201).header('location', created.meta.location).send(created);
  });

  fastify.put<{ Params: { id: string } }>('/Groups/:id', async (request) =>
    inTenant(request, async (tx, workspace, policy) => {
      const current = await findGroup(tx, workspace.id, request.params.id);
      const body = (request.body ?? {}) as Json;
      const saved = await saveGroup(
        tx,
        workspace,
        policy,
        current.id,
        {
          displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
          externalId: typeof body.externalId === 'string' ? body.externalId : null,
          members: membersOf(body),
        },
        current.memberIds
      );
      return renderGroup(tx, saved);
    })
  );

  fastify.patch<{ Params: { id: string } }>('/Groups/:id', async (request) =>
    inTenant(request, async (tx, workspace, policy) => {
      const current = await findGroup(tx, workspace.id, request.params.id);
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
        await saveGroup(tx, workspace, policy, current.id, change, current.memberIds)
      );
    })
  );

  fastify.delete<{ Params: { id: string } }>('/Groups/:id', async (request, reply) => {
    await inTenant(request, async (tx, workspace, policy) => {
      const current = await findGroup(tx, workspace.id, request.params.id);
      await tx.scimGroup.delete({ where: { id: current.id } });
      const affected = await tx.scimUser.findMany({
        where: { id: { in: current.memberIds }, deletedAt: null },
      });
      for (const user of affected) {
        await syncMembership(tx, workspace, policy, user, { fromGroups: true });
      }
      await audit(
        tx,
        workspace.id,
        { principal: { type: 'system', id: 'scim' } },
        {
          action: 'scim.group_deleted',
          resourceType: 'scim_group',
          resourceId: current.id,
          metadata: { displayName: current.displayName },
        }
      );
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
  await fastify.register(scimApi, { prefix: '/scim/v2' });
  await fastify.register(scimSettings);
};

export default scimRoutes;
