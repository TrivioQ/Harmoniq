// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { X509Certificate } from 'crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { createWorkspaceStorage, storageTarget } from '../adapters/storage/createStorage';
import { probeStorage } from './instanceHealth';
import { jobQueues } from './operations';
import { certBody } from './saml';

/**
 * INST-27: the admin home. Trends over 30 days, and what needs attention, read from
 * signals the registry already keeps (no bookkeeping of its own).
 */

const DAY = 86_400_000;
const LIMIT = 50;

export type AttentionKind =
  | 'publish_failed'
  | 'webhook_dead_letters'
  | 'failed_jobs'
  | 'storage_unverified'
  | 'saml_certificate_expiring'
  | 'alert_rule_error'
  | 'quota_exceeded'
  | 'domain_failing';

export interface AttentionItem {
  kind: AttentionKind;
  /** The tenant it concerns (none for instance-wide items such as jobs). */
  tenant: { type: 'workspace' | 'organization'; slug: string } | null;
  /** What exactly, e.g. `portal/production`, a queue, a domain. */
  subject: string;
  detail: string | null;
  since: string | null;
}

const dayKey = (d: Date) => d.toISOString().slice(0, 10);

/** Per day for 30 days: deploys, manifest requests, active users, new tenants. */
export async function trends(db: PrismaClient, days = 30, now = new Date()) {
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  since.setUTCDate(since.getUTCDate() - (days - 1));
  const [usage, users, workspaces, orgs] = await Promise.all([
    db.usageDaily.groupBy({
      by: ['day'],
      where: { day: { gte: since } },
      _sum: { deploys: true, manifestRequests: true },
    }),
    // Active users: anyone whose session was refreshed (every 15 minutes while in use).
    db.$queryRaw<Array<{ day: Date; n: bigint }>>`
      SELECT date_trunc('day', "createdAt") AS day, count(DISTINCT "userId") AS n
        FROM "RefreshToken" WHERE "createdAt" >= ${since} GROUP BY 1`,
    db.$queryRaw<Array<{ day: Date; n: bigint }>>`
      SELECT date_trunc('day', "createdAt") AS day, count(*) AS n
        FROM "Workspace" WHERE "createdAt" >= ${since} GROUP BY 1`,
    db.$queryRaw<Array<{ day: Date; n: bigint }>>`
      SELECT date_trunc('day', "createdAt") AS day, count(*) AS n
        FROM "Organization" WHERE "createdAt" >= ${since} GROUP BY 1`,
  ]);
  const map = <T>(rows: T[], key: (r: T) => Date, value: (r: T) => number) =>
    new Map(rows.map((r) => [dayKey(new Date(key(r))), value(r)]));
  const deploys = map(
    usage,
    (u) => u.day,
    (u) => u._sum.deploys ?? 0
  );
  const requests = map(
    usage,
    (u) => u.day,
    (u) => Number(u._sum.manifestRequests ?? 0)
  );
  const active = map(
    users,
    (r) => r.day,
    (r) => Number(r.n)
  );
  const newWs = map(
    workspaces,
    (r) => r.day,
    (r) => Number(r.n)
  );
  const newOrgs = map(
    orgs,
    (r) => r.day,
    (r) => Number(r.n)
  );
  return Array.from({ length: days }, (_, i) => {
    const day = dayKey(new Date(since.getTime() + i * DAY));
    return {
      day,
      deploys: deploys.get(day) ?? 0,
      manifestRequests: requests.get(day) ?? 0,
      activeUsers: active.get(day) ?? 0,
      newWorkspaces: newWs.get(day) ?? 0,
      newOrganizations: newOrgs.get(day) ?? 0,
    };
  });
}

/** When a SAML signing certificate (base64 DER or PEM) expires; null if unreadable. */
export function certificateExpiry(cert: string | undefined): Date | null {
  if (!cert) return null;
  try {
    return new Date(new X509Certificate(Buffer.from(certBody(cert), 'base64')).validTo);
  } catch {
    return null;
  }
}

