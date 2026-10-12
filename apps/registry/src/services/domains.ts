// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from 'crypto';
import { resolveTxt } from 'dns/promises';
import { Prisma, PrismaClient, VerifiedDomain } from '@prisma/client';
import { z } from 'zod';
import { BadRequestError, ConflictError, NotFoundError } from '@harmoniq/core/dist/errors/AppError';
import type { Config } from '../config';
import type { SsoSubject } from './ssoIds';

/** Who claims a domain: an organization or a workspace. */
export type DomainOwner = { organizationId: string } | { workspaceId: string };

export const TXT_PREFIX = 'harmoniq-verification=';
/** DOM-01: the TXT record proving control of `domain`. */
export const challengeRecord = (domain: string) => `_harmoniq-challenge.${domain}`;

/** DOM-05: a verified domain whose record is missing this long is unverified. */
export const REVERIFY_FAILURE_DAYS = 14;
/** DOM-05: verified domains are re-checked when their last check is this old. */
const RECHECK_AFTER_MS = 6 * 24 * 3_600_000;
const GRACE_KEY = 'domains.graceUntil';
const DAY_MS = 24 * 3_600_000;

const DomainNameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(
    /^(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z]{2,63}$/,
    'Enter a domain name such as example.com (no scheme, path or wildcard)'
  );

export function normalizeDomain(input: unknown): string {
  const parsed = DomainNameSchema.safeParse(input);
  if (!parsed.success) throw new BadRequestError(parsed.error.issues[0].message);
  return parsed.data;
}

const ownerWhere = (owner: DomainOwner) =>
  'organizationId' in owner
    ? { organizationId: owner.organizationId }
    : { workspaceId: owner.workspaceId };

