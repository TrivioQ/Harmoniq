// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { getTranslations } from 'next-intl/server';
import { ActionForm } from '@/components/ActionForm';
import { setPlanAction } from './actions';

/** PLN-01: an instance admin sets a workspace's or organization's plan. */
export async function PlanForm({
  target,
  plan,
}: {
  target: { kind: 'workspace' | 'org'; slug: string };
  plan: string;
}) {
  const t = await getTranslations('AdminPlans');
  return (
    <ActionForm
      action={setPlanAction.bind(null, target)}
      submitLabel={t('set')}
      variant="outline"
      className="flex gap-2 items-start"
    >
      <select
        name="plan"
        defaultValue={plan}
        aria-label={t('plan')}
        className="rounded-md border px-2 py-1 text-xs"
      >
        {(['hobby', 'startup', 'enterprise'] as const).map((p) => (
          <option key={p} value={p}>
            {t(p)}
          </option>
        ))}
      </select>
    </ActionForm>
  );
}
