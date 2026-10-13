// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { Readable } from 'stream';
import type { FastifyReply } from 'fastify';
import { BadRequestError } from '@harmoniq/core/dist/errors/AppError';

// Compliance export of audit logs (workspace, organization, instance): every matching
// event, newest first, streamed as CSV or JSON Lines in keyset-paginated batches.

export interface ExportRow {
  id: string;
  createdAt: Date;
  workspace?: string | null;
  actorType: string;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  ip?: string | null;
  metadata: unknown;
  /** AUD-09: the row's place in its scope's hash chain. */
  chainSeq?: bigint | null;
  prevHash?: string | null;
  hash?: string | null;
}

export type ExportFormat = 'csv' | 'jsonl';
type Position = { createdAt: Date; id: string };

const BATCH = 1000;

export function exportFormat(value: string | undefined): ExportFormat {
  if (value === undefined || value === 'csv') return 'csv';
  if (value === 'jsonl') return 'jsonl';
  throw new BadRequestError('format must be csv or jsonl');
}

/** Rows strictly after `after` in (createdAt desc, id desc) order. */
export const afterWhere = (after: Position | null) =>
  after
    ? {
        OR: [
          { createdAt: { lt: after.createdAt } },
          { createdAt: after.createdAt, id: { lt: after.id } },
        ],
      }
    : {};

export const NEWEST_FIRST = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];

/** Every row, fetched in batches; `fetch` returns rows newest first after `after`. */
export async function* keysetRows<T extends Position>(
  fetch: (after: Position | null, take: number) => Promise<T[]>
): AsyncGenerator<T> {
  let after: Position | null = null;
  for (;;) {
    const rows = await fetch(after, BATCH);
    yield* rows;
    if (rows.length < BATCH) return;
    after = rows[rows.length - 1];
  }
}

const newer = (a: Position, b: Position) =>
  a.createdAt.getTime() !== b.createdAt.getTime()
    ? a.createdAt.getTime() > b.createdAt.getTime()
    : a.id > b.id;

/** Two newest-first streams as one. */
export async function* mergeNewestFirst<T extends Position>(
  a: AsyncIterator<T>,
  b: AsyncIterator<T>
): AsyncGenerator<T> {
  let x = await a.next();
  let y = await b.next();
  while (!x.done || !y.done) {
    if (y.done || (!x.done && newer(x.value, y.value))) {
      yield x.value as T;
      x = await a.next();
    } else {
      yield y.value;
      y = await b.next();
    }
  }
}

/** Date filters from the query (`from`, `to`, ISO dates). */
export function dateRange(query: { from?: string; to?: string }) {
  const date = (v?: string) => {
    if (!v) return undefined;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) throw new BadRequestError(`Invalid date: ${v}`);
    return d;
  };
  const range = { gte: date(query.from), lte: date(query.to) };
  return range.gte || range.lte ? { createdAt: range } : {};
}

const COLUMNS = [
  'createdAt',
  'workspace',
  'actorType',
  'actorId',
  'action',
  'resourceType',
  'resourceId',
  'ip',
  'metadata',
  // AUD-09: enough to check the chain (see services/auditChain.ts).
  'id',
  'chainSeq',
  'prevHash',
  'hash',
] as const;

/** RFC 4180 quoting; cells a spreadsheet would run as formulas are neutralized. */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Sends the rows as a download. */
export function sendExport(
  reply: FastifyReply,
  rows: AsyncIterable<ExportRow>,
  opts: { format: ExportFormat; name: string; workspaceColumn: boolean }
) {
  const columns = COLUMNS.filter((c) => c !== 'workspace' || opts.workspaceColumn);
  async function* lines() {
    if (opts.format === 'csv') yield columns.join(',') + '\r\n';
    for await (const row of rows) {
      const record = {
        createdAt: row.createdAt.toISOString(),
        workspace: row.workspace ?? null,
        actorType: row.actorType,
        actorId: row.actorId,
        action: row.action,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        ip: row.ip ?? null,
        metadata: row.metadata ?? null,
        id: row.id,
        chainSeq: row.chainSeq === null || row.chainSeq === undefined ? null : String(row.chainSeq),
        prevHash: row.prevHash ?? null,
        hash: row.hash ?? null,
      };
      if (opts.format === 'jsonl') {
        const { workspace, id, ...rest } = record;
        yield JSON.stringify({ id, ...(opts.workspaceColumn && { workspace }), ...rest }) + '\n';
      } else {
        yield columns
          .map((c) => csvCell(c === 'metadata' ? JSON.stringify(record.metadata) : record[c]))
          .join(',') + '\r\n';
      }
    }
  }
  const day = new Date().toISOString().slice(0, 10);
  return reply
    .header(
      'Content-Type',
      opts.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8'
    )
    .header(
      'Content-Disposition',
      `attachment; filename="harmoniq-audit-${opts.name}-${day}.${opts.format}"`
    )
    .header('Cache-Control', 'no-store')
    .send(Readable.from(lines()));
}
