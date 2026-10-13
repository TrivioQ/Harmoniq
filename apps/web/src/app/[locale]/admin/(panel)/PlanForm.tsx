// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { getFormatter, getTranslations } from 'next-intl/server';
import { ActionForm } from '@/components/ActionForm';
import { setPlanAction } from './actions';

const PLANS = ['hobby', 'startup', 'enterprise'] as const;
const field = 'rounded-md border px-2 py-1 text-xs';

/**
 * PLN-01, PLN-06: an instance admin sets a workspace's or organization's plan, optionally
 * as a trial that ends on a date, and per-tenant overrides of features and quotas.
 */
export async function PlanForm({
  target,
  plan,
  expiresAt = null,
  basePlan = null,
  overrides = null,
}: {
  target: { kind: 'workspace' | 'org'; slug: string };
  plan: string;
  expiresAt?: string | null;
  basePlan?: string | null;
  overrides?: Record<string, unknown> | null;
}) {
  const t = await getTranslations('AdminPlans');
  const format = await getFormatter();
  return (
    <ActionForm
      action={setPlanAction.bind(null, target)}
      submitLabel={t('set')}
      variant="outline"
      className="flex flex-col gap-2 items-start"
    >
      <select name="plan" defaultValue={plan} aria-label={t('plan')} className={field}>
        {PLANS.map((p) => (
          <option key={p} value={p}>
            {t(p)}
          </option>
        ))}
      </select>
      {expiresAt && (
        <span className="text-xs text-amber-700">
          {t('trialUntil', {
            date: format.dateTime(new Date(expiresAt), 'short'),
            base: t(basePlan ?? 'hobby'),
          })}
        </span>
      )}
      <details className="text-xs">
        <summary className="cursor-pointer text-gray-500">{t('advanced')}</summary>
        <div className="mt-2 space-y-2">
          <label className="flex flex-col gap-1">
            {t('expiresAt')}
            <input
              type="date"
              name="expiresAt"
              defaultValue={expiresAt?.slice(0, 10) ?? ''}
              className={field}
            />
          </label>
          <label className="flex flex-col gap-1">
            {t('basePlan')}
            <select name="basePlan" defaultValue={basePlan ?? ''} className={field}>
              <option value="">{t('previousPlan')}</option>
              {PLANS.map((p) => (
                <option key={p} value={p}>
                  {t(p)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            {t('overrides')}
            <textarea
              name="overrides"
              rows={3}
              defaultValue={overrides ? JSON.stringify(overrides) : ''}
              placeholder='{"limits":{"members":100},"features":{"saml":true}}'
              className={`${field} font-mono w-64`}
            />
            <span className="text-gray-500">{t('overridesHint')}</span>
          </label>
        </div>
      </details>
    </ActionForm>
  );
}
