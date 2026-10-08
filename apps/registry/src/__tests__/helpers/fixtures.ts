import { randomUUID } from 'crypto';
import { FastifyInstance } from 'fastify';
import type { Role } from '@prisma/client';
import { displayPrefix, formatApiKey, generateApiKeySecret } from '../../auth/apiKeys';
import { signAccessToken } from '../../auth/tokens';

/**
 * Isolated test data, created through the system role. Every fixture gets unique slugs
 * and emails, and `cleanup()` removes only what it created — tests never wipe shared tables.
 */
export class Fixtures {
  private workspaceIds: string[] = [];
  private userIds: string[] = [];

  constructor(private app: FastifyInstance) {}

  private get db() {
    return this.app.container.systemDb;
  }

  async user(opts: { instanceAdmin?: boolean } = {}) {
    const user = await this.db.user.create({
      data: { email: `user-${randomUUID()}@test.local`, name: 'Test User' },
    });
    this.userIds.push(user.id);
    if (opts.instanceAdmin) {
      await this.db.instanceAdmin.create({ data: { userId: user.id, grantedBy: 'test' } });
    }
    return user;
  }

  /** Workspace with one host app (`portal`), `staging` + `production` envs and one module. */
  async workspace() {
    const suffix = randomUUID().slice(0, 8);
    const workspace = await this.db.workspace.create({
      data: { slug: `ws-${suffix}`, name: `Workspace ${suffix}` },
    });
    this.workspaceIds.push(workspace.id);

    const hostApp = await this.db.hostApp.create({
      data: {
        workspaceId: workspace.id,
        name: 'Portal',
        slug: 'portal',
        Environments: {
          create: [
            { name: 'Staging', slug: 'staging' },
            { name: 'Production', slug: 'production', isDefault: true },
          ],
        },
      },
      include: { Environments: true },
    });
    const module = await this.module(workspace.id, hostApp.id, 'checkout');

    return { workspace, hostApp, module };
  }

  async module(workspaceId: string, hostAppId: string, slug: string) {
    return this.db.remoteModule.create({
      data: { workspaceId, hostAppId, name: slug, slug },
    });
  }

  async member(workspaceId: string, userId: string, role: Role, opts: { joined?: boolean } = {}) {
    return this.db.workspaceMember.create({
      data: {
        workspaceId,
        userId,
        role,
        joinedAt: opts.joined === false ? null : new Date(),
      },
    });
  }

  /** Returns the raw key, as a CI system would hold it. */
  async apiKey(
    workspaceId: string,
    opts: {
      scopes?: string[];
      moduleIds?: string[];
      expiresAt?: Date;
      revokedAt?: Date;
      gracePeriodEnd?: Date;
    } = {}
  ) {
    const creator = await this.user();
    const { secret, keyHash } = await generateApiKeySecret();
    const record = await this.db.apiKey.create({
      data: {
        workspaceId,
        name: 'test key',
        keyHash,
        prefix: 'pending',
        scopes: opts.scopes ?? ['deploy:write'],
        moduleIds: opts.moduleIds ?? [],
        expiresAt: opts.expiresAt,
        revokedAt: opts.revokedAt,
        gracePeriodEnd: opts.gracePeriodEnd,
        createdBy: creator.id,
      },
    });
    await this.db.apiKey.update({
      where: { id: record.id },
      data: { prefix: displayPrefix(record.id) },
    });
    return { raw: formatApiKey(record.id, secret), record };
  }

  async session(user: { id: string; email: string }) {
    return signAccessToken({ userId: user.id, email: user.email }, this.app.config.jwtSecret);
  }

  async cleanup() {
    // Workspace deletion cascades to everything tenant-scoped.
    await this.db.workspace.deleteMany({ where: { id: { in: this.workspaceIds } } });
    await this.db.user.deleteMany({ where: { id: { in: this.userIds } } });
  }
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
