// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { BlockList, isIP } from 'net';
import { randomUUID } from 'crypto';
import type { ApprovalPolicy, OrgPolicy, Prisma } from '@prisma/client';
import { BadRequestError, PolicyViolationError } from '@harmoniq/core/dist/errors/AppError';
import type { OrgPolicyInput } from '@harmoniq/core/dist/schemas/OrgPolicySchema';

/**
 * POL-01..09: organization-wide policy. A workspace may be stricter than its organization,
 * never weaker; where both set a value the strictest wins. The org policy row is readable
 * from the organization's workspaces (RLS), so enforcement runs in workspace transactions.
 */

type Tx = Prisma.TransactionClient;

export interface ApprovalRule {
  requiredApprovers: number;
  eligibleRoles: string[];
  requireChangeTicket: boolean;
  ticketUrlPattern: string | null;
  expiryHours: number;
}
export interface ApprovalDefault extends ApprovalRule {
  environmentPattern: string;
}
export interface FreezeWindow {
  id: string;
  environmentPattern: string;
  from?: string | null;
  until?: string | null;
  reason: string;
  /** POL-05: an org admin lets changes through until then (ENV-FRZ-03 semantics). */
  override?: { until: string; reason: string; by: string } | null;
}

export type PolicySource = 'organization' | 'workspace' | null;

/** `*` matches any run of characters; everything else is literal. */
export function matchesPattern(pattern: string, slug: string) {
  const re = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${re}$`).test(slug);
}

/** The organization's policy, or null (no organization, or no policy saved). */
export async function orgPolicyFor(tx: Tx, organizationId: string | null | undefined) {
  if (!organizationId) return null;
  return tx.orgPolicy.findUnique({ where: { organizationId } });
}

export const approvalDefaults = (policy: OrgPolicy | null) =>
  ((policy?.approvalDefaults ?? []) as unknown as ApprovalDefault[]).map((d) => ({
    ...d,
    ticketUrlPattern: d.ticketUrlPattern ?? null,
  }));

export const freezeWindows = (policy: OrgPolicy | null) =>
  (policy?.freezeWindows ?? []) as unknown as FreezeWindow[];

/** POL-02: the org default for an environment: the first rule whose pattern matches. */
export function approvalDefaultFor(policy: OrgPolicy | null, environmentSlug: string) {
  return approvalDefaults(policy).find((d) => matchesPattern(d.environmentPattern, environmentSlug));
}

/** Why `rule` is weaker than `floor` (empty when it is at least as strict). */
export function weakerThan(rule: ApprovalRule, floor: ApprovalRule) {
  const reasons: string[] = [];
  if (rule.requiredApprovers < floor.requiredApprovers) {
    reasons.push(`needs at least ${floor.requiredApprovers} approvers`);
  }
  const extra = rule.eligibleRoles.filter((r) => !floor.eligibleRoles.includes(r));
  if (extra.length) reasons.push(`roles not allowed to approve: ${extra.join(', ')}`);
  if (floor.requireChangeTicket && !rule.requireChangeTicket) {
    reasons.push('must require a change ticket');
  }
  if (rule.expiryHours > floor.expiryHours) {
    reasons.push(`requests must expire within ${floor.expiryHours} hours`);
  }
  return reasons;
}

/**
 * POL-02: the approval rule an environment enforces: the workspace's and the org default's,
 * strictest of each (a policy saved before the default may be weaker; it is tightened).
 */
export function effectiveApproval(
  own: Pick<ApprovalPolicy, keyof ApprovalRule> | null,
  orgDefault: ApprovalRule | null | undefined
): { rule: ApprovalRule; source: PolicySource } | null {
  if (!own && !orgDefault) return null;
  if (!orgDefault) return { rule: { ...own! }, source: 'workspace' };
  if (!own) return { rule: { ...orgDefault }, source: 'organization' };
  const roles = own.eligibleRoles.filter((r) => orgDefault.eligibleRoles.includes(r));
  return {
    rule: {
      requiredApprovers: Math.max(own.requiredApprovers, orgDefault.requiredApprovers),
      eligibleRoles: roles.length ? roles : orgDefault.eligibleRoles,
      requireChangeTicket: own.requireChangeTicket || orgDefault.requireChangeTicket,
      ticketUrlPattern: own.ticketUrlPattern ?? orgDefault.ticketUrlPattern,
      expiryHours: Math.min(own.expiryHours, orgDefault.expiryHours),
    },
    source: weakerThan(own, orgDefault).length ? 'organization' : 'workspace',
  };
}

/** Refuses a workspace approval policy weaker than its organization's default (POL-02). */
export function assertApprovalPolicy(
  policy: OrgPolicy | null,
  environmentSlug: string,
  rule: ApprovalRule
) {
  const floor = approvalDefaultFor(policy, environmentSlug);
  if (!floor) return;
  const reasons = weakerThan(rule, floor);
  if (reasons.length) {
    throw new PolicyViolationError(
      `The organization's approval policy for "${environmentSlug}" is stricter: ${reasons.join('; ')}`,
      { environment: environmentSlug, policy: floor, reasons }
    );
  }
}

