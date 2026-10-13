// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/routing';
import { adminApi } from '@/lib/adminApi';
import { nearLimits, quotaUse } from '@/lib/usage';

const th = 'px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase';
const td = 'px-4 py-2 text-sm text-gray-700 align-top';

/** USG-03, INST-09: every workspace's usage against its quotas, and CSV for all. */
export default async function AdminUsagePage(props: {
  searchParams: Promise<{ cursor?: string; days?: string }>;
}) {
  const { cursor, days: rawDays } = await props.searchParams;
  const days = rawDays === '90' ? '90' : '30';
  const t = await getTranslations('AdminUsage');
  const format = await getFormatter();
  const usage = await adminApi.usage({ days, cursor });
  const gb = (bytes: number) => format.number(bytes / 1024 ** 3, { maximumFractionDigits: 2 });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
        <div className="flex items-center gap-3 text-sm">
          {['30', '90'].map((d) => (
            <Link
              key={d}
              href={`/admin/usage?days=${d}`}
              className={`rounded-full border px-3 py-1 ${d === days ? 'bg-indigo-600 text-white' : 'bg-white'}`}
            >
              {t('days', { days: d })}
            </Link>
          ))}
          <a
            href={`/api/usage-export?${new URLSearchParams({ scope: 'instance', days })}`}
            className="text-indigo-600 underline"
            download
          >
            {t('csv')}
          </a>
        </div>
      </div>
      <p className="text-sm text-gray-600">
        {t('totals', {
          manifests: format.number(usage.totals.period.manifestRequests),
          deploys: format.number(usage.totals.period.deploys),
          storage: gb(usage.totals.storageBytes),
          days,
        })}
      </p>
      <div className="bg-white rounded-lg shadow-sm border border-gray-100 overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className={th}>{t('workspace')}</th>
              <th className={th}>{t('plan')}</th>
              <th className={th}>{t('manifests')}</th>
              <th className={th}>{t('deploys')}</th>
              <th className={th}>{t('storage')}</th>
              <th className={th}>{t('limits')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {usage.workspaces.map((w) => {
              const near = nearLimits(w);
              const sum = (field: 'manifestRequests' | 'deploys') =>
                w.daily.reduce((n, d) => n + d[field], 0);
              return (
                <tr key={w.slug}>
                  <td className={td}>
                    <Link
                      href={`/admin/workspaces/${w.slug}`}
                      className="font-medium text-gray-900"
                    >
                      {w.name}
                    </Link>
                    <div className="text-xs text-gray-500">{w.slug}</div>
                  </td>
                  <td className={`${td} capitalize`}>{w.plan}</td>
                  <td className={`${td} tabular-nums`}>{format.number(sum('manifestRequests'))}</td>
                  <td className={`${td} tabular-nums`}>{format.number(sum('deploys'))}</td>
                  <td className={`${td} tabular-nums`}>
                    {t('gb', { value: gb(w.current.storageBytes) })}
                  </td>
                  <td className={td}>
                    {near.length ? (
                      <span className="text-amber-700">
                        {near
                          .map((q) =>
                            t('near', {
                              quota: t(`quota.${q.quota}`),
                              percent: Math.round((q.share ?? 0) * 100),
                            })
                          )
                          .join(', ')}
                      </span>
                    ) : (
                      <span className="text-gray-400">
                        {quotaUse(w).every((q) => q.limit === null) ? t('unlimited') : t('ok')}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {usage.nextCursor && (
        <Link
          href={`/admin/usage?${new URLSearchParams({ days, cursor: usage.nextCursor })}`}
          className="text-sm text-indigo-600"
        >
          {t('next')}
        </Link>
      )}
    </div>
  );
}
