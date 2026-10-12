// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import type { ActionResult } from '@/lib/actionResult';
import { RegistryError, authedFetch } from '@/lib/registry';

// INST-07..10: every change goes through the registry's admin API, which checks the
// instance admin and records it (INST-18).

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

export async function suspendWorkspaceAction(
  slug: string,
  _prev: ActionResult,
  form: FormData
): Promise<ActionResult> {
  return run(
    () =>
      authedFetch(`/api/admin/workspaces/${enc(slug)}/suspend`, {
        body: { reason: field(form, 'reason') || undefined },
      }),
    (t) => ({ status: 'success', message: t('workspaceSuspended') })
  );
}

export async function unsuspendWorkspaceAction(slug: string, _prev: ActionResult) {
  return run(
    () => authedFetch(`/api/admin/workspaces/${enc(slug)}/unsuspend`, { method: 'POST' }),
    (t) => ({ status: 'success', message: t('workspaceUnsuspended') })
  );
}

/** TLC-02: undoes a deletion before the purge. */
export async function restoreWorkspaceAction(slug: string, _prev: ActionResult) {
  return run(
    () => authedFetch(`/api/admin/workspaces/${enc(slug)}/restore`, { method: 'POST' }),
    (t) => ({ status: 'success', message: t('workspaceRestored', { workspace: slug }) })
  );
}

/** TLC-04: every workspace of the organization becomes read-only. */
export async function suspendOrgAction(
  slug: string,
  _prev: ActionResult,
  form: FormData
): Promise<ActionResult> {
  const reason = field(form, 'reason');
  return run(
    () =>
      authedFetch(`/api/admin/orgs/${enc(slug)}/suspend`, {
        body: reason ? { reason } : {},
      }),
    (t) => ({ status: 'success', message: t('orgSuspended') })
  );
}

export async function unsuspendOrgAction(slug: string, _prev: ActionResult) {
  return run(
    () => authedFetch(`/api/admin/orgs/${enc(slug)}/unsuspend`, { method: 'POST' }),
    (t) => ({ status: 'success', message: t('orgUnsuspended') })
  );
}

/** TLC-02: an organization its admins deleted, back before the purge. */
export async function restoreOrgAction(slug: string, _prev: ActionResult) {
  return run(
    () => authedFetch(`/api/admin/orgs/${enc(slug)}/restore`, { method: 'POST' }),
    (t) => ({ status: 'success', message: t('orgRestored') })
  );
}

export async function deleteWorkspaceAction(
  slug: string,
  _prev: ActionResult,
  form: FormData
): Promise<ActionResult> {
  return run(
    () =>
      authedFetch(`/api/admin/workspaces/${enc(slug)}?confirm=${enc(field(form, 'confirm'))}`, {
        method: 'DELETE',
      }),
    (t) => ({ status: 'success', message: t('workspaceDeleted') })
  );
}

export async function revokeSessionsAction(userId: string, _prev: ActionResult) {
  return run(
    () => authedFetch(`/api/admin/users/${enc(userId)}/revoke-sessions`, { method: 'POST' }),
    (t, r) => ({
      status: 'success',
      message: t('sessionsRevoked', { count: (r as { revoked: number }).revoked }),
    })
  );
}

export async function deleteUserAction(
  userId: string,
  _prev: ActionResult,
  form: FormData
): Promise<ActionResult> {
  return run(
    () =>
      authedFetch(`/api/admin/users/${enc(userId)}?confirm=${enc(field(form, 'confirm'))}`, {
        method: 'DELETE',
      }),
    (t) => ({ status: 'success', message: t('userDeleted') })
  );
}

export async function grantAdminAction(_prev: ActionResult, form: FormData) {
  return run(
    () => authedFetch('/api/admin/admins', { body: { email: field(form, 'email') } }),
    (t) => ({ status: 'success', message: t('adminGranted') })
  );
}

export async function revokeAdminAction(userId: string, _prev: ActionResult) {
  return run(
    () => authedFetch(`/api/admin/admins/${enc(userId)}`, { method: 'DELETE' }),
    (t) => ({ status: 'success', message: t('adminRevoked') })
  );
}

// ─── Instance settings (INST-11..14) ─────────────────────────────────────────

type SettingKey = 'storage' | 'email' | 'auth' | 'branding' | 'tenancy';
const optional = (form: FormData, name: string) => field(form, name) || undefined;
const checked = (form: FormData, name: string) => form.get(name) === 'on';

