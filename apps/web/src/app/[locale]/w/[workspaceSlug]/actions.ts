// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import type { ActionResult } from '@/lib/actionResult';
import { RegistryError, authedFetch } from '@/lib/registry';

// Every mutation goes through the registry, which authorizes, audits and applies it.
// Arguments bound by server components (slugs, ids) are not trusted for anything else.

const enc = encodeURIComponent;
const field = (form: FormData, name: string) => String(form.get(name) ?? '').trim();

async function run(
  call: () => Promise<unknown>,
  success: (t: Awaited<ReturnType<typeof getTranslations>>, result: unknown) => ActionResult
): Promise<ActionResult> {
  const t = await getTranslations('Actions');
  try {
    const result = await call();
    revalidatePath('/', 'layout');
    return success(t, result);
  } catch (err) {
    return {
      status: 'error',
      message: err instanceof RegistryError ? err.message : t('unexpectedError'),
    };
  }
}

// ─── Modules ────────────────────────────────────────────────────────────────

export async function rollbackAction(
  workspace: string,
  moduleRef: string,
  environment: string,
  versionId: string,
  _prev: ActionResult
): Promise<ActionResult> {
  return run(
    () =>
      authedFetch(`/api/workspaces/${enc(workspace)}/modules/${enc(moduleRef)}/rollback`, {
        body: { environment, versionId },
      }),
    (t, r) => ({
      status: 'success',
      message: t('rolledBack', { version: (r as { version: string }).version }),
    })
  );
}

export async function promoteAction(
  workspace: string,
  moduleRef: string,
  fromEnvironment: string,
  _prev: ActionResult,
  form: FormData
): Promise<ActionResult> {
  const toEnvironment = field(form, 'toEnvironment');
  return run(
    () =>
      authedFetch(`/api/workspaces/${enc(workspace)}/modules/${enc(moduleRef)}/promote`, {
        body: { fromEnvironment, toEnvironment },
      }),
    (t, r) => ({
      status: 'success',
      message: t('promoted', {
        version: (r as { version: string }).version,
        environment: toEnvironment,
      }),
    })
  );
}

// ─── Canary (CAN-04/05) ─────────────────────────────────────────────────────

const canaryPath = (workspace: string, moduleRef: string, action = '') =>
  `/api/workspaces/${enc(workspace)}/modules/${enc(moduleRef)}/canary${action}`;

/** Sets the running canary's traffic, or (with `versionId`) starts that version as the canary. */
export async function setCanaryAction(
  workspace: string,
  moduleRef: string,
  environment: string,
  versionId: string | null,
  _prev: ActionResult,
  form: FormData
): Promise<ActionResult> {
  const trafficPercent = Number(field(form, 'trafficPercent'));
  return run(
    () =>
      authedFetch(canaryPath(workspace, moduleRef), {
        method: 'PUT',
        body: { environment, trafficPercent, ...(versionId && { versionId }) },
      }),
    (t, r) => ({
      status: 'success',
      message: t('canaryTraffic', {
        version: (r as { version: string }).version,
        percent: trafficPercent,
      }),
    })
  );
}

export async function promoteCanaryAction(
  workspace: string,
  moduleRef: string,
  environment: string,
  _prev: ActionResult
): Promise<ActionResult> {
  return run(
    () => authedFetch(canaryPath(workspace, moduleRef, '/promote'), { body: { environment } }),
    (t, r) => ({
      status: 'success',
      message: t('canaryPromoted', { version: (r as { version: string }).version }),
    })
  );
}

export async function advanceCanaryAction(
  workspace: string,
  moduleRef: string,
  environment: string,
  _prev: ActionResult
): Promise<ActionResult> {
  return run(
    () => authedFetch(canaryPath(workspace, moduleRef, '/advance'), { body: { environment } }),
    (t, r) => {
      const v = r as { version: string; status: string; trafficPercent: number | null };
      return {
        status: 'success',
        message:
          v.status === 'active'
            ? t('canaryPromoted', { version: v.version })
            : t('canaryTraffic', { version: v.version, percent: v.trafficPercent ?? 0 }),
      };
    }
  );
}

export async function abortCanaryAction(
  workspace: string,
  moduleRef: string,
  environment: string,
  _prev: ActionResult
): Promise<ActionResult> {
  return run(
    () => authedFetch(canaryPath(workspace, moduleRef, '/abort'), { body: { environment } }),
    (t, r) => ({
      status: 'success',
      message: t('canaryAborted', { version: (r as { version: string }).version }),
    })
  );
}