export async function attention(db: PrismaClient, now = new Date()): Promise<AttentionItem[]> {
  const items: AttentionItem[] = [];
  const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;
  const [
    publishFailures,
    deadLetters,
    orgDeadLetters,
    sinkDeadLetters,
    queues,
    storage,
    samlWorkspaces,
    samlOrgs,
    alertRules,
    quotaWs,
    quotaOrgs,
    domains,
  ] = await Promise.all([
    db.environment.findMany({
      where: { lastPublishError: { not: null }, hostApp: { workspace: { deletedAt: null } } },
      include: { hostApp: { select: { slug: true, workspace: { select: { slug: true } } } } },
      take: LIMIT,
    }),
    db.webhookDeadLetter.groupBy({
      by: ['workspaceId'],
      where: { retriedAt: null, resolvedAt: null },
      _count: { _all: true },
      _max: { exhaustedAt: true },
    }),
    db.orgWebhookDeadLetter.groupBy({
      by: ['organizationId'],
      where: { retriedAt: null },
      _count: { _all: true },
      _max: { exhaustedAt: true },
    }),
    db.auditSinkDeadLetter.groupBy({
      by: ['organizationId'],
      where: { retriedAt: null },
      _count: { _all: true },
      _max: { createdAt: true },
    }),
    jobQueues(db).catch(() => []),
    db.workspaceStorageConfig.findMany({
      where: { lastVerifyError: { not: null } },
      include: { workspace: { select: { slug: true } } },
      take: LIMIT,
    }),
    db.workspaceConfig.findMany({
      where: { samlConfig: { not: Prisma.DbNull }, workspace: { deletedAt: null } },
      select: { samlConfig: true, workspace: { select: { slug: true } } },
    }),
    db.organization.findMany({
      where: { deletedAt: null, samlConfig: { not: Prisma.DbNull } },
      select: { slug: true, samlConfig: true },
    }),
    db.alertRule.findMany({
      where: { lastError: { not: null } },
      include: { workspace: { select: { slug: true } } },
      take: LIMIT,
    }),
    db.auditEvent.groupBy({
      by: ['workspaceId'],
      where: { action: 'quota.exceeded', createdAt: { gt: new Date(now.getTime() - 7 * DAY) } },
      _count: { _all: true },
      _max: { createdAt: true },
    }),
    db.organizationAuditEvent.groupBy({
      by: ['organizationId'],
      where: { action: 'quota.exceeded', createdAt: { gt: new Date(now.getTime() - 7 * DAY) } },
      _count: { _all: true },
      _max: { createdAt: true },
    }),
    db.verifiedDomain.findMany({
      where: { failingSince: { not: null } },
      include: {
        workspace: { select: { slug: true } },
        organization: { select: { slug: true } },
      },
      take: LIMIT,
    }),
  ]);

  // Slugs for the grouped rows.
  const wsIds = [...deadLetters, ...quotaWs].map((r) => r.workspaceId);
  const orgIds = [...orgDeadLetters, ...sinkDeadLetters, ...quotaOrgs].map((r) => r.organizationId);
  const [wsRows, orgRows] = await Promise.all([
    db.workspace.findMany({ where: { id: { in: wsIds } }, select: { id: true, slug: true } }),
    db.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, slug: true } }),
  ]);
  const ws = (id: string) => {
    const slug = wsRows.find((w) => w.id === id)?.slug;
    return slug ? { type: 'workspace' as const, slug } : null;
  };
  const org = (id: string) => {
    const slug = orgRows.find((o) => o.id === id)?.slug;
    return slug ? { type: 'organization' as const, slug } : null;
  };

  for (const e of publishFailures) {
    items.push({
      kind: 'publish_failed',
      tenant: { type: 'workspace', slug: e.hostApp.workspace.slug },
      subject: `${e.hostApp.slug}/${e.slug}`,
      detail: e.lastPublishError,
      since: iso(e.lastPublishedAt),
    });
  }
  for (const d of deadLetters) {
    const tenant = ws(d.workspaceId);
    if (tenant) {
      items.push({
        kind: 'webhook_dead_letters',
        tenant,
        subject: 'webhooks',
        detail: String(d._count._all),
        since: iso(d._max.exhaustedAt),
      });
    }
  }
  for (const d of orgDeadLetters) {
    const tenant = org(d.organizationId);
    if (tenant) {
      items.push({
        kind: 'webhook_dead_letters',
        tenant,
        subject: 'webhooks',
        detail: String(d._count._all),
        since: iso(d._max.exhaustedAt),
      });
    }
  }
  for (const d of sinkDeadLetters) {
    const tenant = org(d.organizationId);
    if (tenant) {
      items.push({
        kind: 'webhook_dead_letters',
        tenant,
        subject: 'audit streams',
        detail: String(d._count._all),
        since: iso(d._max.createdAt),
      });
    }
  }
  for (const q of queues) {
    if (q.failed > 0 && q.lastFailure && now.getTime() - Date.parse(q.lastFailure) < DAY) {
      items.push({
        kind: 'failed_jobs',
        tenant: null,
        subject: q.name,
        detail: String(q.failed),
        since: q.lastFailure,
      });
    }
  }
  for (const s of storage) {
    items.push({
      kind: 'storage_unverified',
      tenant: { type: 'workspace', slug: s.workspace.slug },
      subject: s.bucket,
      detail: s.lastVerifyError,
      since: iso(s.lastVerifyFailedAt),
    });
  }
  const soon = now.getTime() + 30 * DAY;
  const samlItem = (tenant: AttentionItem['tenant'], config: unknown): AttentionItem | null => {
    const expires = certificateExpiry((config as { idpCert?: string } | null)?.idpCert);
    if (!expires || expires.getTime() > soon) return null;
    return {
      kind: 'saml_certificate_expiring',
      tenant,
      subject: 'SAML',
      detail: expires < now ? 'expired' : null,
      since: expires.toISOString(),
    };
  };
  for (const w of samlWorkspaces) {
    const item =
      w.samlConfig && samlItem({ type: 'workspace', slug: w.workspace.slug }, w.samlConfig);
    if (item) items.push(item);
  }
  for (const o of samlOrgs) {
    const item = o.samlConfig && samlItem({ type: 'organization', slug: o.slug }, o.samlConfig);
    if (item) items.push(item);
  }
  for (const r of alertRules) {
    items.push({
      kind: 'alert_rule_error',
      tenant: { type: 'workspace', slug: r.workspace.slug },
      subject: r.name || r.id,
      detail: r.lastError,
      since: null,
    });
  }
  for (const q of quotaWs) {
    const tenant = ws(q.workspaceId);
    if (tenant) {
      items.push({
        kind: 'quota_exceeded',
        tenant,
        subject: 'quota',
        detail: String(q._count._all),
        since: iso(q._max.createdAt),
      });
    }
  }
  for (const q of quotaOrgs) {
    const tenant = org(q.organizationId);
    if (tenant) {
      items.push({
        kind: 'quota_exceeded',
        tenant,
        subject: 'quota',
        detail: String(q._count._all),
        since: iso(q._max.createdAt),
      });
    }
  }
  for (const d of domains) {
    const tenant = d.organization
      ? { type: 'organization' as const, slug: d.organization.slug }
      : d.workspace
        ? { type: 'workspace' as const, slug: d.workspace.slug }
        : null;
    items.push({
      kind: 'domain_failing',
      tenant,
      subject: d.domain,
      detail: null,
      since: iso(d.failingSince),
    });
  }
  return items;
}

