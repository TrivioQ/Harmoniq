// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { notFound } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { ActionForm } from '@/components/ActionForm';
import { Link } from '@/i18n/routing';
import { adminApi } from '@/lib/adminApi';
import { RegistryError } from '@/lib/registry';
import {
  changeUserEmailAction,
  deleteUserAndReturnAction,
  endUserSessionAction,
  mergeUserAction,
  resetMfaAction,
  revokeSessionsAction,
  suspendUserAction,
  unsuspendUserAction,
} from '../../actions';

const card = 'bg-white p-4 rounded-lg shadow-sm border border-gray-100 space-y-2';
const small = 'rounded-md border px-2 py-1 text-xs';

/** INST-30: one account across tenants: sign-in methods, memberships, sessions, keys. */
export default async function AdminUserPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const t = await getTranslations('AdminUserPage');
  const format = await getFormatter();
  const u = await adminApi.user(id).catch((err) => {
    if (err instanceof RegistryError && err.status === 404) notFound();
    throw err;
  });
  const when = (d: string | null) => (d ? format.dateTime(new Date(d), 'short') : '—');
  const tenantHref = (scope: string, slug: string) =>
    scope === 'workspace' ? `/admin/workspaces/${slug}` : `/admin/orgs/${slug}`;

  return (
    <div className="space-y-6 max-w-5xl">
      <Link href="/admin/users" className="text-sm text-indigo-700 hover:underline">
        ← {t('back')}
      </Link>
      <div>
        <h1 className="text-2xl font-bold text-gray-900">{u.email}</h1>
        <p className="text-sm text-gray-500">
          {u.name && `${u.name} · `}
          {t('created', { date: when(u.createdAt) })} ·{' '}
          {t('lastLogin', { date: when(u.lastLoginAt) })}
          {u.instanceAdmin && ` · ${t('instanceAdmin', { role: u.instanceAdmin.role })}`}
          {u.mfaEnabled && ` · ${t('mfa')}`}
        </p>
        {u.suspendedAt && (
          <p className="text-sm text-red-700">
            {t('suspended', { date: when(u.suspendedAt) })}
            {u.suspendedReason && `: ${u.suspendedReason}`}
          </p>
        )}
        {u.pendingEmail && (
          <p className="text-sm text-amber-800">{t('pendingEmail', { email: u.pendingEmail })}</p>
        )}
      </div>

      <div className="flex flex-wrap gap-2 items-start">
        {u.suspendedAt ? (
          <ActionForm
            action={unsuspendUserAction.bind(null, u.id)}
            submitLabel={t('unsuspend')}
            variant="outline"
          />
        ) : (
          <ActionForm
            action={suspendUserAction.bind(null, u.id)}
            submitLabel={t('suspend')}
            variant="outline"
            confirm={t('suspendConfirm', { email: u.email })}
            className="flex gap-2 items-start"
          >
            <input
              name="reason"
              placeholder={t('reason')}
              aria-label={t('reason')}
              className={small}
            />
          </ActionForm>
        )}
        {u.mfaEnabled && (
          <ActionForm
            action={resetMfaAction.bind(null, u.id)}
            submitLabel={t('resetMfa')}
            variant="outline"
            confirm={t('resetMfaConfirm', { email: u.email })}
          />
        )}
        {u.sessions.length > 0 && (
          <ActionForm
            action={revokeSessionsAction.bind(null, u.id)}
            submitLabel={t('endAllSessions')}
            variant="outline"
            confirm={t('endAllConfirm', { email: u.email })}
          />
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <section className={card}>
          <h2 className="text-sm font-medium text-gray-700">{t('signInMethods')}</h2>
          <table className="w-full text-xs">
            <tbody>
              {u.identities.map((i, n) => (
                <tr key={n} className="border-t">
                  <td className="py-1 font-mono">{i.provider}</td>
                  <td className="py-1 break-all">{i.email}</td>
                  <td className="py-1 text-gray-500">{when(i.lastUsedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className={card}>
          <h2 className="text-sm font-medium text-gray-700">{t('memberships')}</h2>
          <ul className="text-xs space-y-1">
            {u.organizations.map((o) => (
              <li key={`o-${o.slug}`}>
                <Link href={`/admin/orgs/${o.slug}`} className="text-indigo-700 hover:underline">
                  {o.name}
                </Link>{' '}
                · {o.role}
              </li>
            ))}
            {u.workspaces.map((w) => (
              <li key={`w-${w.slug}`}>
                <Link
                  href={`/admin/workspaces/${w.slug}`}
                  className="text-indigo-700 hover:underline"
                >
                  {w.name}
                </Link>{' '}
                · {w.role}
                {!w.joinedAt && ` · ${t('invited')}`}
                {w.deleted && ` · ${t('deletedWorkspace')}`}
              </li>
            ))}
            {!u.organizations.length && !u.workspaces.length && <li>{t('none')}</li>}
          </ul>
        </section>
      </div>

      <section className={card}>
        <h2 className="text-sm font-medium text-gray-700">{t('sessions')}</h2>
        {u.sessions.length === 0 ? (
          <p className="text-xs text-gray-500">{t('noSessions')}</p>
        ) : (
          <table className="w-full text-xs">
            <tbody>
              {u.sessions.map((s) => (
                <tr key={s.id} className="border-t align-top">
                  <td className="py-1">{s.provider ?? '—'}</td>
                  <td className="py-1">{t('active', { date: when(s.lastActiveAt) })}</td>
                  <td className="py-1 font-mono">{s.ip ?? '—'}</td>
                  <td className="py-1 text-gray-500 break-all">{s.userAgent ?? ''}</td>
                  <td className="py-1">
                    <ActionForm
                      action={endUserSessionAction.bind(null, u.id, s.id)}
                      submitLabel={t('end')}
                      variant="outline"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className={card}>
        <h2 className="text-sm font-medium text-gray-700">{t('apiKeys')}</h2>
        {u.apiKeys.length === 0 ? (
          <p className="text-xs text-gray-500">{t('none')}</p>
        ) : (
          <table className="w-full text-xs">
            <tbody>
              {u.apiKeys.map((k) => (
                <tr key={k.id} className={`border-t ${k.revokedAt ? 'opacity-60' : ''}`}>
                  <td className="py-1">
                    <Link href={tenantHref(k.scope, k.tenant)} className="text-indigo-700">
                      {k.tenant}
                    </Link>
                  </td>
                  <td className="py-1">
                    {k.name} <code>{k.prefix}…</code>
                  </td>
                  <td className="py-1 text-gray-500">
                    {k.revokedAt ? t('revoked') : t('lastUsed', { date: when(k.lastUsedAt) })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className={card}>
        <h2 className="text-sm font-medium text-gray-700">{t('activity')}</h2>
        {u.activity.length === 0 ? (
          <p className="text-xs text-gray-500">{t('none')}</p>
        ) : (
          <table className="w-full text-xs">
            <tbody>
              {u.activity.map((a, n) => (
                <tr key={n} className="border-t">
                  <td className="py-1 whitespace-nowrap text-gray-500">{when(a.createdAt)}</td>
                  <td className="py-1">{a.tenant ?? t('instance')}</td>
                  <td className="py-1 font-mono">{a.action}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <Link
          href={`/admin/audit?who=${encodeURIComponent(u.email)}`}
          className="text-xs text-indigo-700 hover:underline"
        >
          {t('allActivity')}
        </Link>
      </section>

      <section className={card}>
        <h2 className="text-sm font-medium text-gray-700">{t('signIns')}</h2>
        {u.signIns.length === 0 ? (
          <p className="text-xs text-gray-500">{t('none')}</p>
        ) : (
          <table className="w-full text-xs">
            <tbody>
              {u.signIns.map((s, n) => (
                <tr key={n} className="border-t">
                  <td className="py-1 whitespace-nowrap text-gray-500">{when(s.createdAt)}</td>
                  <td className="py-1">{s.method}</td>
                  <td className={`py-1 ${s.success ? 'text-green-700' : 'text-red-700'}`}>
                    {s.success ? t('succeeded') : (s.reason ?? t('failed'))}
                  </td>
                  <td className="py-1 font-mono">{s.ip ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <section className={card}>
          <h2 className="text-sm font-medium text-gray-700">{t('changeEmail')}</h2>
          <p className="text-xs text-gray-500">{t('changeEmailHint')}</p>
          <ActionForm
            action={changeUserEmailAction.bind(null, u.id)}
            submitLabel={t('sendConfirmation')}
            className="flex gap-2 items-start"
          >
            <input
              name="email"
              type="email"
              required
              aria-label={t('newEmail')}
              placeholder={t('newEmail')}
              className={small}
            />
          </ActionForm>
        </section>
        <section className={card}>
          <h2 className="text-sm font-medium text-gray-700">{t('merge')}</h2>
          <p className="text-xs text-gray-500">{t('mergeHint', { email: u.email })}</p>
          <ActionForm
            action={mergeUserAction.bind(null, u.id)}
            submitLabel={t('mergeSubmit')}
            variant="danger"
            confirm={t('mergeConfirm', { email: u.email })}
            className="flex gap-2 items-start"
          >
            <input
              name="into"
              type="email"
              required
              aria-label={t('mergeInto')}
              placeholder={t('mergeInto')}
              className={small}
            />
          </ActionForm>
        </section>
      </div>

      <section className="rounded-lg border border-red-200 bg-red-50 p-4 space-y-2">
        <h2 className="text-sm font-medium text-red-800">{t('dangerZone')}</h2>
        <ActionForm
          action={deleteUserAndReturnAction.bind(null, u.id)}
          submitLabel={t('delete')}
          variant="danger"
          confirm={t('deleteConfirm', { email: u.email })}
          className="flex gap-2 items-start"
        >
          <input
            name="confirm"
            required
            placeholder={u.email}
            aria-label={t('typeEmail')}
            className={small}
          />
        </ActionForm>
      </section>
    </div>
  );
}