export async function createModuleAction(workspace: string, _prev: ActionResult, form: FormData) {
  return run(
    () =>
      authedFetch(`/api/workspaces/${enc(workspace)}/modules`, {
        body: {
          hostApp: field(form, 'hostApp'),
          name: field(form, 'name'),
          slug: field(form, 'slug'),
          description: field(form, 'description') || undefined,
        },
      }),
    (t) => ({ status: 'success', message: t('moduleCreated') })
  );
}

// ─── Environments ───────────────────────────────────────────────────────────

export async function freezeAction(
  workspace: string,
  hostApp: string,
  environment: string,
  _prev: ActionResult,
  form: FormData
): Promise<ActionResult> {
  const from = field(form, 'from');
  const until = field(form, 'until');
  return run(
    () =>
      authedFetch(
        `/api/workspaces/${enc(workspace)}/host-apps/${enc(hostApp)}/environments/${enc(environment)}/freeze`,
        {
          method: 'PUT',
          body: {
            reason: field(form, 'reason'),
            ...(from && { from: new Date(from).toISOString() }),
            ...(until && { until: new Date(until).toISOString() }),
          },
        }
      ),
    (t) => ({ status: 'success', message: t('frozen', { environment }) })
  );
}

export async function unfreezeAction(
  workspace: string,
  hostApp: string,
  environment: string,
  _prev: ActionResult
): Promise<ActionResult> {
  return run(
    () =>
      authedFetch(
        `/api/workspaces/${enc(workspace)}/host-apps/${enc(hostApp)}/environments/${enc(environment)}/freeze`,
        { method: 'DELETE' }
      ),
    (t) => ({ status: 'success', message: t('unfrozen', { environment }) })
  );
}

// ─── Workspaces ─────────────────────────────────────────────────────────────

export async function createWorkspaceAction(
  _prev: ActionResult,
  form: FormData
): Promise<ActionResult> {
  return run(
    () =>
      authedFetch('/api/workspaces', {
        body: { name: field(form, 'name'), slug: field(form, 'slug') },
      }),
    (t) => ({ status: 'success', message: t('workspaceCreated') })
  );
}

// ─── API keys ───────────────────────────────────────────────────────────────

export async function createApiKeyAction(workspace: string, _prev: ActionResult, form: FormData) {
  const scopes = form.getAll('scopes').map(String);
  return run(
    () =>
      authedFetch<{ key: string }>(`/api/workspaces/${enc(workspace)}/api-keys`, {
        body: { name: field(form, 'name'), ...(scopes.length && { scopes }) },
      }),
    (t, r) => ({ status: 'success', message: t('keyCreated'), secret: (r as { key: string }).key })
  );
}

export async function revokeApiKeyAction(workspace: string, keyId: string, _prev: ActionResult) {
  return run(
    () =>
      authedFetch(`/api/workspaces/${enc(workspace)}/api-keys/${enc(keyId)}`, { method: 'DELETE' }),
    (t) => ({ status: 'success', message: t('keyRevoked') })
  );
}

export async function rotateApiKeyAction(workspace: string, keyId: string, _prev: ActionResult) {
  return run(
    () =>
      authedFetch<{ key: string }>(
        `/api/workspaces/${enc(workspace)}/api-keys/${enc(keyId)}/rotate`,
        {
          body: { gracePeriodHours: 24 },
        }
      ),
    (t, r) => ({ status: 'success', message: t('keyRotated'), secret: (r as { key: string }).key })
  );
}

// ─── Members ────────────────────────────────────────────────────────────────

export async function inviteMemberAction(workspace: string, _prev: ActionResult, form: FormData) {
  return run(
    () =>
      authedFetch(`/api/workspaces/${enc(workspace)}/members`, {
        body: { email: field(form, 'email'), role: field(form, 'role') },
      }),
    (t) => ({ status: 'success', message: t('memberInvited') })
  );
}

export async function changeRoleAction(
  workspace: string,
  memberId: string,
  _prev: ActionResult,
  form: FormData
) {
  return run(
    () =>
      authedFetch(`/api/workspaces/${enc(workspace)}/members/${enc(memberId)}`, {
        method: 'PATCH',
        body: { role: field(form, 'role') },
      }),
    (t) => ({ status: 'success', message: t('roleChanged') })
  );
}

export async function removeMemberAction(workspace: string, memberId: string, _prev: ActionResult) {
  return run(
    () =>
      authedFetch(`/api/workspaces/${enc(workspace)}/members/${enc(memberId)}`, {
        method: 'DELETE',
      }),
    (t) => ({ status: 'success', message: t('memberRemoved') })
  );
}