/**
 * INST-27: tenant buckets checked daily (write, read back, delete a probe object); a
 * failure stays on the config until a check succeeds.
 */
export async function verifyTenantStorage(db: PrismaClient, encryptionKey: Buffer) {
  const configs = await db.workspaceStorageConfig.findMany({
    where: { workspace: { deletedAt: null } },
  });
  let failed = 0;
  for (const config of configs) {
    let result: { ok: boolean; error?: string };
    try {
      result = await probeStorage(
        storageTarget(
          { pathPrefix: config.pathPrefix, cdnPrefix: config.cdnPrefix },
          createWorkspaceStorage(config, encryptionKey)
        )
      );
    } catch (err) {
      result = { ok: false, error: (err as Error).message };
    }
    await recordStorageCheck(db, config.workspaceId, result);
    if (!result.ok) failed++;
  }
  return { checked: configs.length, failed };
}

export async function recordStorageCheck(
  db: Pick<PrismaClient, 'workspaceStorageConfig'>,
  workspaceId: string,
  result: { ok: boolean; error?: string }
) {
  const now = new Date();
  await db.workspaceStorageConfig.update({
    where: { workspaceId },
    data: result.ok
      ? { lastVerifiedAt: now, lastVerifyError: null, lastVerifyFailedAt: null }
      : { lastVerifyError: (result.error ?? 'failed').slice(0, 1000), lastVerifyFailedAt: now },
  });
}
