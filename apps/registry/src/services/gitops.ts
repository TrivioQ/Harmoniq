// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from 'crypto';
import type { Prisma } from '@prisma/client';
import type { TenantTx } from '@harmoniq/db';
import { BadRequestError, ValidationError } from '@harmoniq/core/dist/errors/AppError';
import type { GitOpsChange, GitOpsConfig } from '@harmoniq/core/dist/schemas/GitOpsConfigSchema';
import { openSecret, sealSecret } from './crypto';
import { approvalDefaultFor, orgPolicyFor, weakerThan } from './policy';

/*
 * IaC-09..12: reconciles a workspace with its `harmoniq.yaml`. Declared resources are
 * created or updated; optional fields that are left out stay as they are, `null` clears
 * them. With `prune`, resources the file doesn't declare are deleted, but only in the
 * sections the file has, and never environments, modules or host apps that still serve
 * versions (those are reported as blocked).
 */

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const title = (slug: string) => slug.charAt(0).toUpperCase() + slug.slice(1).replace(/-/g, ' ');
const sorted = (values: string[]) => [...values].sort();
const json = (value: unknown) =>
  value === null || value === undefined
    ? (null as unknown as Prisma.InputJsonValue)
    : (value as Prisma.InputJsonValue);
const LIVE = { status: { in: ['active' as const, 'canary' as const] }, deletedAt: null };

export interface GitOpsOutcome {
  changes: GitOpsChange[];
  /** Webhook signing secrets the registry generated (shown once), by URL. */
  secrets: Record<string, string>;
  /** Host apps whose manifests or import maps may have changed. */
  touchedHostApps: string[];
  /** Freeze changes, for `env.frozen` / `env.unfrozen` webhooks. */
  freezes: Array<{ hostApp: string; environment: string; frozen: boolean; reason?: string }>;
}