/** The setting's body from its form; empty secrets keep the stored ones. */
function settingBody(key: SettingKey, form: FormData) {
  switch (key) {
    case 'storage': {
      const adapter = field(form, 'adapter');
      if (adapter === 's3') {
        return {
          adapter,
          bucket: field(form, 's3Bucket'),
          region: field(form, 's3Region'),
          endpoint: optional(form, 's3Endpoint'),
          accessKeyId: optional(form, 's3AccessKeyId'),
          secretAccessKey: optional(form, 's3SecretAccessKey'),
          publicUrl: optional(form, 's3PublicUrl'),
        };
      }
      if (adapter === 'gcs') {
        return {
          adapter,
          bucket: field(form, 'gcsBucket'),
          projectId: field(form, 'gcsProjectId'),
          clientEmail: field(form, 'gcsClientEmail'),
          privateKey: optional(form, 'gcsPrivateKey'),
          publicUrl: optional(form, 'gcsPublicUrl'),
        };
      }
      if (adapter === 'azure') {
        return {
          adapter,
          container: field(form, 'azureContainer'),
          connectionString: optional(form, 'azureConnectionString'),
          publicUrl: optional(form, 'azurePublicUrl'),
        };
      }
      return { adapter };
    }
    case 'email':
      return {
        host: field(form, 'host'),
        port: Number(field(form, 'port')),
        security: field(form, 'security'),
        username: optional(form, 'username'),
        password: optional(form, 'password'),
        from: field(form, 'from'),
      };
    case 'auth':
      return {
        email: { enabled: checked(form, 'email') },
        github: {
          enabled: checked(form, 'github'),
          clientId: optional(form, 'githubClientId'),
          clientSecret: optional(form, 'githubClientSecret'),
        },
        oidc: { enabled: checked(form, 'oidc') },
        saml: { enabled: checked(form, 'saml') },
      };
    case 'tenancy':
      return {
        creation: field(form, 'creation') || 'anyone',
        allowedDomains: field(form, 'allowedDomains')
          .split(/[\s,]+/)
          .map((d) => d.trim())
          .filter(Boolean),
      };
    case 'branding':
      return {
        name: field(form, 'name'),
        logoUrl: optional(form, 'logoUrl'),
        supportUrl: optional(form, 'supportUrl'),
        accentColor: optional(form, 'accentColor'),
      };
  }
}

export async function saveSettingAction(
  key: SettingKey,
  _prev: ActionResult,
  form: FormData
): Promise<ActionResult> {
  return run(
    () =>
      authedFetch<{ adminsLockedOut?: string[] }>(`/api/admin/settings/${key}`, {
        method: 'PUT',
        body: settingBody(key, form),
      }),
    (t, r) => {
      // INST-23: saved, but these admins have no sign-in method left.
      const lockedOut = (r as { adminsLockedOut?: string[] }).adminsLockedOut;
      return {
        status: 'success',
        message: lockedOut?.length
          ? t('settingSavedAdminsLockedOut', { admins: lockedOut.join(', ') })
          : t('settingSaved'),
      };
    }
  );
}

export async function resetSettingAction(key: SettingKey, _prev: ActionResult) {
  return run(
    () => authedFetch(`/api/admin/settings/${key}`, { method: 'DELETE' }),
    (t) => ({ status: 'success', message: t('settingReset') })
  );
}

export async function testStorageAction(_prev: ActionResult) {
  return run(
    () =>
      authedFetch<{ ok: boolean; latencyMs: number; error?: string }>(
        '/api/admin/settings/storage/test',
        { method: 'POST' }
      ),
    (t, r) => {
      const result = r as { ok: boolean; latencyMs: number; error?: string };
      return result.ok
        ? { status: 'success', message: t('storageOk', { ms: result.latencyMs }) }
        : { status: 'error', message: t('storageFailed', { error: result.error ?? '' }) };
    }
  );
}

export async function testEmailAction(_prev: ActionResult) {
  return run(
    () => authedFetch<{ sentTo: string }>('/api/admin/settings/email/test', { method: 'POST' }),
    (t, r) => ({
      status: 'success',
      message: t('testEmailSent', { to: (r as { sentTo: string }).sentTo }),
    })
  );
}

// ─── Plans (PLN-01) ──────────────────────────────────────────────────────────

export async function setPlanAction(
  target: { kind: 'workspace' | 'org'; slug: string },
  _prev: ActionResult,
  form: FormData
): Promise<ActionResult> {
  const path =
    target.kind === 'workspace'
      ? `/api/admin/workspaces/${enc(target.slug)}/plan`
      : `/api/admin/orgs/${enc(target.slug)}/plan`;
  return run(
    () => authedFetch(path, { method: 'PUT', body: { plan: field(form, 'plan') } }),
    (t) => ({ status: 'success', message: t('planSet') })
  );
}
