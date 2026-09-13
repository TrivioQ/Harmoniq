import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Workspace } from '@prisma/client';
import { getTenantClient } from '../index';

describe('Prisma RLS Middleware', () => {
  let prisma: PrismaClient;
  let workspace1: Workspace;
  let workspace2: Workspace;

  beforeAll(async () => {
    prisma = new PrismaClient();

    // Clear
    await prisma.workspace.deleteMany();
    await prisma.user.deleteMany();

    await prisma.user.create({
      data: { email: 'rls-test@test.com', name: 'RLS Test' },
    });

    workspace1 = await prisma.workspace.create({
      data: { slug: 'ws-1', name: 'WS 1' },
    });

    workspace2 = await prisma.workspace.create({
      data: { slug: 'ws-2', name: 'WS 2' },
    });

    const tenant1 = getTenantClient(prisma, workspace1.id);
    await tenant1.hostApp.create({
      data: {
        workspaceId: workspace1.id,
        name: 'App 1',
        slug: 'app-1',
      },
    });

    const tenant2 = getTenantClient(prisma, workspace2.id);
    await tenant2.hostApp.create({
      data: {
        workspaceId: workspace2.id,
        name: 'App 2',
        slug: 'app-2',
      },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('should only return records for the specified workspace', async () => {
    const tenant1Client = getTenantClient(prisma, workspace1.id);
    const apps1 = await tenant1Client.hostApp.findMany();

    expect(apps1.length).toBe(1);
    expect(apps1[0].name).toBe('App 1');

    const tenant2Client = getTenantClient(prisma, workspace2.id);
    const apps2 = await tenant2Client.hostApp.findMany();

    expect(apps2.length).toBe(1);
    expect(apps2[0].name).toBe('App 2');
  });

  it('should not allow creating records with a mismatched workspaceId', async () => {
    const tenant1Client = getTenantClient(prisma, workspace1.id);

    // Attempting to create an app in workspace2 while scoped to workspace1
    // Usually RLS allows INSERT if the row passes the policy. Our policy uses:
    // `workspaceId` = current_setting(...)
    // So if we try to insert with `workspaceId: workspace2.id`, Postgres will reject it
    // because the resulting row violates the `WITH CHECK` condition of the policy (which defaults to the USING condition).

    await expect(
      tenant1Client.hostApp.create({
        data: {
          workspaceId: workspace2.id,
          name: 'Sneaky App',
          slug: 'sneaky',
        },
      })
    ).rejects.toThrow();
  });
});
