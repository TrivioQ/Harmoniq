import { createHash } from 'crypto';

/** A running canary, as cached with the stable manifest so assignment needs no database. */
export interface CanaryInfo {
  moduleId: string;
  module: string;
  versionId: string;
  version: string;
  trafficPercent: number;
}

export const USER_ID_HEADER = 'x-harmoniq-user-id';
export const CANARY_COOKIE = 'harmoniq_canary';
const MAX_USER_KEY_LENGTH = 256;

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * CAN-07: an opaque, stable id for the user within the workspace. Safe to log and to
 * send to analytics; the raw user id can't be recovered from it.
 */
export function cohortIdFor(workspaceId: string, userKey: string): string {
  return sha256(`${workspaceId}:${userKey}`).slice(0, 16);
}

/**
 * The user's bucket (0–99) for one module. Hashing per module keeps canaries of
 * different modules independent: being in one module's 10% says nothing about another's.
 */
export function bucketFor(cohortId: string, moduleId: string): number {
  return parseInt(sha256(`${cohortId}:${moduleId}`).slice(0, 8), 16) % 100;
}

/**
 * CAN-02: modules whose canary this cohort gets. Sticky because it depends only on the
 * cohort; raising the traffic keeps everyone already in the canary there.
 */
export function assignCanaries(canaries: CanaryInfo[], cohortId: string): CanaryInfo[] {
  return canaries.filter((c) => bucketFor(cohortId, c.moduleId) < c.trafficPercent);
}

/**
 * Cache variant for a set of canary modules (CAN-03). Users with the same set share one
 * cached manifest, so there are at most 2^(running canaries) variants per environment.
 */
export function variantKey(assigned: CanaryInfo[]): string {
  if (!assigned.length) return 'stable';
  const ids = assigned.map((c) => c.versionId).sort();
  return `canary-${sha256(ids.join(',')).slice(0, 16)}`;
}

/** The user key from the `X-Harmoniq-User-Id` header, or the `harmoniq_canary` cookie. */
export function userKeyFrom(headers: Record<string, string | string[] | undefined>) {
  const header = headers[USER_ID_HEADER];
  const value = Array.isArray(header) ? header[0] : header;
  if (value?.trim()) return value.trim().slice(0, MAX_USER_KEY_LENGTH);

  const cookie = headers.cookie;
  const raw = Array.isArray(cookie) ? cookie.join(';') : cookie;
  const match = raw?.match(new RegExp(`(?:^|;\\s*)${CANARY_COOKIE}=([^;]+)`));
  return match ? decodeURIComponent(match[1]).slice(0, MAX_USER_KEY_LENGTH) : null;
}
