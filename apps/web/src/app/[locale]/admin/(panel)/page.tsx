// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/routing';
import { adminApi } from '@/lib/adminApi';

export default async function AdminDashboardPage() {
  const t = await getTranslations('AdminDashboardPage');
  const health = await adminApi.health().catch(() => null);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
      {!health && <div className="p-4 bg-red-50 text-red-700 rounded-md">{t('errorFetch')}</div>}

      {health && (
        <>
          <Link
            href="/admin/health"
            className={`block p-4 rounded-md text-sm ${health.status === 'ok' ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'}`}
          >
            {health.status === 'ok' ? t('healthy') : t('degraded')}
          </Link>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {(
              [
                ['totalWorkspaces', health.stats.workspaces],
                ['totalModules', health.stats.modules],
                ['totalUsers', health.stats.users],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="bg-white p-6 rounded-lg shadow-sm border border-gray-100">
                <h3 className="text-sm font-medium text-gray-500">{t(label)}</h3>
                <p className="mt-2 text-3xl font-bold text-gray-900">{value}</p>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
