// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/routing';
import { ActionForm } from '@/components/ActionForm';
import { adminApi } from '@/lib/adminApi';
import {
  restoreWorkspaceAction,
  suspendWorkspaceAction,
  unsuspendWorkspaceAction,
} from '../actions';
import { PlanForm } from '../PlanForm';

const th = 'px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider';
const td = 'px-4 py-3 text-sm text-gray-700 align-top';
const small = 'rounded-md border px-2 py-1 text-xs';

type Filters = {
  query?: string;
  status?: string;
  plan?: string;
  org?: string;
  inactiveDays?: string;
  sort?: string;
};
const qs = (f: Filters & { cursor?: string; kind?: string }) =>
  new URLSearchParams(Object.entries(f).filter((e): e is [string, string] => !!e[1])).toString();
/** A file download, not a page. */
const EXPORT_URL = '/api/admin-export';

/** INST-09, INST-29: every workspace with usage, filtered and sorted; details per workspace. */
export default async function AdminWorkspacesPage(props: {
  searchParams: Promise<Filters & { cursor?: string }>;
}) {
  const { cursor, ...filters } = await props.searchParams;
  const t = await getTranslations('AdminWorkspacesPage');
  const format = await getFormatter();
  const { workspaces, total, nextCursor } = await adminApi.workspaces({ ...filters, cursor });
  const select = (name: keyof Filters, options: Array<[string, string]>) => (
    <select
      name={name}
      defaultValue={filters[name] ?? ''}
      aria-label={t(`filter_${name}`)}
      className="rounded-md border px-2 py-1.5 text-sm bg-white"
    >
      {options.map(([value, label]) => (
        <option key={value} value={value}>
          {label}
        </option>
      ))}
    </select>
  );

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
      <form className="flex flex-wrap gap-2">
        <input
          name="query"
          defaultValue={filters.query}
          placeholder={t('search')}
          aria-label={t('search')}
          className="rounded-md border px-3 py-1.5 text-sm w-64"
        />
        {select('status', [
          ['', t('anyStatus')],
          ['active', t('active')],
          ['suspended', t('suspended')],
          ['deleted', t('deleted')],
        ])}
        {select('plan', [
          ['', t('anyPlan')],
          ['hobby', 'hobby'],
          ['startup', 'startup'],
          ['enterprise', 'enterprise'],
        ])}
        <input
          name="org"
          defaultValue={filters.org}
          placeholder={t('orgFilter')}
          aria-label={t('filter_org')}
          className="rounded-md border px-3 py-1.5 text-sm w-40"
        />
        <input
          name="inactiveDays"
          type="number"
          min={1}
          defaultValue={filters.inactiveDays}
          placeholder={t('inactiveDays')}
          aria-label={t('filter_inactiveDays')}
          className="rounded-md border px-3 py-1.5 text-sm w-44"
        />
        {select('sort', [
          ['', t('sortCreated')],
          ['name', t('sortName')],
          ['lastDeploy', t('sortLastDeploy')],
          ['storage', t('sortStorage')],
        ])}
        <button className="rounded-md border px-3 py-1.5 text-sm bg-white">
          {t('searchButton')}
        </button>
        <a
          href={`${EXPORT_URL}?${qs({ ...filters, kind: 'workspaces' })}`}
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
              <th className={th}>{t('name')}</th>
              <th className={th}>{t('usage')}</th>
              <th className={th}>{t('plan')}</th>
              <th className={th}>{t('status')}</th>
              <th className={th}>{t('actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {workspaces.map((ws) => (
              <tr key={ws.id}>
                <td className={td}>
                  <Link
                    href={`/admin/workspaces/${ws.slug}`}
                    className="font-medium text-indigo-700 hover:underline"
                  >
                    {ws.name}
                  </Link>
                  <div className="text-xs text-gray-500">
                    {ws.slug}
                    {ws.organization && ` · ${t('inOrg', { org: ws.organization })}`}
                  </div>
                  <div className="text-xs text-gray-400">
                    {format.dateTime(new Date(ws.createdAt), 'short')}
                  </div>
                </td>
                <td className={td}>
                  {t('usageLine', {
                    modules: ws.modules,
                    members: ws.members,
                    deploys: ws.deploys,
                  })}
                  {/* INST-09, USG-02 */}
                  <div className="text-xs text-gray-500">
                    {t('storageLine', {
                      gb: format.number((ws.storageBytes ?? 0) / 1024 ** 3, {
                        maximumFractionDigits: 2,
                      }),
                    })}
                  </div>
                </td>
                <td className={td}>
                  <PlanForm
                    target={{ kind: 'workspace', slug: ws.slug }}
                    plan={ws.plan}
                    expiresAt={ws.planExpiresAt ?? null}
                    overrides={ws.planOverrides ?? null}
                  />
                  {ws.organizationPlan && (
                    <div className="text-xs text-gray-500 mt-1">
                      {t('orgPlan', { plan: ws.organizationPlan })}
                    </div>
                  )}
                </td>
                <td className={td}>
                  {ws.deletedAt ? (
                    <span className="text-red-700">
                      {t('deleted')}
                      {ws.purgeAfter && (
                        <span className="block text-xs text-gray-500">
                          {t('purgeAfter', {
                            date: format.dateTime(new Date(ws.purgeAfter), 'short'),
                          })}
                        </span>
                      )}
                    </span>
                  ) : ws.suspendedAt ? (
                    <span className="text-red-700">
                      {t('suspended')}
                      {ws.suspendedReason && (
                        <span className="block text-xs text-gray-500">{ws.suspendedReason}</span>
                      )}
                    </span>
                  ) : (
                    <span className="text-green-700">{t('active')}</span>
                  )}
                </td>
                <td className={`${td} space-y-2`}>
                  {ws.deletedAt ? (
                    <ActionForm
                      action={restoreWorkspaceAction.bind(null, ws.slug)}
                      submitLabel={t('restore')}
                      variant="outline"
                    />
                  ) : ws.suspendedAt ? (
                    <ActionForm
                      action={unsuspendWorkspaceAction.bind(null, ws.slug)}
                      submitLabel={t('unsuspend')}
                      variant="outline"
                    />
                  ) : (
                    <ActionForm
                      action={suspendWorkspaceAction.bind(null, ws.slug)}
                      submitLabel={t('suspend')}
                      variant="outline"
                      confirm={t('suspendConfirm', { slug: ws.slug })}
                      className="flex gap-2 items-start"
                    >
                      <input name="reason" placeholder={t('reason')} className={small} />
                    </ActionForm>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {nextCursor && (
        <Link
          href={`/admin/workspaces?${qs({ ...filters, cursor: nextCursor })}`}
          className="text-sm text-indigo-600"
        >
          {t('next')}
        </Link>
      )}
    </div>
  );
}
