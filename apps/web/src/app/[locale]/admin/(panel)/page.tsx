// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/routing';
import { TrendBars } from '@/components/TrendBars';
import { adminApi, type AttentionItem, type TrendDay } from '@/lib/adminApi';

const card = 'bg-white p-5 rounded-lg shadow-sm border border-gray-100';

/** Where an attention item is dealt with. */
function hrefOf(item: AttentionItem) {
  if (item.kind === 'failed_jobs') return '/admin/jobs';
  if (!item.tenant) return '/admin';
  return item.tenant.type === 'workspace'
    ? `/admin/workspaces/${item.tenant.slug}`
    : `/admin/orgs/${item.tenant.slug}`;
}

/** INST-27: what happened in the last 30 days and what needs attention now. */
export default async function AdminDashboardPage() {
  const t = await getTranslations('AdminDashboardPage');
  const format = await getFormatter();
  const overview = await adminApi.overview().catch(() => null);
  if (!overview) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
        <div className="p-4 bg-red-50 text-red-700 rounded-md">{t('errorFetch')}</div>
      </div>
    );
  }
  const { counts, trends, attention, recentAudit } = overview;
  const series = (pick: (d: TrendDay) => number) => trends.map(pick);
  const total = (pick: (d: TrendDay) => number) => series(pick).reduce((a, b) => a + b, 0);
  const charts: Array<[string, (d: TrendDay) => number]> = [
    ['deploys', (d) => d.deploys],
    ['manifestRequests', (d) => d.manifestRequests],
    ['activeUsers', (d) => d.activeUsers],
    ['newWorkspaces', (d) => d.newWorkspaces],
    ['newOrganizations', (d) => d.newOrganizations],
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {(
          [
            ['totalWorkspaces', counts.workspaces, '/admin/workspaces'],
            ['totalOrganizations', counts.organizations, '/admin/orgs'],
            ['totalUsers', counts.users, '/admin/users'],
            ['totalModules', counts.modules, '/admin/usage'],
          ] as const
        ).map(([label, value, href]) => (
          <Link key={label} href={href} className={`${card} hover:border-indigo-200`}>
            <h3 className="text-sm font-medium text-gray-500">{t(label)}</h3>
            <p className="mt-2 text-3xl font-bold text-gray-900">{format.number(value)}</p>
          </Link>
        ))}
      </div>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold text-gray-900">{t('attention')}</h2>
        {attention.length === 0 ? (
          <p className={`${card} text-sm text-green-700`}>{t('nothingNeedsAttention')}</p>
        ) : (
          <ul className="bg-white rounded-lg shadow-sm border border-gray-100 divide-y">
            {attention.map((item, i) => (
              <li key={i} className="p-3 text-sm flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-800">
                  {t(`kind_${item.kind}`)}
                </span>
                <Link href={hrefOf(item)} className="font-medium text-indigo-700 hover:underline">
                  {item.tenant ? `${item.tenant.slug} · ${item.subject}` : item.subject}
                </Link>
                {item.detail && (
                  <span className="text-gray-600 break-all">
                    {t(`detail_${item.kind}`, { detail: item.detail })}
                  </span>
                )}
                {item.since && (
                  <span className="text-xs text-gray-500">
                    {format.dateTime(new Date(item.since), 'short')}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold text-gray-900">{t('trends')}</h2>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {charts.map(([key, pick]) => (
            <div key={key} className={`${card} space-y-2`}>
              <div className="flex items-baseline justify-between">
                <h3 className="text-sm font-medium text-gray-700">{t(`trend_${key}`)}</h3>
                <span className="text-sm text-gray-900">{format.number(total(pick))}</span>
              </div>
              <TrendBars
                values={series(pick)}
                label={t('trendLabel', { name: t(`trend_${key}`), total: total(pick) })}
              />
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-2">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-semibold text-gray-900">{t('recentChanges')}</h2>
          <Link href="/admin/audit" className="text-sm text-indigo-700 hover:underline">
            {t('allChanges')}
          </Link>
        </div>
        <ul className="bg-white rounded-lg shadow-sm border border-gray-100 divide-y text-sm">
          {recentAudit.map((e) => (
            <li key={e.id} className="p-3 flex flex-wrap gap-x-3">
              <span className="font-mono text-xs text-gray-800">{e.action}</span>
              <span className="text-gray-600">{e.actor.label}</span>
              <span className="text-xs text-gray-500">
                {format.dateTime(new Date(e.createdAt), 'short')}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
