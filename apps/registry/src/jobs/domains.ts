// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { ILogger } from '@harmoniq/core/dist/ports/ILogger';
import { Domains, REVERIFY_FAILURE_DAYS } from '../services/domains';

export const DOMAINS_RECHECK_QUEUE = 'domains.recheck';
const ACTOR = 'system:domains.recheck';

/**
 * DOM-05: re-checks verified domains and records each one that lost its verification, in
 * the instance log and in its owner's log (organization or workspace).
 */
export async function handleDomainRecheck(
  db: PrismaClient,
  domains: Domains,
  logger: ILogger,
  now = new Date()
) {
  const { checked, unverified } = await domains.recheck(now);
  for (const row of unverified) {
    const metadata = {
      domain: row.domain,
      reason: `TXT record missing for ${REVERIFY_FAILURE_DAYS} days`,
    };
    await db.instanceAuditEvent.create({
      data: {
        actorType: 'system',
        actorId: ACTOR,
        action: 'domain.unverified',
        resourceType: 'domain',
        resourceId: row.domain,
        metadata,
      },
    });
    if (row.organizationId) {
      await db.organizationAuditEvent.create({
        data: {
          organizationId: row.organizationId,
          actorType: 'system',
          actorId: ACTOR,
          action: 'domain.unverified',
          resourceType: 'domain',
          resourceId: row.domain,
          metadata,
        },
      });
    } else if (row.workspaceId) {
      await db.auditEvent.create({
        data: {
          workspaceId: row.workspaceId,
          actorType: 'system',
          actorId: ACTOR,
          action: 'domain.unverified',
          resourceType: 'domain',
          resourceId: row.domain,
          metadata,
        },
      });
    }
    logger.warn(`Domain ${row.domain} is no longer verified (${metadata.reason})`);
  }
  return { checked, unverified: unverified.length };
}

export async function registerDomainJobs(fastify: FastifyInstance) {
  const { boss, systemDb, domains, logger } = fastify.container;
  if (!boss) return;
  await boss.createQueue(DOMAINS_RECHECK_QUEUE);
  await boss.schedule(DOMAINS_RECHECK_QUEUE, '30 3 * * *'); // daily
  await boss.work(DOMAINS_RECHECK_QUEUE, async () => {
    await handleDomainRecheck(systemDb, domains, logger);
  });
}