/** POL-03: what is wrong with a key under the policy (empty when nothing). */
export function keyPolicyViolations(
  policy: OrgPolicy | null,
  key: { scopes: string[]; expiresAt: Date | null; createdAt?: Date },
  now = Date.now()
) {
  if (!policy) return [];
  const problems: string[] = [];
  const allowed = policy.allowedKeyScopes;
  const denied = key.scopes.filter((s) => allowed.length && !allowed.includes(s));
  if (denied.length) problems.push(`scopes not allowed: ${denied.join(', ')}`);
  if (policy.maxApiKeyDays) {
    const start = key.createdAt?.getTime() ?? now;
    const limit = start + policy.maxApiKeyDays * 86_400_000;
    if (!key.expiresAt) problems.push(`must expire within ${policy.maxApiKeyDays} days`);
    // A minute of slack for a client that picked exactly the maximum.
    else if (key.expiresAt.getTime() > limit + 60_000) {
      problems.push(`must expire within ${policy.maxApiKeyDays} days`);
    }
  }
  return problems;
}

/** POL-03: the expiry a rotated key gets: its old one, no later than the policy allows. */
export function cappedExpiry(policy: OrgPolicy | null, expiresAt: Date | null, now = Date.now()) {
  if (!policy?.maxApiKeyDays) return expiresAt;
  const limit = new Date(now + policy.maxApiKeyDays * 86_400_000);
  return expiresAt && expiresAt < limit ? expiresAt : limit;
}

export function assertKeyPolicy(
  policy: OrgPolicy | null,
  key: { scopes: string[]; expiresAt: Date | null }
) {
  const problems = keyPolicyViolations(policy, key);
  if (problems.length) {
    throw new PolicyViolationError(`The organization's API key policy: ${problems.join('; ')}`, {
      problems,
      maxApiKeyDays: policy?.maxApiKeyDays ?? null,
      allowedKeyScopes: policy?.allowedKeyScopes ?? [],
    });
  }
}

/** POL-04: refuses a retention below the organization's floor. */
export function assertRetention(policy: OrgPolicy | null, retentionDays: number) {
  if (policy?.minRetentionDays && retentionDays < policy.minRetentionDays) {
    throw new PolicyViolationError(
      `The organization keeps history for at least ${policy.minRetentionDays} days`,
      { minRetentionDays: policy.minRetentionDays }
    );
  }
}

/**
 * POL-05: the org freeze window in force for an environment, if any. `overridden` when an
 * org admin let changes through until a time that hasn't passed.
 */
export function activeOrgFreeze(policy: OrgPolicy | null, environmentSlug: string, now = new Date()) {
  for (const w of freezeWindows(policy)) {
    if (!matchesPattern(w.environmentPattern, environmentSlug)) continue;
    if (w.from && new Date(w.from) > now) continue;
    if (w.until && new Date(w.until) <= now) continue;
    const overridden = !!w.override && new Date(w.override.until) > now;
    return { window: w, overridden };
  }
  return null;
}

/**
 * Normalizes a saved policy: freeze windows keep their id and override across saves, new
 * ones get an id; the IP allowlist must parse.
 */