/** The API view of a claim, with the record to publish while it is unverified. */
export function domainDto(row: VerifiedDomain) {
  return {
    domain: row.domain,
    verified: !!row.verifiedAt,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    failingSince: row.failingSince?.toISOString() ?? null,
    record: { type: 'TXT', name: challengeRecord(row.domain), value: TXT_PREFIX + row.token },
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * DOM-01..05: domains proven by DNS. A tenant may only rely on a domain (SSO discovery,
 * trusting its emails, auto-joining its users) once it has shown it controls the domain.
 * Many tenants may claim a domain; only one can verify it.
 */
export class Domains {
  /** DNS TXT lookup; replaced in tests. */
  resolveTxt: (name: string) => Promise<string[][]> = resolveTxt;
  private graceUntilCache?: Date;

  constructor(private deps: { systemDb: PrismaClient; config: Pick<Config, 'domainGraceDays'> }) {}

  private get db() {
    return this.deps.systemDb;
  }

  list(owner: DomainOwner) {
    return this.db.verifiedDomain.findMany({
      where: ownerWhere(owner),
      orderBy: { domain: 'asc' },
    });
  }

  /** Starts (or returns) a claim; the TXT value stays the same until it is removed. */
  async claim(owner: DomainOwner, input: unknown, createdBy: string) {
    const domain = normalizeDomain(input);
    const existing = await this.db.verifiedDomain.findFirst({
      where: { domain, ...ownerWhere(owner) },
    });
    if (existing) return { row: existing, created: false };
    try {
      const row = await this.db.verifiedDomain.create({
        data: {
          domain,
          ...ownerWhere(owner),
          token: randomBytes(16).toString('hex'),
          createdBy,
        },
      });
      return { row, created: true };
    } catch (err) {
      // A concurrent claim of the same domain by the same owner.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const row = await this.db.verifiedDomain.findFirstOrThrow({
          where: { domain, ...ownerWhere(owner) },
        });
        return { row, created: false };
      }
      throw err;
    }
  }

  private async find(owner: DomainOwner, input: unknown) {
    const domain = normalizeDomain(input);
    const row = await this.db.verifiedDomain.findFirst({
      where: { domain, ...ownerWhere(owner) },
    });
    if (!row) throw new NotFoundError('Domain not found');
    return row;
  }

  /** Whether the domain's challenge record currently holds this claim's token. */
  private async recordPresent(row: VerifiedDomain) {
    try {
      const records = await this.resolveTxt(challengeRecord(row.domain));
      return records.some((chunks) => chunks.join('').trim() === TXT_PREFIX + row.token);
    } catch {
      return false; // NXDOMAIN, no TXT records, resolver failure
    }
  }

  /** DOM-01/02: checks the TXT record; a domain another tenant verified is refused. */
  async verify(owner: DomainOwner, input: unknown) {
    const row = await this.find(owner, input);
    if (row.verifiedAt) return { row, changed: false };
    if (!(await this.recordPresent(row))) {
      throw new BadRequestError(
        `No TXT record "${TXT_PREFIX}${row.token}" found at ${challengeRecord(row.domain)} yet. DNS changes can take a few minutes.`
      );
    }
    const now = new Date();
    try {
      const updated = await this.db.verifiedDomain.update({
        where: { id: row.id },
        data: {
          verifiedAt: now,
          verifiedDomain: row.domain,
          lastCheckedAt: now,
          failingSince: null,
        },
      });
      return { row: updated, changed: true };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictError(
          `${row.domain} is verified by another organization or workspace; an instance admin can release it`
        );
      }
      throw err;
    }
  }

  async remove(owner: DomainOwner, input: unknown) {
    const row = await this.find(owner, input);
    await this.db.verifiedDomain.delete({ where: { id: row.id } });
    return row;
  }

  /** The claim that has verified this domain, if any. */
  verifiedOwnerOf(domain: string) {
    return this.db.verifiedDomain.findUnique({ where: { verifiedDomain: domain } });
  }

  /**
   * DOM-04: the end of the grace period, fixed at the first start with domain verification
   * (so upgrading doesn't break SSO sign-in at once).
   */
  async graceUntil(): Promise<Date> {
    if (this.graceUntilCache) return this.graceUntilCache;
    const until = new Date(Date.now() + this.deps.config.domainGraceDays * DAY_MS);
    const row = await this.db.instanceConfig.upsert({
      where: { key: GRACE_KEY },
      create: { key: GRACE_KEY, value: { at: until.toISOString() }, updatedBy: 'system' },
      update: {},
    });
    this.graceUntilCache = new Date((row.value as { at: string }).at);
    return this.graceUntilCache;
  }

  /** After the grace period was changed in the database (tests, operators). */
  forgetGrace() {
    this.graceUntilCache = undefined;
  }

  async inGrace(now = Date.now()) {
    return (await this.graceUntil()).getTime() > now;
  }

  /**
   * DOM-01..04: the configured trusted domains an SSO configuration may rely on (to trust
   * its emails and auto-join users). A domain verified by someone else never counts; one
   * nobody has verified counts only during the grace period. A workspace may also rely on
   * domains its organization verified.
   */
  async usableTrustedDomains(subject: SsoSubject, configured: string[]): Promise<string[]> {
    if (!configured.length) return [];
    const owners =
      subject.kind === 'organization'
        ? await this.db.organization.findMany({
            where: { slug: subject.slug, deletedAt: null },
            select: { id: true },
          })
        : [];
    const workspace =
      subject.kind === 'workspace'
        ? await this.db.workspace.findUnique({
            where: { slug: subject.slug },
            select: { id: true, organizationId: true },
          })
        : null;
    const own = new Set<string>([
      ...owners.map((o) => `org:${o.id}`),
      ...(workspace ? [`ws:${workspace.id}`] : []),
      ...(workspace?.organizationId ? [`org:${workspace.organizationId}`] : []),
    ]);
    const domains = configured.map((d) => d.trim().toLowerCase());
    const verified = await this.db.verifiedDomain.findMany({
      where: { verifiedDomain: { in: domains } },
    });
    const ownerOf = new Map(
      verified.map((v) => [
        v.domain,
        v.organizationId ? `org:${v.organizationId}` : `ws:${v.workspaceId}`,
      ])
    );
    const grace = await this.inGrace();
    return domains.filter((d) => {
      const owner = ownerOf.get(d);
      return owner ? own.has(owner) : grace;
    });
  }

  /**
   * DOM-05: re-checks verified domains not checked for six days (failing ones every run;
   * the job runs daily). A record missing for
   * `REVERIFY_FAILURE_DAYS` unverifies the domain. Returns the domains unverified.
   */
  async recheck(now = new Date()) {
    const due = await this.db.verifiedDomain.findMany({
      where: {
        verifiedAt: { not: null },
        OR: [
          { lastCheckedAt: null },
          { lastCheckedAt: { lt: new Date(now.getTime() - RECHECK_AFTER_MS) } },
          // Failing ones every run, so a fixed record clears the failure quickly.
          { failingSince: { not: null } },
        ],
      },
    });
    const unverified: VerifiedDomain[] = [];
    for (const row of due) {
      if (await this.recordPresent(row)) {
        await this.db.verifiedDomain.update({
          where: { id: row.id },
          data: { lastCheckedAt: now, failingSince: null },
        });
        continue;
      }
      const failingSince = row.failingSince ?? now;
      const expired = now.getTime() - failingSince.getTime() >= REVERIFY_FAILURE_DAYS * DAY_MS;
      const updated = await this.db.verifiedDomain.update({
        where: { id: row.id },
        data: {
          lastCheckedAt: now,
          failingSince,
          ...(expired && { verifiedAt: null, verifiedDomain: null }),
        },
      });
      if (expired) unverified.push(updated);
    }
    return { checked: due.length, unverified };
  }
}
