// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import type { Prisma, PrismaClient } from '@prisma/client';
import { countSealed, keyId, keyringOf, resealDeep } from './crypto';

/**
 * INST-26: where sealed values live (JSON envelopes, or `sealSecret` strings inside a
 * column or its JSON). `secrets.reseal` re-seals them with the active key; health counts
 * them by key.
 */
const LOCATIONS = [
  {
    model: 'workspaceConfig',
    fields: ['oauthConfig', 'storageConfig', 'oidcConfig', 'samlConfig'],
  },
  { model: 'organization', fields: ['oidcConfig', 'samlConfig'] },
  { model: 'workspaceStorageConfig', fields: ['credentialsEncrypted'] },
  { model: 'instanceConfig', fields: ['value'] },
  { model: 'instanceConfigVersion', fields: ['value'] },
  { model: 'refreshToken', fields: ['ssoRefreshToken'] },
  { model: 'webhookEndpoint', fields: ['secret'] },
  { model: 'orgWebhookEndpoint', fields: ['secret'] },
  { model: 'notificationChannel', fields: ['target'] },
  { model: 'auditSink', fields: ['config'] },
  { model: 'user', fields: ['mfaSecretSealed'] },
] as const;

const BATCH = 200;
export const RESEAL_QUEUE = 'secrets.reseal';

type Delegate = {
  findMany: (args: object) => Promise<Array<Record<string, unknown> & { id: string }>>;
  update: (args: object) => Promise<unknown>;
};

/** Rows of a model in id order, a batch at a time (models added later are skipped). */
async function* rowsOf(db: PrismaClient, model: string, fields: readonly string[]) {
  const delegate = (db as unknown as Record<string, Delegate | undefined>)[model];
  if (!delegate) return;
  let cursor: string | null = null;
  for (;;) {
    const select = Object.fromEntries(['id', ...fields].map((f) => [f, true]));
    const rows: Array<Record<string, unknown> & { id: string }> = await delegate.findMany({
      select,
      orderBy: { id: 'asc' },
      take: BATCH,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
    });
    yield* rows.map((row) => ({ row, delegate }));
    if (rows.length < BATCH) return;
    cursor = rows[rows.length - 1].id;
  }
}

/** Re-seals every value not on the active key; idempotent (a second run changes nothing). */
export async function resealAll(db: PrismaClient, key: Buffer) {
  const counts: Record<string, number> = {};
  for (const { model, fields } of LOCATIONS) {
    for await (const { row, delegate } of rowsOf(db, model, fields)) {
      const data: Record<string, unknown> = {};
      let changed = 0;
      for (const field of fields) {
        if (row[field] === null || row[field] === undefined) continue;
        const result = resealDeep(row[field], key);
        if (result.changed) {
          data[field] = result.value as Prisma.InputJsonValue;
          changed += result.changed;
        }
      }
      if (changed) {
        await delegate.update({ where: { id: row.id }, data });
        counts[model] = (counts[model] ?? 0) + changed;
      }
    }
  }
  return { resealed: Object.values(counts).reduce((a, b) => a + b, 0), byModel: counts };
}

/** INST-26 health: sealed values per key, and how many are not on the active key. */
export async function sealedValueReport(db: PrismaClient, key: Buffer) {
  const counts = new Map<string, number>();
  for (const { model, fields } of LOCATIONS) {
    for await (const { row } of rowsOf(db, model, fields)) {
      for (const field of fields) countSealed(row[field], counts);
    }
  }
  const ring = keyringOf(key);
  const active = keyId(ring.active);
  const keys = [...ring.keys].map(([id, k]) => ({
    id,
    label: k.label,
    active: id === active,
    values: counts.get(id) ?? 0,
  }));
  const unknown = [...counts].filter(([id]) => id !== 'legacy' && !ring.keys.has(id));
  const legacy = counts.get('legacy') ?? 0;
  return {
    active,
    keys,
    legacy,
    // Values sealed with a key that is no longer configured can't be opened.
    unknownKeys: unknown.map(([id, values]) => ({ id, values })),
    stale: [...counts].filter(([id]) => id !== active).reduce((n, [, v]) => n + v, 0),
  };
}
