// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { getFormatter, getTranslations } from 'next-intl/server';
import { ActionForm } from '@/components/ActionForm';
import { workspaceApi } from '@/lib/workspaceApi';
import {
  changeRoleAction,
  decideAccessAction,
  inviteMemberAction,
  removeMemberAction,
  resendInvitationAction,
  revokeInvitationAction,
} from '../../actions';

const ROLES = ['viewer', 'developer', 'admin', 'owner'] as const;

export default async function MembersPage(props: { params: Promise<{ workspaceSlug: string }> }) {
  const { workspaceSlug } = await props.params;
  const t = await getTranslations('MembersPage');
  const format = await getFormatter();
  const [{ members, invitations = [] }, workspace, { requests }] = await Promise.all([
    workspaceApi.members(workspaceSlug),
    workspaceApi.get(workspaceSlug),
    workspaceApi.accessRequests(workspaceSlug).catch(() => ({ requests: [] })),
  ]);
  const pending = invitations.filter((i) => i.status === 'pending' || i.status === 'expired');
  // Only owners and org admins can grant or change ownership (enforced by the registry too).
  const assignable =
    workspace.role === 'owner' || workspace.viaOrgAdmin
      ? ROLES
      : ROLES.filter((r) => r !== 'owner');

  const roleSelect = (name: string, defaultValue?: string) => (
    <select
      name={name}
      defaultValue={defaultValue}
      aria-label={t('role')}
      className="rounded-md border px-2 py-1.5 text-sm"
    >
      {assignable.map((r) => (
        <option key={r} value={r}>
          {t(`roles.${r}`)}
        </option>
      ))}
    </select>
  );

  return (
    <div className="space-y-6">
      <section className="rounded-xl border bg-card p-6 space-y-3">
        <h3 className="font-semibold">{t('invite')}</h3>
        <ActionForm
          action={inviteMemberAction.bind(null, workspaceSlug)}
          submitLabel={t('inviteSubmit')}
          className="flex flex-wrap items-center gap-2"
          secretHint={t('inviteLink')}
        >
          <input
            name="email"
            type="email"
            required
            placeholder="dev@example.com"
            aria-label={t('email')}
            className="rounded-md border px-3 py-1.5 text-sm w-64"
          />
          {roleSelect('role', 'developer')}
        </ActionForm>
        <p className="text-xs text-muted-foreground">{t('inviteHint')}</p>
      </section>

      {/* PPL-07: organization members asking to join. */}
      {requests.length > 0 && (
        <section className="rounded-xl border bg-card p-6 space-y-3">
          <h3 className="font-semibold">{t('accessRequests')}</h3>
          <ul className="divide-y">
            {requests.map((r) => (
              <li key={r.id} className="py-3 flex flex-wrap items-center justify-between gap-3">
                <div className="text-sm">
                  <div className="font-medium">{r.user?.email ?? '?'}</div>
                  {r.message && <div className="text-xs text-muted-foreground">{r.message}</div>}
                </div>
                <div className="flex gap-2 items-center">
                  <ActionForm
                    action={decideAccessAction.bind(null, workspaceSlug, r.id, 'approve')}
                    submitLabel={t('approve')}
                    className="flex items-center gap-2"
                  >
                    {roleSelect('role', r.role)}
                  </ActionForm>
                  <ActionForm
                    action={decideAccessAction.bind(null, workspaceSlug, r.id, 'deny')}
                    submitLabel={t('deny')}
                    variant="outline"
                  />
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* PPL-01: invitations waiting to be accepted. */}
      {pending.length > 0 && (
        <section className="rounded-xl border bg-card p-6 space-y-3">
          <h3 className="font-semibold">{t('invitations')}</h3>
          <ul className="divide-y">
            {pending.map((i) => (
              <li key={i.id} className="py-3 flex flex-wrap items-center justify-between gap-3">
                <div className="text-sm">
                  <div className="font-medium">{i.email}</div>
                  <div className="text-xs text-muted-foreground">
                    {t(`roles.${i.role as (typeof ROLES)[number]}`)} ·{' '}
                    {i.status === 'expired'
                      ? t('invitationExpired')
                      : t('invitationExpires', {
                          date: format.dateTime(new Date(i.expiresAt), 'short'),
                        })}
                  </div>
                </div>
                <div className="flex gap-2">
                  <ActionForm
                    action={resendInvitationAction.bind(null, workspaceSlug, i.id)}
                    submitLabel={t('resend')}
                    variant="outline"
                    secretHint={t('inviteLink')}
                  />
                  <ActionForm
                    action={revokeInvitationAction.bind(null, workspaceSlug, i.id)}
                    submitLabel={t('revoke')}
                    variant="danger"
                    confirm={t('revokeConfirm', { email: i.email })}
                  />
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <ul className="rounded-xl border bg-card divide-y">
        {members.map((member) => (
          <li
            key={member.id ?? `org-${member.user.id}`}
            className="p-4 flex flex-wrap items-center justify-between gap-4"
          >
            <div>
              <div className="font-medium">{member.user.name ?? member.user.email}</div>
              <div className="text-xs text-muted-foreground">
                {member.user.email}
                {member.source === 'org_rules' && ` · ${t('viaOrgRules')}`}
              </div>
            </div>
            {/* PPL-06: org admins administer the workspace through the organization. */}
            {!member.id ? (
              <span className="text-sm text-muted-foreground">
                {t('viaOrgAdmin', { role: t(`roles.${member.role}`) })}
              </span>
            ) : member.role === 'owner' && workspace.role !== 'owner' && !workspace.viaOrgAdmin ? (
              <span className="text-sm">{t('roles.owner')}</span>
            ) : (
              <div className="flex gap-2 items-center">
                <ActionForm
                  action={changeRoleAction.bind(null, workspaceSlug, member.id!)}
                  submitLabel={t('save')}
                  variant="outline"
                  className="flex items-center gap-2"
                >
                  {roleSelect('role', member.role)}
                </ActionForm>
                <ActionForm
                  action={removeMemberAction.bind(null, workspaceSlug, member.id!)}
                  submitLabel={t('remove')}
                  variant="danger"
                  confirm={t('removeConfirm', { email: member.user.email })}
                  className="flex items-center gap-2"
                >
                  {/* PPL-05: their API keys are revoked unless kept. */}
                  <label className="flex items-center gap-1 text-xs text-muted-foreground">
                    <input type="checkbox" name="keepKeys" />
                    {t('keepKeys')}
                  </label>
                </ActionForm>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
