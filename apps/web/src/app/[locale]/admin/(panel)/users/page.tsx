// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/routing';
import { ActionForm } from '@/components/ActionForm';
import { adminApi } from '@/lib/adminApi';
import {
  resetMfaAction,
  revokeSessionsAction,
  suspendUserAction,
  unsuspendUserAction,
} from '../actions';

const th = 'px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider';
const td = 'px-4 py-3 text-sm text-gray-700 align-top';

type Filters = { query?: string; filter?: string; inactiveDays?: string };
const qs = (f: Filters & { cursor?: string; kind?: string }) =>
  new URLSearchParams(Object.entries(f).filter((e): e is [string, string] => !!e[1])).toString();
/** A file download, not a page. */
const EXPORT_URL = '/api/admin-export';

/** INST-10, INST-21, INST-30: every account, filtered; details and changes per account. */
export default async function AdminUsersPage(props: {
  searchParams: Promise<Filters & { cursor?: string }>;
}) {
  const { cursor, ...filters } = await props.searchParams;
  const t = await getTranslations('AdminUsersPage');
  const format = await getFormatter();
  const { users, total, nextCursor } = await adminApi.users({ ...filters, cursor });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
      <form className="flex flex-wrap gap-2">
        <input
          name="query"
          defaultValue={filters.query}
          placeholder={t('search')}
          aria-label={t('search')}
          className="rounded-md border px-3 py-1.5 text-sm w-72"
        />
        <select
          name="filter"
          defaultValue={filters.filter ?? ''}
          aria-label={t('filter')}
          className="rounded-md border px-2 py-1.5 text-sm bg-white"
        >
          <option value="">{t('everyone')}</option>
          <option value="admins">{t('filterAdmins')}</option>
          <option value="suspended">{t('filterSuspended')}</option>
          <option value="never">{t('filterNever')}</option>
          <option value="inactive">{t('filterInactive')}</option>
        </select>
        <input
          name="inactiveDays"
          type="number"
          min={1}
          defaultValue={filters.inactiveDays}
          placeholder={t('inactiveDays')}
          aria-label={t('inactiveDays')}
          className="rounded-md border px-3 py-1.5 text-sm w-40"
        />
        <button className="rounded-md border px-3 py-1.5 text-sm bg-white">
          {t('searchButton')}
        </button>
        <a
          href={`${EXPORT_URL}?${qs({ ...filters, kind: 'users' })}`}
          download
          className="rounded-md border px-3 py-1.5 text-sm bg-white"
        >
          {t('exportCsv')}
        </a>
      </form>
      {total !== undefined && (
        <p className="text-xs text-gray-500">{t('total', { count: total })}</p>
      )}
      <div className="bg-white rounded-lg shadow-sm border border-gray-100 overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className={th}>{t('user')}</th>
              <th className={th}>{t('workspaces')}</th>
              <th className={th}>{t('lastLogin')}</th>
              <th className={th}>{t('actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {users.map((u) => (
              <tr key={u.id}>
                <td className={td}>
                  <div className="font-medium text-gray-900">
                    <Link href={`/admin/users/${u.id}`} className="text-indigo-700 hover:underline">
                      {u.email}
                    </Link>
                    {u.isInstanceAdmin && (
                      <span className="ml-2 text-xs text-indigo-700">{t('admin')}</span>
                    )}
                    {u.mfaEnabled && <span className="ml-2 text-xs text-blue-700">{t('mfa')}</span>}
                    {u.suspendedAt && (
                      <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-800">
                        {t('suspended')}
                      </span>
                    )}
                  </div>
                  {u.suspendedReason && (
                    <div className="text-xs text-red-700">{u.suspendedReason}</div>
                  )}
                  {u.name && <div className="text-xs text-gray-500">{u.name}</div>}
                </td>
                <td className={td}>
                  {u.workspaces.length
                    ? u.workspaces.map((w) => `${w.slug} (${w.role})`).join(', ')
                    : '—'}
                  {/* INST-21 */}
                  {!!u.organizations?.length && (
                    <div className="text-xs text-gray-500">
                      {t('orgs', {
                        list: u.organizations.map((o) => `${o.slug} (${o.role})`).join(', '),
                      })}
                    </div>
                  )}
                </td>
                <td className={td}>
                  {u.lastLoginAt ? format.dateTime(new Date(u.lastLoginAt), 'short') : t('never')}
                  <div className="text-xs text-gray-500">
                    {t('sessions', { count: u.activeSessions })}
                  </div>
                </td>
                <td className={`${td} space-y-2`}>
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
                      confirm={t('suspendConfirm', { email: u.email })}
                      variant="outline"
                      className="flex gap-2 items-start"
                    >
                      <input
                        name="reason"
                        placeholder={t('reason')}
                        aria-label={t('reason')}
                        className="rounded-md border px-2 py-1 text-xs"
                      />
                    </ActionForm>
                  )}
                  {u.mfaEnabled && (
                    <ActionForm
                      action={resetMfaAction.bind(null, u.id)}
                      submitLabel={t('resetMfa')}
                      confirm={t('resetMfaConfirm', { email: u.email })}
                      variant="outline"
                    />
                  )}
                  <ActionForm
                    action={revokeSessionsAction.bind(null, u.id)}
                    submitLabel={t('revokeSessions')}
                    variant="outline"
                    confirm={t('revokeConfirm', { email: u.email })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {nextCursor && (
        <Link
          href={`/admin/users?${qs({ ...filters, cursor: nextCursor })}`}
          className="text-sm text-indigo-600"
        >
          {t('next')}
        </Link>
      )}
    </div>
  );
}
