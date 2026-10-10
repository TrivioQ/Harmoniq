// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { getTranslations } from 'next-intl/server';
import { ActionForm } from '@/components/ActionForm';
import { resetSettingAction } from './actions';

/** Where a setting comes from, and a way back to the environment's defaults (INST-16). */
export async function SettingSource({
  settingKey,
  source,
}: {
  settingKey: 'storage' | 'email' | 'auth' | 'branding';
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
    </div>
  );
}
