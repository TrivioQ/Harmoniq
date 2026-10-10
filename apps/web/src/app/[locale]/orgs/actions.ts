// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import type { ActionResult } from '@/lib/actionResult';
import { RegistryError, authedFetch } from '@/lib/registry';

// ORG-01..15. Every change goes through the registry, which authorizes and audits it.

const enc = encodeURIComponent;
const field = (form: FormData, name: string) => String(form.get(name) ?? '').trim();
const org = (slug: string, rest = '') => `/api/orgs/${enc(slug)}${rest}`;

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

export async function createOrgAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  return run(
    () =>
      authedFetch('/api/orgs', { body: { name: field(form, 'name'), slug: field(form, 'slug') } }),
    (t) => ({ status: 'success', message: t('orgCreated') })
  );
}

export async function createOrgWorkspaceAction(
  orgSlug: string,
  _prev: ActionResult,
  form: FormData
): Promise<ActionResult> {
  return run(
    () =>
      authedFetch(org(orgSlug, '/workspaces'), {
        body: { name: field(form, 'name'), slug: field(form, 'slug') },
      }),
    (t) => ({ status: 'success', message: t('workspaceCreated') })
  );
}

export async function attachWorkspaceAction(
  orgSlug: string,
  _prev: ActionResult,
  form: FormData
): Promise<ActionResult> {
  return run(
    () =>
      authedFetch(org(orgSlug, `/workspaces/${enc(field(form, 'workspace'))}/attach`), {
        method: 'POST',
      }),
    (t) => ({ status: 'success', message: t('workspaceAttached') })
  );
}

export async function detachWorkspaceAction(
  orgSlug: string,
  workspace: string,
  _prev: ActionResult
) {
  return run(
    () => authedFetch(org(orgSlug, `/workspaces/${enc(workspace)}`), { method: 'DELETE' }),
    (t) => ({ status: 'success', message: t('workspaceDetached') })
  );
}

export async function addOrgMemberAction(
  orgSlug: string,
  _prev: ActionResult,
  form: FormData
): Promise<ActionResult> {
  return run(
    () =>
      authedFetch(org(orgSlug, '/members'), {
        body: { email: field(form, 'email'), role: field(form, 'role') || 'org_member' },
      }),
    (t) => ({ status: 'success', message: t('memberInvited') })
  );
}

export async function changeOrgMemberRoleAction(
  orgSlug: string,
  memberId: string,
  _prev: ActionResult,
  form: FormData
): Promise<ActionResult> {
  return run(
    () =>
      authedFetch(org(orgSlug, `/members/${enc(memberId)}`), {
        method: 'PATCH',
        body: { role: field(form, 'role') },
      }),
    (t) => ({ status: 'success', message: t('roleChanged') })
  );
}

export async function removeOrgMemberAction(
  orgSlug: string,
  memberId: string,
  _prev: ActionResult
) {
  return run(
    () => authedFetch(org(orgSlug, `/members/${enc(memberId)}`), { method: 'DELETE' }),
    (t) => ({ status: 'success', message: t('memberRemoved') })
  );
}

export async function createOrgKeyAction(
  orgSlug: string,
  _prev: ActionResult,
  form: FormData
): Promise<ActionResult> {
  const workspaces = field(form, 'workspaces')
    .split(/[\s,]+/)
    .filter(Boolean);
  return run(
    () =>
      authedFetch<{ key: string }>(org(orgSlug, '/keys'), {
        body: {
          name: field(form, 'name'),
          scopes: form.getAll('scopes').map(String),
          workspaces,
        },
      }),
    (t, r) => ({ status: 'success', message: t('keyCreated'), secret: (r as { key: string }).key })
  );
}

export async function revokeOrgKeyAction(orgSlug: string, keyId: string, _prev: ActionResult) {
  return run(
    () => authedFetch(org(orgSlug, `/keys/${enc(keyId)}`), { method: 'DELETE' }),
    (t) => ({ status: 'success', message: t('keyRevoked') })
  );
}

/** ORG-07: group rules, one per line: `group = workspace:role`; admin groups listed. */
export async function saveOrgProvisioningAction(
  orgSlug: string,
  _prev: ActionResult,
  form: FormData
): Promise<ActionResult> {
  const rules = field(form, 'rules')
    .split('\n')
    .map((line) => /^(.+?)\s*=\s*([a-z0-9-]+)\s*:\s*(\w+)\s*$/.exec(line.trim()))
    .filter((match): match is RegExpExecArray => !!match)
    .map(([, group, workspace, role]) => ({ group: group.trim(), workspace, role }));
  const adminGroups = field(form, 'adminGroups')
    .split(/\n|,/)
    .map((g) => g.trim())
    .filter(Boolean);
  return run(
    () =>
      authedFetch(org(orgSlug, '/provisioning'), {
        method: 'PUT',
        body: { rules, adminGroups },
      }),
    (t) => ({ status: 'success', message: t('provisioningSaved') })
  );
}
