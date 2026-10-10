// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { getFormatter, getTranslations } from 'next-intl/server';
import { ActionForm } from '@/components/ActionForm';
import { workspaceApi } from '@/lib/workspaceApi';
import { createAlertAction, deleteAlertAction, setAlertEnabledAction } from '../../actions';

const CONDITIONS = [
  'canary_error_rate',
  'canary_error_rate_delta',
  'canary_load_p95ms',
  'load_success_rate',
  'load_p95ms',
  'webhook_failure_rate',
] as const;

const input = 'block rounded-md border px-3 py-1.5 text-sm';

export default async function AlertsPage(props: { params: Promise<{ workspaceSlug: string }> }) {
  const { workspaceSlug } = await props.params;
  const t = await getTranslations('AlertsPage');
  const format = await getFormatter();
  const [{ rules }, { modules }] = await Promise.all([
    workspaceApi.alerts(workspaceSlug),
    workspaceApi.modules(workspaceSlug),
  ]);
  const targets = modules.flatMap((m) =>
    m.environments.map((e) => ({ value: `${m.id}|${e.slug}`, label: `${m.name} · ${e.name}` }))
  );
  const formatValue = (condition: string, value: number) =>
    condition.endsWith('ms')
      ? `${Math.round(value)} ms`
      : format.number(value, { style: 'percent', maximumFractionDigits: 1 });

  return (
    <div className="space-y-6">
      <section className="rounded-xl border bg-card p-6 space-y-3">
        <h3 className="font-semibold">{t('add')}</h3>
        <ActionForm
          action={createAlertAction.bind(null, workspaceSlug)}
          submitLabel={t('create')}
          className="grid gap-3 sm:grid-cols-2 max-w-3xl"
        >
          <label className="text-sm space-y-1">
            <span>{t('name')}</span>
            <input name="name" required maxLength={100} className={`${input} w-full`} />
          </label>
          <label className="text-sm space-y-1">
            <span>{t('target')}</span>
            <select name="target" className={`${input} w-full`}>
              {targets.map((target) => (
                <option key={target.value} value={target.value}>
                  {target.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm space-y-1">
            <span>{t('condition')}</span>
            <select name="condition" className={`${input} w-full`}>
              {CONDITIONS.map((c) => (
                <option key={c} value={c}>
                  {t(`conditions.${c}`)}
                  {c === 'webhook_failure_rate' && ` ${t('workspaceWide')}`}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm space-y-1">
            <span>{t('threshold')}</span>
            <input
              name="threshold"
              type="number"
              min={0}
              step="any"
              required
              defaultValue={0.05}
              className={`${input} w-full`}
            />
            <span className="block text-xs text-muted-foreground">{t('thresholdHint')}</span>
          </label>
          <label className="text-sm space-y-1">
            <span>{t('action')}</span>
            <select name="action" className={`${input} w-full`}>
              <option value="webhook">{t('actions.webhook')}</option>
              <option value="auto_rollback">{t('actions.auto_rollback')}</option>
            </select>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm space-y-1">
              <span>{t('windowMinutes')}</span>
              <input
                name="windowMinutes"
                type="number"
                min={1}
                max={60}
                defaultValue={5}
                className={`${input} w-full`}
              />
            </label>
            <label className="text-sm space-y-1">
              <span>{t('minSamples')}</span>
              <input
                name="minSamples"
                type="number"
                min={1}
                defaultValue={20}
                className={`${input} w-full`}
              />
            </label>
          </div>
        </ActionForm>
        <p className="text-xs text-muted-foreground">{t('webhookHint')}</p>
      </section>

      <ul className="rounded-xl border bg-card divide-y">
        {rules.map((rule) => (
          <li key={rule.id} className="p-4 flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="font-medium">{rule.name}</span>
                <span
                  className={`rounded px-2 py-0.5 text-xs ${
                    !rule.enabled
                      ? 'bg-muted text-muted-foreground'
                      : rule.state === 'firing'
                        ? 'bg-red-100 text-red-800'
                        : 'bg-green-100 text-green-800'
                  }`}
                >
                  {!rule.enabled ? t('disabled') : t(rule.state)}
                </span>
              </div>
              <div className="text-sm text-muted-foreground">
                {rule.module && `${rule.module.slug} · ${rule.environment} · `}
                {t(`conditions.${rule.condition as (typeof CONDITIONS)[number]}`)}{' '}
                {formatValue(rule.condition, rule.threshold)} → {t(`actions.${rule.action}`)}
              </div>
              <div className="text-xs text-muted-foreground">
                {rule.lastValue === null
                  ? t('noData')
                  : t('lastValue', { value: formatValue(rule.condition, rule.lastValue) })}
                {rule.lastTriggeredAt &&
                  ` · ${t('lastTriggered', { when: format.relativeTime(new Date(rule.lastTriggeredAt)) })}`}
              </div>
              {rule.lastError && <div className="text-xs text-red-700">{rule.lastError}</div>}
            </div>
            <div className="flex gap-2">
              <ActionForm
                action={setAlertEnabledAction.bind(null, workspaceSlug, rule.id, !rule.enabled)}
                submitLabel={rule.enabled ? t('disable') : t('enable')}
                variant="outline"
              />
              <ActionForm
                action={deleteAlertAction.bind(null, workspaceSlug, rule.id)}
                submitLabel={t('delete')}
                variant="danger"
                confirm={t('deleteConfirm')}
              />
            </div>
          </li>
        ))}
        {rules.length === 0 && <li className="p-6 text-sm text-muted-foreground">{t('empty')}</li>}
      </ul>
    </div>
  );
}