// ─── Webhooks ───────────────────────────────────────────────────────────────

export async function createWebhookAction(workspace: string, _prev: ActionResult, form: FormData) {
  const events = form.getAll('events').map(String);
  return run(
    () =>
      authedFetch<{ secret: string }>(`/api/workspaces/${enc(workspace)}/webhooks`, {
        body: { url: field(form, 'url'), events: events.length ? events : ['*'] },
      }),
    (t, r) => ({
      status: 'success',
      message: t('webhookCreated'),
      secret: (r as { secret: string }).secret,
    })
  );
}

export async function setWebhookPausedAction(
  workspace: string,
  endpointId: string,
  paused: boolean,
  _prev: ActionResult
) {
  return run(
    () =>
      authedFetch(`/api/workspaces/${enc(workspace)}/webhooks/${enc(endpointId)}`, {
        method: 'PATCH',
        body: { paused },
      }),
    (t) => ({ status: 'success', message: paused ? t('webhookPaused') : t('webhookResumed') })
  );
}

export async function deleteWebhookAction(
  workspace: string,
  endpointId: string,
  _prev: ActionResult
) {
  return run(
    () =>
      authedFetch(`/api/workspaces/${enc(workspace)}/webhooks/${enc(endpointId)}`, {
        method: 'DELETE',
      }),
    (t) => ({ status: 'success', message: t('webhookDeleted') })
  );
}

export async function retryDeadLetterAction(
  workspace: string,
  deadLetterId: string,
  _prev: ActionResult
) {
  return run(
    () =>
      authedFetch(
        `/api/workspaces/${enc(workspace)}/webhooks/dead-letters/${enc(deadLetterId)}/retry`,
        {
          body: {},
        }
      ),
    (t) => ({ status: 'success', message: t('deadLetterRetried') })
  );
}

// ─── Alerts (ALT-01) ────────────────────────────────────────────────────────

export async function createAlertAction(workspace: string, _prev: ActionResult, form: FormData) {
  const number = (name: string) => Number(field(form, name));
  const condition = field(form, 'condition');
  const workspaceWide = condition === 'webhook_failure_rate';
  const [module, environment] = field(form, 'target').split('|');
  return run(
    () =>
      authedFetch(`/api/workspaces/${enc(workspace)}/alerts`, {
        body: {
          name: field(form, 'name'),
          condition,
          threshold: number('threshold'),
          action: field(form, 'action'),
          ...(!workspaceWide && module && { module, environment }),
          windowMinutes: number('windowMinutes'),
          minSamples: number('minSamples'),
        },
      }),
    (t) => ({ status: 'success', message: t('alertCreated') })
  );
}

export async function setAlertEnabledAction(
  workspace: string,
  ruleId: string,
  enabled: boolean,
  _prev: ActionResult
) {
  return run(
    () =>
      authedFetch(`/api/workspaces/${enc(workspace)}/alerts/${enc(ruleId)}`, {
        method: 'PATCH',
        body: { enabled },
      }),
    (t) => ({ status: 'success', message: t(enabled ? 'alertEnabled' : 'alertDisabled') })
  );
}

export async function deleteAlertAction(workspace: string, ruleId: string, _prev: ActionResult) {
  return run(
    () =>
      authedFetch(`/api/workspaces/${enc(workspace)}/alerts/${enc(ruleId)}`, { method: 'DELETE' }),
    (t) => ({ status: 'success', message: t('alertDeleted') })
  );
}

// ─── Kill switch (M3.6) ─────────────────────────────────────────────────────

export async function setKillSwitchAction(
  workspace: string,
  moduleRef: string,
  environment: string,
  disabled: boolean,
  _prev: ActionResult,
  form?: FormData
): Promise<ActionResult> {
  const reason = form ? field(form, 'reason') : '';
  return run(
    () =>
      authedFetch(`/api/workspaces/${enc(workspace)}/modules/${enc(moduleRef)}/kill-switch`, {
        method: 'PUT',
        body: { environment, disabled, ...(disabled && { reason }) },
      }),
    (t) => ({ status: 'success', message: t(disabled ? 'moduleDisabled' : 'moduleEnabled') })
  );
}

// ─── Scheduled operations (M3.6) ────────────────────────────────────────────

export async function cancelScheduledAction(workspace: string, id: string, _prev: ActionResult) {
  return run(
    () =>
      authedFetch(`/api/workspaces/${enc(workspace)}/scheduled-operations/${enc(id)}`, {
        method: 'DELETE',
      }),
    (t) => ({ status: 'success', message: t('scheduleCancelled') })
  );
}

