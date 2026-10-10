// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'crypto';
import type { TargetingRule } from '@harmoniq/core/dist/schemas/CanaryRequestSchema';

/** A running canary, as cached with the stable manifest so assignment needs no database. */
export interface CanaryInfo {
  moduleId: string;
  module: string;
  versionId: string;
  version: string;
  trafficPercent: number;
  targeting?: TargetingRule[];
}

export const USER_ID_HEADER = 'x-harmoniq-user-id';
export const CONTEXT_HEADER = 'x-harmoniq-context';
const MAX_CONTEXT_LENGTH = 2048;
const MAX_CONTEXT_KEYS = 20;
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
 * CAN-02: modules whose canary this user gets. Targeting rules match first (M3.6); then
 * the percentage, which is sticky because it depends only on the cohort, so raising the
 * traffic keeps everyone already in the canary there. Without a cohort (no user key) only
 * targeting applies.
 */
export function assignCanaries(
  canaries: CanaryInfo[],
  cohortId: string | null,
  attributes: Record<string, string> = {}
): CanaryInfo[] {
  return canaries.filter(
    (c) =>
      c.targeting?.some((rule) => {
        const value = attributes[rule.attribute];
        return value !== undefined && rule.values.includes(value);
      }) ||
      (cohortId !== null && bucketFor(cohortId, c.moduleId) < c.trafficPercent)
  );
}

/**
 * Targeting attributes from `X-Harmoniq-Context` (a small JSON object of strings), plus
 * `userId`. Malformed or oversized headers are ignored, never an error: the manifest must
 * always be served.
 */
export function attributesFrom(
  headers: Record<string, string | string[] | undefined>,
  userKey: string | null
): Record<string, string> {
  const attributes: Record<string, string> = {};
  const raw = headers[CONTEXT_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value && value.length <= MAX_CONTEXT_LENGTH) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed).slice(0, MAX_CONTEXT_KEYS)) {
          if (
            k.length <= 64 &&
            (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
          ) {
            attributes[k] = String(v).slice(0, 200);
          }
        }
      }
    } catch {
      // ignore
    }
  }
  if (userKey) attributes.userId = userKey;
  return attributes;
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