export async function reconcile(
  tx: TenantTx,
  ctx: {
    workspaceId: string;
    workspaceSlug: string;
    actorId: string;
    encryptionKey: Buffer;
    dryRun: boolean;
    prune: boolean;
  },
  config: GitOpsConfig
): Promise<GitOpsOutcome> {
  if (config.workspace && config.workspace !== ctx.workspaceSlug) {
    throw new BadRequestError(
      `This file is for workspace "${config.workspace}", not "${ctx.workspaceSlug}"`
    );
  }
  const { workspaceId } = ctx;

  const hostApps = await tx.hostApp.findMany({
    where: { workspaceId },
    include: {
      Environments: true,
      RemoteModules: {
        include: {
          ModuleOwnerships: {
            include: { workspaceMember: { include: { user: { select: { email: true } } } } },
          },
        },
      },
    },
  });
  const [policies, webhooks, rules, members, liveByEnv, liveByModule] = await Promise.all([
    tx.approvalPolicy.findMany({ where: { workspaceId } }),
    tx.webhookEndpoint.findMany({ where: { workspaceId } }),
    tx.alertRule.findMany({ where: { workspaceId } }),
    tx.workspaceMember.findMany({
      where: { workspaceId, joinedAt: { not: null } },
      include: { user: { select: { email: true } } },
    }),
    tx.moduleVersion.groupBy({
      by: ['environmentId'],
      where: { workspaceId, ...LIVE },
      _count: true,
    }),
    tx.moduleVersion.groupBy({
      by: ['remoteModuleId'],
      where: { workspaceId, ...LIVE },
      _count: true,
    }),
  ]);
  const liveEnvs = new Set(liveByEnv.map((g) => g.environmentId));
  const liveModules = new Set(liveByModule.map((g) => g.remoteModuleId));
  const memberByEmail = new Map(members.map((m) => [m.user.email.toLowerCase(), m]));

  // Ids by key; filled in as resources are created while applying.
  const hostIds = new Map<string, string>(hostApps.map((h) => [h.slug, h.id]));
  const envIds = new Map<string, string>(
    hostApps.flatMap((h) => h.Environments.map((e) => [`${h.slug}/${e.slug}`, e.id] as const))
  );
  const moduleIds = new Map<string, string>(
    hostApps.flatMap((h) => h.RemoteModules.map((m) => [`${h.slug}/${m.slug}`, m.id] as const))
  );

  // ─── References (checked before anything changes) ────────────────────────
  const problems: string[] = [];
  const declaredModules = new Set([
    ...moduleIds.keys(),
    ...(config.hostApps ?? []).flatMap((h) => (h.modules ?? []).map((m) => `${h.slug}/${m.slug}`)),
  ]);
  const declaredEnvs = new Set([
    ...envIds.keys(),
    ...(config.hostApps ?? []).flatMap((h) =>
      (h.environments ?? []).map((e) => `${h.slug}/${e.slug}`)
    ),
  ]);
  for (const h of config.hostApps ?? []) {
    for (const m of h.modules ?? []) {
      for (const email of m.owners ?? []) {
        if (!memberByEmail.has(email.toLowerCase())) {
          problems.push(`${h.slug}/${m.slug}: owner ${email} is not a member of the workspace`);
        }
      }
    }
  }
  /** `module` or `hostApp/module` → `hostApp/module`. */
  const moduleKey = (ref: string) => {
    if (ref.includes('/')) return declaredModules.has(ref) ? ref : null;
    const matches = [...declaredModules].filter((k) => k.endsWith(`/${ref}`));
    return matches.length === 1 ? matches[0] : null;
  };
  for (const r of config.alertRules ?? []) {
    if (!r.module) continue;
    const key = moduleKey(r.module);
    if (!key) {
      problems.push(`alert rule "${r.name}": module ${r.module} not found (or ambiguous)`);
    } else if (r.environment && !declaredEnvs.has(`${key.split('/')[0]}/${r.environment}`)) {
      problems.push(
        `alert rule "${r.name}": no environment ${r.environment} in ${key.split('/')[0]}`
      );
    }
  }
  // POL-02: approval policies weaker than the organization's defaults, shown by the plan.
  const { organizationId } = await tx.workspace.findUniqueOrThrow({
    where: { id: workspaceId },
    select: { organizationId: true },
  });
  const orgPolicy = await orgPolicyFor(tx, organizationId);
  for (const h of config.hostApps ?? []) {
    for (const e of h.environments ?? []) {
      const floor = approvalDefaultFor(orgPolicy, e.slug);
      if (!floor || e.approvalPolicy === undefined) continue;
      const reasons = e.approvalPolicy
        ? weakerThan({ ...e.approvalPolicy, ticketUrlPattern: null }, floor)
        : [];
      for (const reason of reasons) {
        problems.push(`${h.slug}/${e.slug}: approval policy ${reason} (organization policy)`);
      }
    }
  }
  if (problems.length) throw new ValidationError('The configuration has problems', { problems });

  // ─── Plan ──────────────────────────────────────────────────────────────
  const ops: Array<{ change: GitOpsChange; run?: () => Promise<unknown> }> = [];
  const deletes: typeof ops = [];
  const outcome: GitOpsOutcome = { changes: [], secrets: {}, touchedHostApps: [], freezes: [] };
  const touch = (hostApp: string) => {
    if (!outcome.touchedHostApps.includes(hostApp)) outcome.touchedHostApps.push(hostApp);
  };
  /** The fields whose declared value differs from the current one. */
  const diff = (pairs: Array<[string, unknown, unknown]>) =>
    pairs
      .filter(([, desired, current]) => desired !== undefined && !same(desired, current))
      .map(([f]) => f);

  for (const h of config.hostApps ?? []) {
    const cur = hostApps.find((x) => x.slug === h.slug);
    const fields = {
      ...(h.name !== undefined && { name: h.name }),
      ...(h.description !== undefined && { description: h.description }),
      ...(h.default !== undefined && { isDefault: h.default }),
      ...(h.previewUrlTemplate !== undefined && { previewUrlTemplate: h.previewUrlTemplate }),
      ...(h.sharedDependencies !== undefined && { sharedDependencies: json(h.sharedDependencies) }),
      ...(h.strictExposes !== undefined && { strictExposes: h.strictExposes }),
    };
    const clearOtherDefaults = async (id: string) => {
      if (h.default) {
        await tx.hostApp.updateMany({
          where: { workspaceId, id: { not: id }, isDefault: true },
          data: { isDefault: false },
        });
      }
    };
    if (!cur) {
      ops.push({
        change: { action: 'create', type: 'hostApp', key: h.slug },
        run: async () => {
          const created = await tx.hostApp.create({
            data: { workspaceId, slug: h.slug, name: h.name ?? title(h.slug), ...fields },
          });
          hostIds.set(h.slug, created.id);
          await clearOtherDefaults(created.id);
        },
      });
    } else {
      const changed = diff([
        ['name', h.name, cur.name],
        ['description', h.description, cur.description],
        ['default', h.default, cur.isDefault],
        ['previewUrlTemplate', h.previewUrlTemplate, cur.previewUrlTemplate],
        ['sharedDependencies', h.sharedDependencies, cur.sharedDependencies],
        ['strictExposes', h.strictExposes, cur.strictExposes],
      ]);
      if (changed.length) {
        ops.push({
          change: { action: 'update', type: 'hostApp', key: h.slug, fields: changed },
          run: async () => {
            await tx.hostApp.update({ where: { id: cur.id }, data: fields });
            await clearOtherDefaults(cur.id);
          },
        });
      }
    }

    // Environments.
    if (h.environments) {
      for (const e of h.environments) {
        const key = `${h.slug}/${e.slug}`;
        const curE = cur?.Environments.find((x) => x.slug === e.slug);
        const clearOtherDefaults = async (id: string) => {
          if (e.default) {
            await tx.environment.updateMany({
              where: { hostAppId: hostIds.get(h.slug)!, id: { not: id }, isDefault: true },
              data: { isDefault: false },
            });
          }
        };
        if (!curE) {
          ops.push({
            change: { action: 'create', type: 'environment', key },
            run: async () => {
              const created = await tx.environment.create({
                data: {
                  hostAppId: hostIds.get(h.slug)!,
                  slug: e.slug,
                  name: e.name ?? title(e.slug),
                  isDefault: e.default ?? false,
                },
              });
              envIds.set(key, created.id);
              await clearOtherDefaults(created.id);
            },
          });
        } else {
          const changed = diff([
            ['name', e.name, curE.name],
            ['default', e.default, curE.isDefault],
          ]);
          if (changed.length) {
            ops.push({
              change: { action: 'update', type: 'environment', key, fields: changed },
              run: async () => {
                await tx.environment.update({
                  where: { id: curE.id },
                  data: {
                    ...(e.name !== undefined && { name: e.name }),
                    ...(e.default !== undefined && { isDefault: e.default }),
                  },
                });
                await clearOtherDefaults(curE.id);
              },
            });
          }
        }

        // Approval policy (APR-01).
        if (e.approvalPolicy !== undefined) {
          const curP = curE && policies.find((p) => p.environmentId === curE.id);
          const want = e.approvalPolicy;
          const data = want && {
            requiredApprovers: want.requiredApprovers,
            eligibleRoles: want.eligibleRoles,
            requireChangeTicket: want.requireChangeTicket,
            ticketUrlPattern: want.ticketUrlPattern ?? null,
            expiryHours: want.expiryHours,
          };
          if (!data && curP) {
            ops.push({
              change: { action: 'delete', type: 'approvalPolicy', key },
              run: () => tx.approvalPolicy.delete({ where: { id: curP.id } }),
            });
          } else if (data && !curP) {
            ops.push({
              change: { action: 'create', type: 'approvalPolicy', key },
              run: () =>
                tx.approvalPolicy.create({
                  data: { workspaceId, environmentId: envIds.get(key)!, ...data },
                }),
            });
          } else if (data && curP) {
            const changed = (Object.keys(data) as Array<keyof typeof data>).filter((f) =>
              f === 'eligibleRoles'
                ? !same(sorted(data[f]), sorted(curP[f]))
                : !same(data[f], curP[f])
            );
            if (changed.length) {
              ops.push({
                change: { action: 'update', type: 'approvalPolicy', key, fields: changed },
                run: () => tx.approvalPolicy.update({ where: { id: curP.id }, data }),
              });
            }
          }
        }

        // Freeze (ENV-FRZ-01/04).
        if (e.freeze !== undefined) {
          const frozen = !!curE?.frozenAt;
          const want = e.freeze;
          if (!want && frozen) {
            ops.push({
              change: { action: 'delete', type: 'freeze', key },
              run: async () => {
                await tx.environment.update({
                  where: { id: curE!.id },
                  data: {
                    frozenAt: null,
                    frozenBy: null,
                    freezeReason: null,
                    freezeFrom: null,
                    freezeUntil: null,
                    freezeOverrideUntil: null,
                    freezeOverrideReason: null,
                    freezeOverrideBy: null,
                  },
                });
                outcome.freezes.push({ hostApp: h.slug, environment: e.slug, frozen: false });
              },
            });
          } else if (want) {
            const changed = frozen
              ? diff([
                  ['reason', want.reason, curE!.freezeReason],
                  [
                    'from',
                    want.from?.toISOString() ?? null,
                    curE!.freezeFrom?.toISOString() ?? null,
                  ],
                  [
                    'until',
                    want.until?.toISOString() ?? null,
                    curE!.freezeUntil?.toISOString() ?? null,
                  ],
                ])
              : [];
            if (!frozen || changed.length) {
              ops.push({
                change: {
                  action: frozen ? 'update' : 'create',
                  type: 'freeze',
                  key,
                  ...(frozen && { fields: changed }),
                },
                run: async () => {
                  await tx.environment.update({
                    where: { id: envIds.get(key)! },
                    data: {
                      frozenAt: curE?.frozenAt ?? new Date(),
                      frozenBy: ctx.actorId,
                      freezeReason: want.reason,
                      freezeFrom: want.from ?? null,
                      freezeUntil: want.until ?? null,
                    },
                  });
                  outcome.freezes.push({
                    hostApp: h.slug,
                    environment: e.slug,
                    frozen: true,
                    reason: want.reason,
                  });
                },
              });
            }
          }
        }
      }
      if (ctx.prune && cur) {
        for (const curE of cur.Environments) {
          if (curE.ephemeral || h.environments.some((e) => e.slug === curE.slug)) continue;
          deletes.push({
            change: {
              action: 'delete',
              type: 'environment',
              key: `${h.slug}/${curE.slug}`,
              ...(liveEnvs.has(curE.id) && { blocked: 'it still serves module versions' }),
            },
            run: () => tx.environment.delete({ where: { id: curE.id } }),
          });
        }
      }
    }

    // Modules and their owners.
    if (h.modules) {
      for (const m of h.modules) {
        const key = `${h.slug}/${m.slug}`;
        const curM = cur?.RemoteModules.find((x) => x.slug === m.slug);
        const fields = {
          ...(m.name !== undefined && { name: m.name }),
          ...(m.description !== undefined && { description: m.description }),
          ...(m.specifier !== undefined && { specifier: m.specifier }),
        };
        if (!curM) {
          ops.push({
            change: { action: 'create', type: 'module', key },
            run: async () => {
              const created = await tx.remoteModule.create({
                data: {
                  workspaceId,
                  hostAppId: hostIds.get(h.slug)!,
                  slug: m.slug,
                  name: m.name ?? m.slug,
                  ...fields,
                },
              });
              moduleIds.set(key, created.id);
            },
          });
        } else {
          const changed = diff([
            ['name', m.name, curM.name],
            ['description', m.description, curM.description],
            ['specifier', m.specifier, curM.specifier],
          ]);
          if (changed.length) {
            ops.push({
              change: { action: 'update', type: 'module', key, fields: changed },
              run: async () => {
                await tx.remoteModule.update({ where: { id: curM.id }, data: fields });
                if (changed.includes('specifier')) touch(h.slug);
              },
            });
          }
        }
        if (m.owners !== undefined) {
          const want = sorted(m.owners.map((e) => e.toLowerCase()));
          const have = sorted(
            curM?.ModuleOwnerships.map((o) => o.workspaceMember.user.email.toLowerCase()) ?? []
          );
          if (!same(want, have) && (curM || want.length)) {
            ops.push({
              change: { action: curM ? 'update' : 'create', type: 'moduleOwners', key },
              run: async () => {
                const id = moduleIds.get(key)!;
                await tx.moduleOwnership.deleteMany({ where: { remoteModuleId: id } });
                await tx.moduleOwnership.createMany({
                  data: want.map((email) => ({
                    workspaceId,
                    remoteModuleId: id,
                    workspaceMemberId: memberByEmail.get(email)!.id,
                  })),
                });
              },
            });
          }
        }
      }
      if (ctx.prune && cur) {
        for (const curM of cur.RemoteModules) {
          if (h.modules.some((m) => m.slug === curM.slug)) continue;
          deletes.push({
            change: {
              action: 'delete',
              type: 'module',
              key: `${h.slug}/${curM.slug}`,
              ...(liveModules.has(curM.id) && { blocked: 'it still serves module versions' }),
            },
            run: () => tx.remoteModule.delete({ where: { id: curM.id } }),
          });
        }
      }
    }
  }
  if (ctx.prune && config.hostApps) {
    for (const cur of hostApps) {
      if (config.hostApps.some((h) => h.slug === cur.slug)) continue;
      const live = cur.Environments.some((e) => liveEnvs.has(e.id));
      deletes.push({
        change: {
          action: 'delete',
          type: 'hostApp',
          key: cur.slug,
          ...(live && { blocked: 'it still serves module versions' }),
        },
        run: () => tx.hostApp.delete({ where: { id: cur.id } }),
      });
    }
  }

  // Webhooks (by URL).
  if (config.webhooks) {
    for (const w of config.webhooks) {
      const cur = webhooks.find((x) => x.url === w.url);
      if (!cur) {
        ops.push({
          change: { action: 'create', type: 'webhook', key: w.url },
          run: async () => {
            const secret = w.secret ?? `whsec_${randomBytes(32).toString('base64url')}`;
            if (!w.secret) outcome.secrets[w.url] = secret;
            await tx.webhookEndpoint.create({
              data: {
                workspaceId,
                url: w.url,
                events: w.events,
                active: w.active ?? true,
                secret: sealSecret(secret, ctx.encryptionKey),
              },
            });
          },
        });
      } else {
        const changed = diff([
          ['events', sorted(w.events), sorted(cur.events)],
          ['active', w.active, cur.active],
        ]);
        let secretChanged = false;
        if (w.secret !== undefined) {
          try {
            secretChanged = openSecret(cur.secret, ctx.encryptionKey) !== w.secret;
          } catch {
            secretChanged = true;
          }
        }
        if (secretChanged) changed.push('secret');
        if (changed.length) {
          ops.push({
            change: { action: 'update', type: 'webhook', key: w.url, fields: changed },
            run: () =>
              tx.webhookEndpoint.update({
                where: { id: cur.id },
                data: {
                  events: w.events,
                  ...(w.active !== undefined && { active: w.active }),
                  ...(secretChanged && { secret: sealSecret(w.secret!, ctx.encryptionKey) }),
                },
              }),
          });
        }
      }
    }
    if (ctx.prune) {
      for (const cur of webhooks) {
        if (config.webhooks.some((w) => w.url === cur.url)) continue;
        deletes.unshift({
          change: { action: 'delete', type: 'webhook', key: cur.url },
          run: () => tx.webhookEndpoint.delete({ where: { id: cur.id } }),
        });
      }
    }
  }

  // Alert rules (by name).
  if (config.alertRules) {
    const refs = (r: (typeof config.alertRules)[number]) => {
      const mKey = r.module ? moduleKey(r.module)! : null;
      return {
        moduleKey: mKey,
        envKey: mKey && r.environment ? `${mKey.split('/')[0]}/${r.environment}` : null,
      };
    };
    for (const r of config.alertRules) {
      const cur = rules.find((x) => x.name === r.name);
      const { moduleKey: mKey, envKey } = refs(r);
      const settings = {
        ...(r.windowMinutes !== undefined && { windowMinutes: r.windowMinutes }),
        ...(r.minSamples !== undefined && { minSamples: r.minSamples }),
        ...(r.cooldownMinutes !== undefined && { cooldownMinutes: r.cooldownMinutes }),
        ...(r.enabled !== undefined && { enabled: r.enabled }),
      };
      if (!cur) {
        ops.push({
          change: { action: 'create', type: 'alertRule', key: r.name },
          run: () =>
            tx.alertRule.create({
              data: {
                workspaceId,
                name: r.name,
                condition: r.condition,
                threshold: r.threshold,
                action: r.action,
                actionConfig: {},
                remoteModuleId: mKey ? moduleIds.get(mKey)! : null,
                environmentId: envKey ? envIds.get(envKey)! : null,
                ...settings,
              },
            }),
        });
      } else {
        const curModule = [...moduleIds].find(([, id]) => id === cur.remoteModuleId)?.[0] ?? null;
        const curEnv = [...envIds].find(([, id]) => id === cur.environmentId)?.[0] ?? null;
        const changed = diff([
          ['condition', r.condition, cur.condition],
          ['threshold', r.threshold, cur.threshold],
          ['action', r.action, cur.action],
          ['module', mKey, curModule],
          ['environment', envKey, curEnv],
          ['windowMinutes', r.windowMinutes, cur.windowMinutes],
          ['minSamples', r.minSamples, cur.minSamples],
          ['cooldownMinutes', r.cooldownMinutes, cur.cooldownMinutes],
          ['enabled', r.enabled, cur.enabled],
        ]);
        if (changed.length) {
          ops.push({
            change: { action: 'update', type: 'alertRule', key: r.name, fields: changed },
            run: () =>
              tx.alertRule.update({
                where: { id: cur.id },
                data: {
                  condition: r.condition,
                  threshold: r.threshold,
                  action: r.action,
                  remoteModuleId: mKey ? moduleIds.get(mKey)! : null,
                  environmentId: envKey ? envIds.get(envKey)! : null,
                  ...settings,
                },
              }),
          });
        }
      }
    }
    if (ctx.prune) {
      for (const cur of rules) {
        if (config.alertRules.some((r) => r.name === cur.name)) continue;
        deletes.unshift({
          change: { action: 'delete', type: 'alertRule', key: cur.name },
          run: () => tx.alertRule.delete({ where: { id: cur.id } }),
        });
      }
    }
  }

  // ─── Apply ───────────────────────────────────────────────────────────────
  for (const op of [...ops, ...deletes]) {
    outcome.changes.push(op.change);
    if (ctx.dryRun || op.change.blocked || !op.run) continue;
    await op.run();
    if (['hostApp', 'environment', 'module'].includes(op.change.type)) {
      touch(op.change.key.split('/')[0]);
    }
  }
  return outcome;
}

