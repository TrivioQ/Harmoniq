// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { Readable } from 'stream';
import type { FastifyReply } from 'fastify';
import type { TenantTx } from '@harmoniq/db';
import { exportConfig } from './gitops';
import { NEWEST_FIRST, afterWhere, keysetRows } from './auditExport';

/**
 * TLC-07: a tenant's data as JSON Lines, one record per line, each with a `type`:
 * `export` (header), `workspace`, `config` (the `harmoniq.yaml`, without secrets),
 * `member`, `module`, `version`, `audit`; for organizations also `organization`,
 * `org_member`, `org_key` (metadata only) and `org_audit`, then every live workspace.
 * Read in batches, each in its own tenant transaction, so large audit logs stream.
 */
export const EXPORT_FORMAT = 'harmoniq.export.v1';
const BATCH = 500;

type Scoped = <T>(fn: (tx: TenantTx) => Promise<T>) => Promise<T>;
type Row = Record<string, unknown>;

/** Every row of `fetch`, oldest id first, a batch at a time. */
async function* byId<T extends { id: string }>(
  fetch: (afterId: string | null, take: number) => Promise<T[]>
) {
  let after: string | null = null;
  for (;;) {
    const rows = await fetch(after, BATCH);
    yield* rows;
    if (rows.length < BATCH) return;
    after = rows[rows.length - 1].id;
  }
}

const idAfter = (afterId: string | null) => (afterId ? { id: { gt: afterId } } : {});

/** The records of one workspace (in its own scope, or its organization's). */
export async function* workspaceRecords(
  scoped: Scoped,
  workspace: { id: string; slug: string }
): AsyncGenerator<Row> {
  const workspaceId = workspace.id;
  const head = await scoped(async (tx) => ({
    row: await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId } }),
    config: await exportConfig(tx, workspace),
  }));
  yield {
    type: 'workspace',
    slug: head.row.slug,
    name: head.row.name,
    retentionDays: head.row.retentionDays,
    createdAt: head.row.createdAt,
  };
  yield { type: 'config', workspace: workspace.slug, config: head.config };

  const members = await scoped((tx) =>
    tx.workspaceMember.findMany({
      where: { workspaceId },
      include: { user: { select: { email: true, name: true } } },
      orderBy: { invitedAt: 'asc' },
    })
  );
  for (const m of members) {
    yield {
      type: 'member',
      workspace: workspace.slug,
      email: m.user.email,
      name: m.user.name,
      role: m.role,
      status: m.joinedAt ? 'active' : 'invited',
      joinedAt: m.joinedAt,
    };
  }

  const modules = await scoped((tx) =>
    tx.remoteModule.findMany({
      where: { workspaceId },
      include: { hostApp: { select: { slug: true } } },
      orderBy: { slug: 'asc' },
    })
  );
  const slugOf = new Map(modules.map((m) => [m.id, m.slug]));
  for (const m of modules) {
    yield {
      type: 'module',
      workspace: workspace.slug,
      hostApp: m.hostApp.slug,
      slug: m.slug,
      name: m.name,
      specifier: m.specifier,
      shared: m.orgShared,
    };
  }

  const versions = byId((afterId, take) =>
    scoped((tx) =>
      tx.moduleVersion.findMany({
        where: { workspaceId, ...idAfter(afterId) },
        include: { environment: { select: { slug: true } } },
        orderBy: { id: 'asc' },
        take,
      })
    )
  );
  for await (const v of versions) {
    yield {
      type: 'version',
      workspace: workspace.slug,
      module: slugOf.get(v.remoteModuleId) ?? v.remoteModuleId,
      environment: v.environment.slug,
      version: v.version,
      url: v.url,
      integrity: v.integrity,
      status: v.status,
      deployedAt: v.deployedAt,
      deployedBy: v.deployedBy,
      commitSha: v.commitSha,
    };
  }

  const audit = keysetRows((after, take) =>
    scoped((tx) =>
      tx.auditEvent.findMany({
        where: { workspaceId, ...afterWhere(after) },
        orderBy: NEWEST_FIRST,
        take,
      })
    )
  );
  for await (const e of audit) {
    yield {
      type: 'audit',
      workspace: workspace.slug,
      id: e.id,
      createdAt: e.createdAt,
      actorType: e.actorType,
      actorId: e.actorId,
      action: e.action,
      resourceType: e.resourceType,
      resourceId: e.resourceId,
      metadata: e.metadata,
      // AUD-09
      chainSeq: e.chainSeq?.toString() ?? null,
      prevHash: e.prevHash,
      hash: e.hash,
    };
  }
}

