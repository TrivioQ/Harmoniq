// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { getTranslations } from 'next-intl/server';
import type { AuditEvent } from '@/lib/workspaceApi';

const KNOWN = [
  'module.deploy',
  'module.rollback',
  'module.promote',
  'module.create',
  'env.freeze',
  'env.unfreeze',
  'env.freeze_override',
  'env.freeze_override_end',
  'apiKey.create',
  'apiKey.revoke',
  'apiKey.rotate',
  'member.invite',
  'member.role_change',
  'member.remove',
  'webhook.create',
  'webhook.update',
  'webhook.delete',
  'workspace.create',
  'hostApp.create',
  'environment.create',
  'canary.start',
  'canary.update',
  'canary.promote',
  'canary.abort',
  'canary.rollout_advance',
  'canary.rollout_failed',
  'module.auto_rollback',
  'module.disable',
  'module.enable',
  'module.owners_update',
  'module.unauthorized_attempt',
  'schedule.create',
  'auth.sso_login',
  'sso.config_update',
  'sso.config_delete',
  'deploy.approval_requested',
  'deploy.approve',
  'deploy.reject',
  'deploy.emergency_bypass',
  'approval_policy.set',
  'approval_policy.delete',
  'schedule.cancel',
  'schedule.executed',
  'schedule.failed',
  'alert.create',
  'alert.update',
  'alert.delete',
] as const;

/** One human-readable audit line, e.g. "Deployed checkout 1.2.3 to staging". */
export async function AuditLine({ event }: { event: AuditEvent }) {
  const t = await getTranslations('Audit');
  const m = (event.metadata ?? {}) as Record<string, string | undefined>;
  const action = KNOWN.find((a) => a === event.action);
  const actor =
    event.actorType === 'system'
      ? t('systemActor')
      : event.actorType === 'apiKey'
        ? t('apiKeyActor')
        : t('userActor');

  return (
    <span>
      {action
        ? t(`actions.${action.replace('.', '_')}`, {
            module: m.module ?? '',
            version: m.version ?? m.toVersion ?? '',
            from: m.fromEnvironment ?? m.fromVersion ?? '',
            environment: m.environment ?? m.toEnvironment ?? '',
            name: m.name ?? m.slug ?? m.email ?? m.url ?? m.type ?? '',
            role: m.role ?? m.to ?? '',
            percent: m.trafficPercent ?? '',
            rule: m.ruleName ?? '',
            reason: m.reason ?? m.justification ?? m.comment ?? '',
          })
        : event.action}{' '}
      <span className="text-muted-foreground">· {actor}</span>
    </span>
  );
}