/** IaC-12: the workspace as a `harmoniq.yaml` (without webhook secrets). */
export async function exportConfig(
  tx: TenantTx,
  workspace: { id: string; slug: string }
): Promise<GitOpsConfig> {
  const workspaceId = workspace.id;
  const [hostApps, policies, webhooks, rules] = await Promise.all([
    tx.hostApp.findMany({
      where: { workspaceId },
      orderBy: { slug: 'asc' },
      include: {
        Environments: { where: { ephemeral: false }, orderBy: { slug: 'asc' } },
        RemoteModules: {
          orderBy: { slug: 'asc' },
          include: {
            ModuleOwnerships: {
              include: { workspaceMember: { include: { user: { select: { email: true } } } } },
            },
          },
        },
      },
    }),
    tx.approvalPolicy.findMany({ where: { workspaceId } }),
    tx.webhookEndpoint.findMany({ where: { workspaceId }, orderBy: { url: 'asc' } }),
    tx.alertRule.findMany({ where: { workspaceId }, orderBy: { name: 'asc' } }),
  ]);
  const moduleKeys = new Map<string, string>(
    hostApps.flatMap((h) => h.RemoteModules.map((m) => [m.id, `${h.slug}/${m.slug}`] as const))
  );
  const envSlugs = new Map<string, string>(
    hostApps.flatMap((h) => h.Environments.map((e) => [e.id, e.slug] as const))
  );

  return {
    version: 1,
    workspace: workspace.slug,
    hostApps: hostApps.map((h) => ({
      slug: h.slug,
      name: h.name,
      description: h.description,
      default: h.isDefault,
      previewUrlTemplate: h.previewUrlTemplate,
      sharedDependencies: (h.sharedDependencies as Record<string, string> | null) ?? null,
      strictExposes: h.strictExposes,
      environments: h.Environments.map((e) => {
        const p = policies.find((x) => x.environmentId === e.id);
        return {
          slug: e.slug,
          name: e.name,
          default: e.isDefault,
          ...(p && {
            approvalPolicy: {
              requiredApprovers: p.requiredApprovers,
              eligibleRoles: p.eligibleRoles as ('developer' | 'admin' | 'owner')[],
              requireChangeTicket: p.requireChangeTicket,
              ...(p.ticketUrlPattern && { ticketUrlPattern: p.ticketUrlPattern }),
              expiryHours: p.expiryHours,
            },
          }),
          ...(e.frozenAt &&
            e.freezeReason && {
              freeze: {
                reason: e.freezeReason,
                ...(e.freezeFrom && { from: e.freezeFrom }),
                ...(e.freezeUntil && { until: e.freezeUntil }),
              },
            }),
        };
      }),
      modules: h.RemoteModules.map((m) => ({
        slug: m.slug,
        name: m.name,
        description: m.description,
        specifier: m.specifier,
        owners: sorted(m.ModuleOwnerships.map((o) => o.workspaceMember.user.email)),
      })),
    })),
    webhooks: webhooks.map((w) => ({
      url: w.url,
      events: w.events as NonNullable<GitOpsConfig['webhooks']>[number]['events'],
      active: w.active,
    })),
    alertRules: rules.map((r) => {
      const mKey = r.remoteModuleId ? moduleKeys.get(r.remoteModuleId) : undefined;
      return {
        name: r.name,
        condition: r.condition as NonNullable<GitOpsConfig['alertRules']>[number]['condition'],
        threshold: r.threshold,
        action: r.action as NonNullable<GitOpsConfig['alertRules']>[number]['action'],
        ...(mKey && { module: mKey }),
        ...(r.environmentId &&
          envSlugs.has(r.environmentId) && {
            environment: envSlugs.get(r.environmentId)!,
          }),
        windowMinutes: r.windowMinutes,
        minSamples: r.minSamples,
        cooldownMinutes: r.cooldownMinutes,
        enabled: r.enabled,
      };
    }),
  };
}
