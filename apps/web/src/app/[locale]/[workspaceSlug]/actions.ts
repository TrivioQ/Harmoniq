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
  const until = field(form, 'until');
  return run(
    () =>
      authedFetch(
        `/api/workspaces/${enc(workspace)}/host-apps/${enc(hostApp)}/environments/${enc(environment)}/freeze`,
        {
          method: 'PUT',
          body: {
            reason: field(form, 'reason'),
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
