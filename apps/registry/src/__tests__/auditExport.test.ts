// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { Fixtures, bearer } from './helpers/fixtures';

describe('Audit export (M4.11)', () => {
  let app: FastifyInstance;
  let fx: Fixtures;
  let admin: string;
  let developer: string;
  let root: string;
  let ws: string;
  let workspaceId: string;
  const org = `exp-${randomUUID().slice(0, 8)}`;

  const get = (as: string, url: string) => app.inject({ method: 'GET', url, headers: bearer(as) });
  const csvRows = (body: string) => body.trim().split('\r\n');

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    fx = new Fixtures(app);
    const [a, d, r] = await Promise.all([fx.user(), fx.user(), fx.user({ instanceAdmin: true })]);
    [admin, developer, root] = await Promise.all([a, d, r].map((u) => fx.session(u)));
    const { workspace } = await fx.workspace();
    ws = workspace.slug;
    workspaceId = workspace.id;
    await fx.member(workspace.id, a.id, 'owner');
    await fx.member(workspace.id, d.id, 'developer');

    // More than one batch (1000), with distinct timestamps, plus a hostile cell.
    const base = Date.now() - 10_000_000;
    await app.container.systemDb.auditEvent.createMany({
      data: Array.from({ length: 1205 }, (_, i) => ({
        workspaceId,
        actorId: 'tester',
        actorType: 'user' as const,
        action: i % 2 ? 'module.deploy' : 'env.freeze',
        resourceType: 'module',
        resourceId: i === 0 ? '=HYPERLINK("http://evil")' : `r${i}`,
        metadata: { i, note: 'comma, "quote"' },
        createdAt: new Date(base + i * 1000),
      })),
    });
  });

  afterAll(async () => {
    await app.container.systemDb.workspace.updateMany({
      where: { id: workspaceId },
      data: { organizationId: null },
    });
    await app.container.systemDb.organization.deleteMany({ where: { slug: org } });
    await fx.cleanup();
    await app.close();
  });

  it('exports every event as CSV, newest first, safe for spreadsheets', async () => {
    const res = await get(admin, `/api/workspaces/${ws}/audit/export`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toMatch(
      new RegExp(`attachment; filename="harmoniq-audit-${ws}-\\d{4}-\\d{2}-\\d{2}\\.csv"`)
    );
    const rows = csvRows(res.body);
    expect(rows[0]).toBe(
      'createdAt,actorType,actorId,action,resourceType,resourceId,ip,metadata,id,chainSeq,prevHash,hash'
    );
    // Header, the export itself (recorded first, so newest), then every event.
    expect(rows).toHaveLength(1 + 1 + 1205);
    expect(rows[1]).toContain('audit.export');
    expect(rows[2]).toContain('r1204');
    const hostile = rows.find((r) => r.includes('HYPERLINK'))!;
    expect(hostile).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(hostile).toContain('"{""i"":0,""note"":""comma, \\""quote\\""""}"');
  });

  it('exports JSON Lines with filters, and records the export', async () => {
    const res = await get(
      admin,
      `/api/workspaces/${ws}/audit/export?format=jsonl&action=env.&actor=tester`
    );
    expect(res.headers['content-type']).toContain('application/x-ndjson');
    const lines = res.body
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(603);
    expect(lines.every((l: { action: string }) => l.action === 'env.freeze')).toBe(true);
    expect(lines[0]).toMatchObject({ actorId: 'tester', resourceType: 'module' });

    const recorded = await app.container.systemDb.auditEvent.findFirst({
      where: { workspaceId, action: 'audit.export' },
      orderBy: { createdAt: 'desc' },
    });
    expect(recorded?.metadata).toMatchObject({ format: 'jsonl', filters: { action: 'env.' } });

    expect((await get(developer, `/api/workspaces/${ws}/audit/export`)).statusCode).toBe(403);
    expect((await get(admin, `/api/workspaces/${ws}/audit/export?format=xml`)).statusCode).toBe(
      400
    );
  });

  it('exports an organization log merged across workspaces', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/orgs',
      headers: bearer(admin),
      payload: { name: 'Export Org', slug: org },
    });
    await app.inject({
      method: 'POST',
      url: `/api/orgs/${org}/workspaces/${ws}/attach`,
      headers: bearer(admin),
    });
    const res = await get(admin, `/api/orgs/${org}/audit/export?format=jsonl`);
    expect(res.statusCode).toBe(200);
    const lines = res.body
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const actions = lines.map((l: { action: string }) => l.action);
    expect(actions).toEqual(expect.arrayContaining(['org.create', 'org.workspace_attach']));
    expect(lines.some((l: { workspace: string | null }) => l.workspace === ws)).toBe(true);
    // Merged newest first.
    const times = lines.map((l: { createdAt: string }) => Date.parse(l.createdAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('exports the instance log for instance admins', async () => {
    const res = await get(root, '/api/admin/audit/export');
    expect(res.statusCode).toBe(200);
    expect(csvRows(res.body)[0]).toBe(
      'createdAt,actorType,actorId,action,resourceType,resourceId,ip,metadata,id,chainSeq,prevHash,hash'
    );
    expect((await get(admin, '/api/admin/audit/export')).statusCode).toBe(403);
  });
});