/** The organization's own records, then each of its live workspaces. */
export async function* organizationRecords(
  scoped: Scoped,
  org: { id: string; slug: string }
): AsyncGenerator<Row> {
  const head = await scoped(async (tx) => ({
    org: await tx.organization.findUniqueOrThrow({ where: { id: org.id } }),
    members: await tx.organizationMember.findMany({
      where: { organizationId: org.id },
      include: { user: { select: { email: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    }),
    keys: await tx.orgApiKey.findMany({
      where: { organizationId: org.id },
      orderBy: { createdAt: 'asc' },
    }),
    workspaces: await tx.workspace.findMany({
      where: { organizationId: org.id, deletedAt: null },
      select: { id: true, slug: true },
      orderBy: { slug: 'asc' },
    }),
  }));
  yield {
    type: 'organization',
    slug: head.org.slug,
    name: head.org.name,
    plan: head.org.plan,
    createdAt: head.org.createdAt,
  };
  for (const m of head.members) {
    yield { type: 'org_member', email: m.user.email, name: m.user.name, role: m.role };
  }
  for (const k of head.keys) {
    // Metadata only: key secrets are never stored in a readable form.
    yield {
      type: 'org_key',
      name: k.name,
      prefix: k.prefix,
      scopes: k.scopes,
      createdAt: k.createdAt,
      expiresAt: k.expiresAt,
      revokedAt: k.revokedAt,
    };
  }
  const audit = keysetRows((after, take) =>
    scoped((tx) =>
      tx.organizationAuditEvent.findMany({
        where: { organizationId: org.id, ...afterWhere(after) },
        orderBy: NEWEST_FIRST,
        take,
      })
    )
  );
  for await (const e of audit) {
    yield {
      type: 'org_audit',
      id: e.id,
      createdAt: e.createdAt,
      actorType: e.actorType,
      actorId: e.actorId,
      action: e.action,
      resourceType: e.resourceType,
      resourceId: e.resourceId,
      metadata: e.metadata,
      // AUD-09
      chainSeq: e.chainSeq?.toString() ?? null,
      prevHash: e.prevHash,
      hash: e.hash,
    };
  }
  for (const workspace of head.workspaces) yield* workspaceRecords(scoped, workspace);
}

/** Streams the records as a JSON Lines download. */
export function sendTenantExport(
  reply: FastifyReply,
  scope: { kind: 'workspace' | 'organization'; slug: string },
  records: AsyncIterable<Row>
) {
  async function* lines() {
    yield JSON.stringify({
      type: 'export',
      format: EXPORT_FORMAT,
      scope: scope.kind,
      slug: scope.slug,
      exportedAt: new Date().toISOString(),
    }) + '\n';
    for await (const record of records) yield JSON.stringify(record) + '\n';
  }
  const day = new Date().toISOString().slice(0, 10);
  return reply
    .header('Content-Type', 'application/x-ndjson; charset=utf-8')
    .header(
      'Content-Disposition',
      `attachment; filename="harmoniq-${scope.kind}-${scope.slug}-${day}.jsonl"`
    )
    .header('Cache-Control', 'no-store')
    .send(Readable.from(lines()));
}
