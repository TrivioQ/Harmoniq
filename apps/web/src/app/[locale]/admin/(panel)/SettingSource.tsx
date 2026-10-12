// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { getTranslations } from 'next-intl/server';
import { ActionForm } from '@/components/ActionForm';
import { Link } from '@/i18n/routing';
import type { SettingKey } from '@/lib/adminApi';
import { resetSettingAction } from './actions';

/**
 * Where a setting comes from, a way back to the environment's defaults (INST-16) and its
 * saved versions (INST-35).
 */
export async function SettingSource({
  settingKey,
  source,
}: {
  settingKey: SettingKey;
  source: 'database' | 'environment';
}) {
  const t = await getTranslations('AdminSettings');
  return (
    <div className="flex items-center gap-4 text-sm text-gray-600">
      <span>{source === 'database' ? t('fromDatabase') : t('fromEnvironment')}</span>
      {source === 'database' && (
        <ActionForm
          action={resetSettingAction.bind(null, settingKey)}
          submitLabel={t('reset')}
          variant="outline"
          confirm={t('resetConfirm')}
        />
      )}
      <Link href={`/admin/settings/${settingKey}`} className="text-indigo-700 hover:underline">
        {t('history')}
      </Link>
    </div>
  );
}