// ─── Module owners (RBAC-01) ────────────────────────────────────────────────

export async function setModuleOwnersAction(
  workspace: string,
  moduleRef: string,
  _prev: ActionResult,
  form: FormData
): Promise<ActionResult> {
  const memberIds = form.getAll('owner').map(String);
  return run(
    () =>
      authedFetch(`/api/workspaces/${enc(workspace)}/modules/${enc(moduleRef)}/owners`, {
        method: 'PUT',
        body: { memberIds },
      }),
    (t) => ({ status: 'success', message: t('ownersUpdated') })
  );
}

// ─── Freeze override (ENV-FRZ-03) ───────────────────────────────────────────

export async function freezeOverrideAction(
  workspace: string,
  hostApp: string,
  environment: string,
  open: boolean,
  _prev: ActionResult,
  form: FormData
): Promise<ActionResult> {
  return run(
    () =>
      authedFetch(
        `/api/workspaces/${enc(workspace)}/host-apps/${enc(hostApp)}/environments/${enc(environment)}/freeze/override`,
        open
          ? {
              body: {
                reason: field(form, 'reason'),
                minutes: Number(field(form, 'minutes') || 60),
              },
            }
          : { method: 'DELETE' }
      ),
    (t) => ({
      status: 'success',
      message: t(open ? 'freezeOverrideOpened' : 'freezeOverrideClosed', { environment }),
    })
  );
}

// ─── Approvals (APR-*) ──────────────────────────────────────────────────────

export async function decideApprovalAction(
  workspace: string,
  requestId: string,
  decision: 'approve' | 'reject',
  _prev: ActionResult,
  form: FormData
): Promise<ActionResult> {
  const comment = field(form, 'comment');
  return run(
    () =>
      authedFetch(`/api/workspaces/${enc(workspace)}/approvals/${enc(requestId)}/${decision}`, {
        body: comment ? { comment } : {},
      }),
    (t, r) => ({
      status: 'success',
      message: t(
        decision === 'reject'
          ? 'approvalRejected'
          : (r as { status: string }).status === 'executed'
            ? 'approvalExecuted'
            : 'approvalRecorded'
      ),
    })
  );
}

export async function bypassApprovalAction(
  workspace: string,
  requestId: string,
  _prev: ActionResult,
  form: FormData
): Promise<ActionResult> {
  return run(
    () =>
      authedFetch(`/api/workspaces/${enc(workspace)}/approvals/${enc(requestId)}/bypass`, {
        body: { bypassJustification: field(form, 'justification') },
      }),
    (t) => ({ status: 'success', message: t('approvalBypassed') })
  );
}

export async function setApprovalPolicyAction(
  workspace: string,
  hostApp: string,
  environment: string,
  _prev: ActionResult,
  form: FormData
): Promise<ActionResult> {
  const pattern = field(form, 'ticketUrlPattern');
  return run(
    () =>
      authedFetch(
        `/api/workspaces/${enc(workspace)}/host-apps/${enc(hostApp)}/environments/${enc(environment)}/approval-policy`,
        {
          method: 'PUT',
          body: {
            requiredApprovers: Number(field(form, 'requiredApprovers') || 1),
            eligibleRoles: form.getAll('eligibleRoles').map(String),
            requireChangeTicket: form.get('requireChangeTicket') === 'on',
            ...(pattern && { ticketUrlPattern: pattern }),
            expiryHours: Number(field(form, 'expiryHours') || 24),
          },
        }
      ),
    (t) => ({ status: 'success', message: t('approvalPolicySaved', { environment }) })
  );
}

export async function deleteApprovalPolicyAction(
  workspace: string,
  hostApp: string,
  environment: string,
  _prev: ActionResult
): Promise<ActionResult> {
  return run(
    () =>
      authedFetch(
        `/api/workspaces/${enc(workspace)}/host-apps/${enc(hostApp)}/environments/${enc(environment)}/approval-policy`,
        { method: 'DELETE' }
      ),
    (t) => ({ status: 'success', message: t('approvalPolicyRemoved', { environment }) })
  );
}

// ─── Organizations (ORG-10) ─────────────────────────────────────────────────

export async function setModuleSharedAction(
  workspace: string,
  moduleRef: string,
  shared: boolean,
  _prev: ActionResult
) {
  return run(
    () =>
      authedFetch(`/api/workspaces/${enc(workspace)}/modules/${enc(moduleRef)}/shared`, {
        method: 'PUT',
        body: { shared },
      }),
    (t) => ({ status: 'success', message: shared ? t('moduleShared') : t('moduleUnshared') })
  );
}
