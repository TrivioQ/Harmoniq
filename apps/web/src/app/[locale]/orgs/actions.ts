// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
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

/** TLC-02: deletes a workspace of the organization (restorable until the purge). */
export async function deleteOrgWorkspaceAction(
  orgSlug: string,
  workspace: string,
  _prev: ActionResult,
  form: FormData
) {
  const confirm = field(form, 'confirm');
  return run(
    () =>
      authedFetch(
        org(orgSlug, `/workspaces/${enc(workspace)}?delete=true&confirm=${enc(confirm)}`),
        { method: 'DELETE' }
      ),
    (t) => ({ status: 'success', message: t('workspaceDeleted', { workspace }) })
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
  _prev: ActionResult,
  form?: FormData
) {
  // PPL-04: the registry removes them from the org's workspaces too; report what it did.
  const keepKeys = form?.get('keepKeys') === 'on' ? '?keepKeys=true' : '';
  return run(
    () =>
      authedFetch<{
        workspacesLeft: string[];
        keptAsLastOwner: string[];
        apiKeysRevoked: number;
        orgKeysRevoked: number;
      }>(org(orgSlug, `/members/${enc(memberId)}${keepKeys}`), { method: 'DELETE' }),
    (t, r) => {
      const result = r as {
        workspacesLeft: string[];
        keptAsLastOwner: string[];
        apiKeysRevoked: number;
        orgKeysRevoked: number;
      };
      return {
        status: 'success',
        message: t('orgMemberRemoved', {
          workspaces: result.workspacesLeft.length,
          keys: result.apiKeysRevoked + result.orgKeysRevoked,
          lastOwner: result.keptAsLastOwner.join(', ') || '—',
        }),
      };
    }
  );
}

/** PPL-01: invites someone to the organization; the link is shown either way. */
export async function inviteOrgMemberAction(orgSlug: string, _prev: ActionResult, form: FormData) {
  return run(
    () =>
      authedFetch<{ acceptUrl: string; emailed: boolean }>(org(orgSlug, '/invitations'), {
        body: { email: field(form, 'email'), role: field(form, 'role') || 'org_member' },
      }),
    (t, r) => {
      const { acceptUrl, emailed } = r as { acceptUrl: string; emailed: boolean };
      return {
        status: 'success',
        message: t(emailed ? 'invitationEmailed' : 'invitationLinkOnly'),
        secret: acceptUrl,
      };
    }
  );
}

export async function resendOrgInvitationAction(orgSlug: string, id: string, _prev: ActionResult) {
  return run(
    () =>
      authedFetch<{ acceptUrl: string; emailed: boolean }>(
        org(orgSlug, `/invitations/${enc(id)}/resend`),
        { method: 'POST', body: {} }
      ),
    (t, r) => {
      const { acceptUrl, emailed } = r as { acceptUrl: string; emailed: boolean };
      return {
        status: 'success',
        message: t(emailed ? 'invitationEmailed' : 'invitationLinkOnly'),
        secret: acceptUrl,
      };
    }
  );
}

export async function revokeOrgInvitationAction(orgSlug: string, id: string, _prev: ActionResult) {
  return run(
    () => authedFetch(org(orgSlug, `/invitations/${enc(id)}`), { method: 'DELETE' }),
    (t) => ({ status: 'success', message: t('invitationRevoked') })
  );
}

/** PPL-07: an org member asks to join one of the organization's workspaces. */
export async function requestAccessAction(workspace: string, _prev: ActionResult) {
  return run(
    () => authedFetch(`/api/workspaces/${enc(workspace)}/access-requests`, { body: {} }),
    (t) => ({ status: 'success', message: t('accessRequested') })
  );
}

/** TLC-06: an org admin hands the admin seat to a member, who must accept. */
export async function transferOrgAction(orgSlug: string, _prev: ActionResult, form: FormData) {
  const email = field(form, 'email');
  return run(
    () => authedFetch(org(orgSlug, '/transfer'), { body: { email } }),
    (t) => ({ status: 'success', message: t('orgTransferProposed', { email }) })
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
          // TAD-05: module scope and expiry, as for workspace keys.
          moduleIds: form.getAll('moduleIds').map(String).filter(Boolean),
          ...(field(form, 'expiresAt') && {
            expiresAt: new Date(`${field(form, 'expiresAt')}T23:59:59.999Z`).toISOString(),
          }),
        },
      }),
    (t, r) => ({ status: 'success', message: t('keyCreated'), secret: (r as { key: string }).key })
  );
}

/** TAD-05: a new secret; the old one keeps working for the grace period. */
export async function rotateOrgKeyAction(
  orgSlug: string,
  keyId: string,
  _prev: ActionResult,
  form: FormData
): Promise<ActionResult> {
  const hours = Number(field(form, 'gracePeriodHours') || 24);
  return run(
    () =>
      authedFetch<{ key: string }>(org(orgSlug, `/keys/${enc(keyId)}/rotate`), {
        body: { gracePeriodHours: hours },
      }),
    (t, r) => ({
      status: 'success',
      message: t('orgKeyRotated', { hours }),
      secret: (r as { key: string }).key,
    })
  );
}

/** TAD-01: rename the organization. */
export async function renameOrgAction(orgSlug: string, _prev: ActionResult, form: FormData) {
  return run(
    () => authedFetch(org(orgSlug), { method: 'PATCH', body: { name: field(form, 'name') } }),
    (t) => ({ status: 'success', message: t('orgRenamed') })
  );
}

/** TAD-01: delete the organization (its slug typed back). An instance admin can restore it. */
export async function deleteOrgAction(
  orgSlug: string,
  _prev: ActionResult,
  form: FormData
): Promise<ActionResult> {
  const t = await getTranslations('Actions');
  if (field(form, 'confirm') !== orgSlug) {
    return { status: 'error', message: t('typeSlugToConfirm', { slug: orgSlug }) };
  }
  const result = await run(
    () => authedFetch(org(orgSlug), { method: 'DELETE' }),
    (tr) => ({ status: 'success', message: tr('orgDeleted') })
  );
  if (result.status === 'success') redirect('/');
  return result;
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
