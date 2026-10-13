// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { getFormatter, getTranslations } from 'next-intl/server';
import { ActionForm } from '@/components/ActionForm';
import { Link } from '@/i18n/routing';
import { adminApi } from '@/lib/adminApi';
import { PlanForm } from '../PlanForm';
import { restoreOrgAction, suspendOrgAction, unsuspendOrgAction } from '../actions';

const th = 'px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider';
const td = 'px-4 py-3 text-sm text-gray-700 align-top';

type Filters = { query?: string; status?: string };
const qs = (f: Filters & { cursor?: string }) =>
  new URLSearchParams(Object.entries(f).filter((e): e is [string, string] => !!e[1])).toString();

/** INST-19, PLN-01: organizations, searched and paged, with their plans and status. */
export default async function AdminOrgsPage(props: {
  searchParams: Promise<Filters & { cursor?: string }>;
}) {
  const { cursor, ...filters } = await props.searchParams;
  const t = await getTranslations('AdminOrgsPage');
  const format = await getFormatter();
  const { organizations, total, nextCursor } = await adminApi.orgs({ ...filters, cursor });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
      <p className="text-sm text-gray-600">{t('description')}</p>
      <form className="flex flex-wrap gap-2">
        <input
          name="query"
          defaultValue={filters.query}
          placeholder={t('search')}
          aria-label={t('search')}
          className="rounded-md border px-3 py-1.5 text-sm w-64"
        />
        <select
          name="status"
          defaultValue={filters.status ?? ''}
          aria-label={t('statusFilter')}
          className="rounded-md border px-2 py-1.5 text-sm bg-white"
        >
          <option value="">{t('anyStatus')}</option>
          <option value="active">{t('active')}</option>
          <option value="suspended">{t('suspended')}</option>
          <option value="deleted">{t('deleted')}</option>
        </select>
        <button className="rounded-md border px-3 py-1.5 text-sm bg-white">
          {t('searchButton')}
        </button>
      </form>
      {total !== undefined && (
        <p className="text-xs text-gray-500">{t('total', { count: total })}</p>
      )}
      {organizations.length === 0 ? (
        <p className="text-sm text-gray-500">{t('empty')}</p>
      ) : (
        <div className="bg-white rounded-lg shadow-sm border border-gray-100 overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className={th}>{t('name')}</th>
                <th className={th}>{t('size')}</th>
                <th className={th}>{t('plan')}</th>
                <th className={th}>{t('status')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {organizations.map((o) => (
                <tr key={o.slug}>
                  <td className={td}>
                    <Link
                      href={`/admin/orgs/${o.slug}`}
                      className="font-medium text-indigo-700 hover:underline"
                    >
                      {o.name}
                    </Link>
                    <div className="text-xs text-gray-500">{o.slug}</div>
                  </td>
                  <td className={td}>
                    {t('sizeLine', { workspaces: o.workspaces, members: o.members })}
                  </td>
                  <td className={td}>
                    <PlanForm
                      target={{ kind: 'org', slug: o.slug }}
                      plan={o.plan}
                      expiresAt={o.planExpiresAt ?? null}
                      basePlan={o.basePlan ?? null}
                      overrides={o.planOverrides ?? null}
                    />
                  </td>
                  <td className={`${td} space-y-2`}>
                    {o.deletedAt ? (
                      <>
                        <span className="block text-red-700">
                          {o.purgeAfter
                            ? t('deletedUntil', {
                                date: format.dateTime(new Date(o.purgeAfter), 'short'),
                              })
                            : t('deleted')}
                        </span>
                        <ActionForm
                          action={restoreOrgAction.bind(null, o.slug)}
                          submitLabel={t('restore')}
                          variant="outline"
                        />
                      </>
                    ) : o.suspendedAt ? (
                      <>
                        <span className="block text-red-700">
                          {t('suspended')}
                          {o.suspendedReason && (
                            <span className="block text-xs text-gray-500">{o.suspendedReason}</span>
                          )}
                        </span>
                        <ActionForm
                          action={unsuspendOrgAction.bind(null, o.slug)}
                          submitLabel={t('unsuspend')}
                          variant="outline"
                        />
                      </>
                    ) : (
                      <ActionForm
                        action={suspendOrgAction.bind(null, o.slug)}
                        submitLabel={t('suspend')}
                        variant="outline"
                        confirm={t('suspendConfirm', { org: o.slug })}
                        className="flex gap-2 items-start"
                      >
                        <input
                          name="reason"
                          placeholder={t('reason')}
                          className="rounded-md border px-2 py-1 text-xs"
                        />
                      </ActionForm>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {nextCursor && (
        <Link
          href={`/admin/orgs?${qs({ ...filters, cursor: nextCursor })}`}
          className="text-sm text-indigo-600"
        >
          {t('next')}
        </Link>
      )}
    </div>
  );
}
