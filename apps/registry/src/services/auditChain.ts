// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';

/**
 * AUD-09: every audit row (workspace, organization, instance) carries `chainSeq`, the
 * previous row's `hash` (`prevHash`) and its own `hash`, set by the `harmoniq_audit_chain`
 * trigger (migration `20261012180000_audit_hash_chain`):
 *
 *   hash = sha256_hex(join('|', prevHash ?? '', id, scope, actorType, actorId, action,
 *                         resourceType, resourceId, metadata as jsonb text ?? '', ip ?? '',
 *                         createdAt in epoch milliseconds))
 *
 * `scope` is the workspace id, the organization id, or '' for the instance. Changing,
 * removing or reordering a row breaks the chain from there on. Retention removes the oldest
 * rows: a chain then starts at its first remaining row, whose `prevHash` is the anchor.
 */

export type ChainScope =
  { kind: 'workspace'; id: string } | { kind: 'organization'; id: string } | { kind: 'instance' };

/**
 * PostgreSQL's text form of a jsonb value: object keys ordered by length, then bytes;
 * `", "` and `": "` separators. Enough to recompute hashes outside the database.
 */
export function jsonbText(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(jsonbText).join(', ')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value as object).sort((a, b) => {
      const la = Buffer.byteLength(a);
      const lb = Buffer.byteLength(b);
      return la !== lb ? la - lb : Buffer.compare(Buffer.from(a), Buffer.from(b));
    });
    return `{${keys
      .map((k) => `${JSON.stringify(k)}: ${jsonbText((value as Record<string, unknown>)[k])}`)
      .join(', ')}}`;
  }
  return JSON.stringify(value);
}

/** The hash of a row, as the trigger computes it. */
export function auditHash(
  row: {
    id: string;
    actorType: string;
    actorId: string;
    action: string;
    resourceType: string;
    resourceId: string;
    metadata: unknown;
    ip: string | null;
    createdAt: Date;
    prevHash: string | null;
  },
  scope: string
) {
  const fields = [
    row.prevHash ?? '',
    row.id,
    scope,
    row.actorType,
    row.actorId,
    row.action,
    row.resourceType,
    row.resourceId,
    row.metadata === null || row.metadata === undefined ? '' : jsonbText(row.metadata),
    row.ip ?? '',
    String(row.createdAt.getTime()),
  ];
  return createHash('sha256').update(fields.join('|'), 'utf8').digest('hex');
}

export interface ChainReport {
  ok: boolean;
  rows: number;
  /** The newest row: keep its hash to prove later that nothing before it changed. */
  head: { chainSeq: string; hash: string } | null;
  /** The first problem, in chain order. */
  problem: {
    chainSeq: string;
    id: string;
    kind: 'modified' | 'unlinked' | 'gap' | 'unchained';
  } | null;
}

const TABLES = {
  workspace: { table: 'AuditEvent', column: 'workspaceId' },
  organization: { table: 'OrganizationAuditEvent', column: 'organizationId' },
  instance: { table: 'InstanceAuditEvent', column: null },
} as const;

/**
 * Recomputes every row's hash in the database and checks the links: `modified` (the row
 * changed), `unlinked` (its prevHash isn't the previous row's hash), `gap` (a row is
 * missing), `unchained` (a row without a chain position).
 */
export async function verifyChain(
  db: { $queryRaw: Prisma.TransactionClient['$queryRaw'] },
  scope: ChainScope
): Promise<ChainReport> {
  const { table, column } = TABLES[scope.kind];
  const scopeValue = scope.kind === 'instance' ? '' : scope.id;
  const where =
    column === null ? Prisma.empty : Prisma.sql`WHERE ${Prisma.raw(`"${column}"`)} = ${scopeValue}`;
  const table_ = Prisma.raw(`"${table}"`);
  // Only the first problem and a summary leave the database, however long the log.
  const [problems, summary] = await Promise.all([
    db.$queryRaw<Array<{ id: string; chainSeq: bigint | null; kind: string }>>`
      WITH c AS (
        SELECT "id", "chainSeq", "hash", "prevHash",
          harmoniq_audit_hash("prevHash", "id", ${scopeValue}, "actorType"::text, "actorId",
            "action", "resourceType", "resourceId", "metadata", "ip", "createdAt") AS computed,
          lag("hash") OVER w AS prev_actual,
          lag("chainSeq") OVER w AS prev_seq,
          row_number() OVER w AS n
        FROM ${table_} ${where}
        WINDOW w AS (ORDER BY "chainSeq" NULLS LAST, "createdAt", "id")
      )
      SELECT "id", "chainSeq",
        CASE
          WHEN "chainSeq" IS NULL OR "hash" IS NULL THEN 'unchained'
          WHEN computed <> "hash" THEN 'modified'
          WHEN n > 1 AND prev_seq IS NOT NULL AND "chainSeq" <> prev_seq + 1 THEN 'gap'
          ELSE 'unlinked'
        END AS kind
      FROM c
      WHERE "chainSeq" IS NULL OR "hash" IS NULL OR computed <> "hash"
        OR (n > 1 AND prev_seq IS NOT NULL AND "chainSeq" <> prev_seq + 1)
        OR (n > 1 AND "prevHash" IS DISTINCT FROM prev_actual)
      ORDER BY n
      LIMIT 1`,
    db.$queryRaw<Array<{ rows: bigint; chainSeq: bigint | null; hash: string | null }>>`
      SELECT (SELECT count(*) FROM ${table_} ${where}) AS rows, h."chainSeq", h."hash"
      FROM (SELECT 1) one
      LEFT JOIN LATERAL (
        SELECT "chainSeq", "hash" FROM ${table_} ${where}
        ORDER BY "chainSeq" DESC NULLS LAST LIMIT 1
      ) h ON true`,
  ]);
  const first = problems[0];
  const head = summary[0];
  return {
    ok: !first,
    rows: Number(head?.rows ?? 0),
    head:
      head?.chainSeq !== null && head?.chainSeq !== undefined && head.hash
        ? { chainSeq: head.chainSeq.toString(), hash: head.hash }
        : null,
    problem: first
      ? {
          chainSeq: first.chainSeq?.toString() ?? '',
          id: first.id,
          kind: first.kind as NonNullable<ChainReport['problem']>['kind'],
        }
      : null,
  };
}
