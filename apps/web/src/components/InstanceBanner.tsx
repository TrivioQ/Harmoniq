// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { getFormatter, getTranslations } from 'next-intl/server';
import { getInstance } from '@/lib/branding';

const styles = {
  info: 'bg-blue-50 text-blue-900 border-blue-200',
  warning: 'bg-amber-50 text-amber-900 border-amber-200',
  maintenance: 'bg-red-50 text-red-900 border-red-200',
};

/** INST-22, INST-37: the instance's announcement and maintenance, on every page. */
export async function InstanceBanner() {
  const { announcement, maintenance } = await getInstance();
  if (!announcement && !maintenance) return null;
  const t = await getTranslations('InstanceBanner');
  const format = await getFormatter();
  const at = (d: string) => format.dateTime(new Date(d), 'short');
  return (
    <div className="w-full">
      {maintenance && (
        <div role="status" className={`border-b px-4 py-2 text-sm ${styles.maintenance}`}>
          <strong>
            {maintenance.active
              ? maintenance.until
                ? t('maintenanceUntil', { until: at(maintenance.until) })
                : t('maintenanceNow')
              : t('maintenanceScheduled', {
                  from: at(maintenance.from!),
                  until: maintenance.until ? at(maintenance.until) : '—',
                })}
          </strong>
          {maintenance.message && <span className="ml-2">{maintenance.message}</span>}
        </div>
      )}
      {announcement && (
        <div role="status" className={`border-b px-4 py-2 text-sm ${styles[announcement.level]}`}>
          {announcement.message}
        </div>
      )}
    </div>
  );
}
