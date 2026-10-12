// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { auditHash, jsonbText } from '../services/auditChain';
import { Fixtures, bearer } from './helpers/fixtures';

// AUD-09: audit rows are hash-chained per scope by a database trigger.
describe('Audit hash chain (AUD-09)', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  let owner: string;
  let ws: string;
  let workspaceId: string;

  const db = () => app.container.systemDb;
  const event = (n: number, metadata: object = { n }) => ({
    workspaceId,
    actorType: 'system' as const,
    actorId: 'test',
    action: `test.event_${n}`,
    resourceType: 'test',
    resourceId: String(n),
    metadata,
  });
  const verify = async () =>
    (
      await app.inject({
        method: 'GET',
        url: `/api/workspaces/${ws}/audit/verify`,
        headers: bearer(owner),
      })
    ).json();

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    fx = new Fixtures(app);
    const { workspace } = await fx.workspace();
    ws = workspace.slug;
    workspaceId = workspace.id;
    const user = await fx.user();
    await fx.member(workspace.id, user.id, 'owner');
    owner = await fx.session(user);
  });

  afterAll(async () => {
    await db().auditEvent.deleteMany({ where: { workspaceId } });
    await fx.cleanup();
    await app.close();
  });

  it('chains rows in order, with hashes anyone can recompute', async () => {
    await db().auditEvent.create({
      data: event(1, { zeta: 1, a: [1, 'two', { y: true, x: null }], bb: 'é"q' }),
    });
    await db().auditEvent.create({ data: { ...event(2), ip: '203.0.113.1' } });
    await db().auditEvent.create({ data: { ...event(3), metadata: undefined } });
    const rows = await db().auditEvent.findMany({
      where: { workspaceId },
      orderBy: { chainSeq: 'asc' },
    });
    expect(rows.map((r) => r.chainSeq)).toEqual([1n, 2n, 3n]);
    expect(rows[0].prevHash).toBeNull();
    expect(rows[1].prevHash).toBe(rows[0].hash);
    expect(rows[2].prevHash).toBe(rows[1].hash);
    // The TypeScript hash (for external verification) matches the database's.
    for (const r of rows) expect(auditHash(r, workspaceId)).toBe(r.hash);
    expect(jsonbText({ zeta: 1, a: [1], bb: 'x' })).toBe('{"a": [1], "bb": "x", "zeta": 1}');

    expect(await verify()).toMatchObject({
      ok: true,
      rows: 3,
      head: { chainSeq: '3', hash: rows[2].hash },
      problem: null,
    });
  });

  it('keeps one chain under concurrent inserts', async () => {
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        i % 2
          ? db().auditEvent.create({ data: event(100 + i) })
          : app.container.withTenant(workspaceId, (tx) =>
              tx.auditEvent.create({ data: event(100 + i) })
            )
      )
    );
    const seqs = (
      await db().auditEvent.findMany({ where: { workspaceId }, select: { chainSeq: true } })
    )
      .map((r) => Number(r.chainSeq))
      .sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 28 }, (_, i) => i + 1));
    expect((await verify()).ok).toBe(true);
  });

  it('detects a changed, a removed and a relinked row', async () => {
    const at = (seq: number) =>
      db().auditEvent.findFirstOrThrow({ where: { workspaceId, chainSeq: BigInt(seq) } });

    // Changed: the owner role can still write; the chain shows it.
    const fifth = await at(5);
    await db().auditEvent.update({
      where: { id: fifth.id },
      data: { metadata: { n: 'edited' } },
    });
    expect(await verify()).toMatchObject({
      ok: false,
      problem: { chainSeq: '5', id: fifth.id, kind: 'modified' },
    });
    await db().auditEvent.update({ where: { id: fifth.id }, data: { metadata: fifth.metadata! } });
    expect((await verify()).ok).toBe(true);

    // Removed.
    const tenth = await at(10);
    await db().auditEvent.delete({ where: { id: tenth.id } });
    expect((await verify()).problem).toMatchObject({ chainSeq: '11', kind: 'gap' });
    await db().auditEvent.create({
      data: { ...tenth, metadata: tenth.metadata ?? undefined, chainSeq: undefined },
    });
    await db()
      .$executeRaw`UPDATE "AuditEvent" SET "chainSeq" = ${tenth.chainSeq}, "prevHash" = ${tenth.prevHash}, "hash" = ${tenth.hash} WHERE "id" = ${tenth.id}`;
    expect((await verify()).ok).toBe(true);

    // Relinked: a row rehashed consistently, but the next one still points at the old hash.
    const twelfth = await at(12);
    const forged = auditHash({ ...twelfth, prevHash: 'forged' }, workspaceId);
    await db()
      .$executeRaw`UPDATE "AuditEvent" SET "prevHash" = 'forged', "hash" = ${forged} WHERE "id" = ${twelfth.id}`;
    expect((await verify()).problem).toMatchObject({ chainSeq: '12', kind: 'unlinked' });
  });

  it('puts the chain in exports', async () => {
    const csv = await app.inject({
      method: 'GET',
      url: `/api/workspaces/${ws}/audit/export?format=csv`,
      headers: bearer(owner),
    });
    expect(csv.body.split('\r\n')[0]).toContain('id,chainSeq,prevHash,hash');
    const jsonl = await app.inject({
      method: 'GET',
      url: `/api/workspaces/${ws}/audit/export?format=jsonl`,
      headers: bearer(owner),
    });
    const first = JSON.parse(jsonl.body.split('\n')[0]);
    expect(first).toHaveProperty('hash');
    expect(first).toHaveProperty('chainSeq');
  });

  it('verifies the instance chain for instance admins', async () => {
    const root = await fx.session(await fx.user({ instanceAdmin: true }));
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/audit/verify',
      headers: bearer(root),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('ok');
    expect(res.json().rows).toBeGreaterThan(0);
  });
});
