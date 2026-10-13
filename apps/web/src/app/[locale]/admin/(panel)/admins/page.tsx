// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { getFormatter, getTranslations } from 'next-intl/server';
import { ActionForm } from '@/components/ActionForm';
import { ADMIN_ROLES, AdminRole, adminApi } from '@/lib/adminApi';
import {
  changeAdminRoleAction,
  grantAdminAction,
  revokeAdminAction,
  revokeAdminInvitationAction,
} from '../actions';

const select = 'rounded-md border px-2 py-1.5 text-sm';

function RoleSelect({
  labels,
  defaultValue = 'instance_owner',
}: {
  labels: Record<AdminRole, string>;
  defaultValue?: AdminRole;
}) {
  return (
    <select name="role" defaultValue={defaultValue} aria-label="role" className={select}>
      {ADMIN_ROLES.map((r) => (
        <option key={r} value={r}>
          {labels[r]}
        </option>
      ))}
    </select>
  );
}

/** INST-05/07, INST-31: who administers the instance, with which role. */
export default async function AdminAdminsPage() {
  const t = await getTranslations('AdminAdminsPage');
  const format = await getFormatter();
  const { admins, invitations = [] } = await adminApi.admins();
  const roles = Object.fromEntries(ADMIN_ROLES.map((r) => [r, t(`role_${r}`)])) as Record<
    AdminRole,
    string
  >;

  return (
    <div className="space-y-6 max-w-3xl">
      <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
      <p className="text-sm text-gray-600">{t('description')}</p>
      <ul className="text-xs text-gray-600 list-disc pl-5 space-y-0.5">
        {ADMIN_ROLES.map((r) => (
          <li key={r}>
            <span className="font-medium">{roles[r]}</span>: {t(`roleHint_${r}`)}
          </li>
        ))}
      </ul>
      <section className="bg-white p-4 rounded-lg shadow-sm border border-gray-100">
        <ActionForm
          action={grantAdminAction}
          submitLabel={t('grant')}
          className="flex flex-wrap gap-2"
        >
          <input
            name="email"
            type="email"
            required
            placeholder="ops@example.com"
            aria-label={t('email')}
            className="rounded-md border px-3 py-1.5 text-sm w-72"
          />
          <RoleSelect labels={roles} />
        </ActionForm>
        <p className="mt-2 text-xs text-gray-500">{t('inviteHint')}</p>
      </section>
      <ul className="bg-white rounded-lg shadow-sm border border-gray-100 divide-y">
        {admins.map((a) => (
          <li key={a.id} className="p-4 flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="text-sm font-medium text-gray-900 flex items-center gap-2">
                {a.email}
                <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-xs text-indigo-700">
                  {roles[a.role ?? 'instance_owner']}
                </span>
                {a.mfa === false && (
                  <span className="rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-800">
                    {t('noMfa')}
                  </span>
                )}
              </div>
              <div className="text-xs text-gray-500">
                {t('since', { date: format.dateTime(new Date(a.since), 'short') })}
              </div>
            </div>
            <div className="flex items-start gap-2">
              <ActionForm
                action={changeAdminRoleAction.bind(null, a.id)}
                submitLabel={t('changeRole')}
                variant="outline"
                className="flex gap-2"
              >
                <RoleSelect labels={roles} defaultValue={a.role} />
              </ActionForm>
              <ActionForm
                action={revokeAdminAction.bind(null, a.id)}
                submitLabel={t('revoke')}
                variant="outline"
                confirm={t('revokeConfirm', { email: a.email })}
              />
            </div>
          </li>
        ))}
      </ul>
      {invitations.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold text-gray-900">{t('invitations')}</h2>
          <ul className="bg-white rounded-lg shadow-sm border border-gray-100 divide-y">
            {invitations.map((i) => (
              <li key={i.id} className="p-4 flex items-center justify-between gap-4">
                <div>
                  <div className="text-sm text-gray-900">
                    {i.email} · {roles[i.role]}
                  </div>
                  <div className="text-xs text-gray-500">
                    {t('invitationExpires', {
                      date: format.dateTime(new Date(i.expiresAt), 'short'),
                    })}
                  </div>
                </div>
                <ActionForm
                  action={revokeAdminInvitationAction.bind(null, i.id)}
                  submitLabel={t('revoke')}
                  variant="outline"
                />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
