// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { NotFoundError } from '@harmoniq/core/dist/errors/AppError';
import { audit } from '../services/audit';
import { DomainOwner, domainDto } from '../services/domains';

type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
type DomainParams = { domain: string };
type AuditEvent = {
  action: string;
  resourceType: string;
  resourceId: string;
  metadata?: Record<string, unknown>;
};

/**
 * The same four endpoints for an organization and for a workspace: list claims, claim a
 * domain (returns the TXT record to publish), verify it, remove it.
 */
function domainEndpoints(
  fastify: FastifyInstance,
  opts: {
    base: string;
    guard: { preHandler: Handler };
    owner: (request: FastifyRequest) => DomainOwner;
    record: (request: FastifyRequest, event: AuditEvent) => Promise<unknown>;
  }
) {
  const { domains } = fastify.container;
  const { base, guard, owner, record } = opts;
  const event = (action: string, domain: string, metadata?: Record<string, unknown>) => ({
    action,
    resourceType: 'domain',
    resourceId: domain,
    metadata: { domain, ...metadata },
  });

  fastify.get(`${base}/domains`, guard, async (request) => ({
    domains: (await domains.list(owner(request))).map(domainDto),
  }));

  fastify.post<{ Body: { domain?: unknown } }>(`${base}/domains`, guard, async (request, reply) => {
    const { row, created } = await domains.claim(
      owner(request),
      request.body?.domain,
      request.principal!.id
    );
    if (created) await record(request, event('domain.claim', row.domain));
    return reply.code(created ? 201 : 200).send(domainDto(row));
  });

  fastify.post<{ Params: DomainParams }>(
    `${base}/domains/:domain/verify`,
    guard,
    async (request) => {
      const { row, changed } = await domains.verify(owner(request), request.params.domain);
      if (changed) await record(request, event('domain.verify', row.domain));
      return domainDto(row);
    }
  );

  fastify.delete<{ Params: DomainParams }>(
    `${base}/domains/:domain`,
    guard,
    async (request, reply) => {
      const row = await domains.remove(owner(request), request.params.domain);
      await record(request, event('domain.remove', row.domain, { wasVerified: !!row.verifiedAt }));
      return reply.code(204).send();
    }
  );
}

/** DOM-01/02 for organizations; called from the organization routes (org admins only). */
export function orgDomainRoutes(
  fastify: FastifyInstance,
  deps: {
    admin: { preHandler: Handler };
    orgAudit: (request: FastifyRequest, event: AuditEvent) => Promise<unknown>;
  }
) {
  domainEndpoints(fastify, {
    base: '/api/orgs/:orgSlug',
    guard: deps.admin,
    owner: (request) => ({ organizationId: request.org!.id }),
    record: deps.orgAudit,
  });
}

/** DOM-01/02 for workspaces (their own SSO), and DOM-02's instance-admin release. */
const domainRoutes: FastifyPluginAsync = async (fastify) => {
  // eslint-disable-next-line no-restricted-syntax -- MT-09: instance-admin endpoints below span tenants
  const { systemDb, withTenant } = fastify.container;

  domainEndpoints(fastify, {
    base: '/api/workspaces/:workspaceSlug',
    guard: { preHandler: fastify.requireWorkspace('workspace:admin') },
    owner: (request) => ({ workspaceId: request.workspace!.id }),
    record: (request, event) =>
      withTenant(request.workspace!.id, (tx) =>
        audit(tx, request.workspace!.id, { principal: request.principal!, ip: request.ip }, event)
      ),
  });

  const instanceAdmin = { preHandler: fastify.requireInstanceAdmin };

  /** Every claim, verified first, e.g. to find who holds a domain. */
  fastify.get<{ Querystring: { domain?: string } }>(
    '/api/admin/domains',
    instanceAdmin,
    async (request) => {
      const domain = request.query.domain?.trim().toLowerCase();
      // eslint-disable-next-line no-restricted-syntax -- MT-09: instance admin, every tenant
      const rows = await systemDb.verifiedDomain.findMany({
        where: domain ? { domain: { contains: domain } } : {},
        include: {
          organization: { select: { slug: true } },
          workspace: { select: { slug: true } },
        },
        orderBy: [{ verifiedAt: { sort: 'desc', nulls: 'last' } }, { domain: 'asc' }],
        take: 200,
      });
      return {
        domains: rows.map((r) => ({
          id: r.id,
          ...domainDto(r),
          organization: r.organization?.slug ?? null,
          workspace: r.workspace?.slug ?? null,
        })),
      };
    }
  );

  /** DOM-02: releases a claim (e.g. verified by the wrong tenant) so its owner can verify. */
  fastify.delete<{ Params: { id: string } }>(
    '/api/admin/domains/:id',
    instanceAdmin,
    async (request, reply) => {
      // eslint-disable-next-line no-restricted-syntax -- MT-09: instance admin, every tenant
      const row = await systemDb.verifiedDomain.findUnique({ where: { id: request.params.id } });
      if (!row) throw new NotFoundError('Domain claim not found');
      // eslint-disable-next-line no-restricted-syntax -- MT-09: instance admin, every tenant
      await systemDb.verifiedDomain.delete({ where: { id: row.id } });
      // eslint-disable-next-line no-restricted-syntax -- MT-09: instance audit log
      await systemDb.instanceAuditEvent.create({
        data: {
          actorType: 'user',
          actorId: request.principal!.id,
          ip: request.ip,
          action: 'instance.domain_release',
          resourceType: 'domain',
          resourceId: row.domain,
          metadata: {
            domain: row.domain,
            wasVerified: !!row.verifiedAt,
            organizationId: row.organizationId,
            workspaceId: row.workspaceId,
          },
        },
      });
      return reply.code(204).send();
    }
  );
};

export default domainRoutes;