export function normalizePolicy(input: OrgPolicyInput, previous: OrgPolicy | null) {
  const before = new Map(freezeWindows(previous).map((w) => [w.id, w]));
  const windows: FreezeWindow[] = input.freezeWindows.map((w) => {
    const prior = w.id ? before.get(w.id) : undefined;
    return {
      id: prior?.id ?? randomUUID().slice(0, 8),
      environmentPattern: w.environmentPattern,
      from: w.from?.toISOString() ?? null,
      until: w.until?.toISOString() ?? null,
      reason: w.reason,
      override: prior?.override ?? null,
    };
  });
  parseAllowlist(input.ipAllowlist);
  return {
    approvalDefaults: input.approvalDefaults.map((d) => ({
      ...d,
      ticketUrlPattern: d.ticketUrlPattern ?? null,
    })) as unknown as Prisma.InputJsonValue,
    maxApiKeyDays: input.maxApiKeyDays,
    allowedKeyScopes: input.allowedKeyScopes,
    minRetentionDays: input.minRetentionDays,
    freezeWindows: windows as unknown as Prisma.InputJsonValue,
    lockSso: input.lockSso,
    sessionMaxHours: input.sessionMaxHours,
    idleTimeoutMinutes: input.idleTimeoutMinutes,
    ipAllowlist: input.ipAllowlist.map((c) => c.trim()),
    ipAllowlistManifests: input.ipAllowlistManifests,
  };
}

/** The policy as the API shows it (also the before/after of the audit event). */
export function policyDto(policy: OrgPolicy | null) {
  return {
    approvalDefaults: approvalDefaults(policy),
    maxApiKeyDays: policy?.maxApiKeyDays ?? null,
    allowedKeyScopes: policy?.allowedKeyScopes ?? [],
    minRetentionDays: policy?.minRetentionDays ?? null,
    freezeWindows: freezeWindows(policy),
    lockSso: policy?.lockSso ?? false,
    sessionMaxHours: policy?.sessionMaxHours ?? null,
    idleTimeoutMinutes: policy?.idleTimeoutMinutes ?? null,
    ipAllowlist: policy?.ipAllowlist ?? [],
    ipAllowlistManifests: policy?.ipAllowlistManifests ?? false,
    updatedAt: policy?.updatedAt.toISOString() ?? null,
    updatedBy: policy?.updatedBy ?? null,
  };
}

/** POL-01: the fields that changed, before and after. */
export function policyChanges(
  before: ReturnType<typeof policyDto>,
  after: ReturnType<typeof policyDto>
) {
  const changes: Record<string, { before: unknown; after: unknown }> = {};
  for (const key of Object.keys(after) as (keyof typeof after)[]) {
    if (key === 'updatedAt' || key === 'updatedBy') continue;
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      changes[key] = { before: before[key], after: after[key] };
    }
  }
  return changes;
}

// ─── IP allowlist (POL-08) ──────────────────────────────────────────────────

const allowlists = new Map<string, BlockList>();

/** A BlockList of the entries; `400` naming the first that doesn't parse. */
export function parseAllowlist(entries: string[]) {
  const key = entries.join(',');
  const cached = allowlists.get(key);
  if (cached) return cached;
  const list = new BlockList();
  for (const raw of entries) {
    const entry = raw.trim();
    const [address, prefix] = entry.split('/');
    const family = isIP(address);
    const bits = prefix === undefined ? (family === 6 ? 128 : 32) : Number(prefix);
    if (
      !family ||
      (prefix !== undefined && !/^\d{1,3}$/.test(prefix)) ||
      bits > (family === 6 ? 128 : 32)
    ) {
      throw new BadRequestError(`Not an IP address or CIDR block: ${entry}`);
    }
    list.addSubnet(address, bits, family === 6 ? 'ipv6' : 'ipv4');
  }
  if (allowlists.size > 500) allowlists.clear();
  allowlists.set(key, list);
  return list;
}

/** Whether `ip` is in the allowlist (an empty list allows everyone). */
export function ipAllowed(entries: string[], ip: string) {
  if (!entries.length) return true;
  const list = parseAllowlist(entries);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  const address = mapped ? mapped[1] : ip;
  const family = isIP(address);
  if (!family) return false;
  return list.check(address, family === 6 ? 'ipv6' : 'ipv4');
}
