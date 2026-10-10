// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { getFormatter, getTranslations } from 'next-intl/server';
import { ActionForm } from '@/components/ActionForm';
import { workspaceApi } from '@/lib/workspaceApi';
import {
  createWebhookAction,
  deleteWebhookAction,
  retryDeadLetterAction,
  setWebhookPausedAction,
} from '../../actions';

const EVENTS = [
  'manifest.updated',
  'manifest.publish_failed',
  'deploy.success',
  'rollback.executed',
  'module.promoted',
  'canary.started',
  'canary.updated',
  'canary.promoted',
  'canary.rolled_back',
  'canary.auto_rolled_back',
  'module.auto_rolled_back',
  'alert.triggered',
  'alert.resolved',
  'env.frozen',
  'env.unfrozen',
];

export default async function WebhooksPage(props: { params: Promise<{ workspaceSlug: string }> }) {
  const { workspaceSlug } = await props.params;
  const t = await getTranslations('WebhooksPage');
  const format = await getFormatter();
  const [{ endpoints }, { deadLetters }] = await Promise.all([
    workspaceApi.webhooks(workspaceSlug),
    workspaceApi.deadLetters(workspaceSlug),
  ]);

  return (
    <div className="space-y-6">
      <section className="rounded-xl border bg-card p-6 space-y-3">
        <h3 className="font-semibold">{t('add')}</h3>
        <ActionForm
          action={createWebhookAction.bind(null, workspaceSlug)}
          submitLabel={t('addSubmit')}
          secretHint={t('secretHint')}
        >
          <input
            name="url"
            type="url"
            required
            placeholder="https://hooks.example.com/harmoniq"
            aria-label={t('url')}
            className="block w-full max-w-lg rounded-md border px-3 py-1.5 text-sm"
          />
          <fieldset className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            <legend className="text-xs text-muted-foreground mb-1">{t('eventsHint')}</legend>
            {EVENTS.map((event) => (
              <label key={event} className="flex items-center gap-1">
                <input type="checkbox" name="events" value={event} />
                <span className="font-mono text-xs">{event}</span>
              </label>
            ))}
          </fieldset>
        </ActionForm>
      </section>

      <ul className="rounded-xl border bg-card divide-y">
        {endpoints.map((endpoint) => (
          <li key={endpoint.id} className="p-4 flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="font-mono text-sm break-all">{endpoint.url}</div>
              <div className="text-xs text-muted-foreground">
                {endpoint.events.join(', ')}
                {endpoint.paused && ` · ${t('paused')}`}
              </div>
            </div>
            <div className="flex gap-2">
              <ActionForm
                action={setWebhookPausedAction.bind(
                  null,
                  workspaceSlug,
                  endpoint.id,
                  !endpoint.paused
                )}
                submitLabel={endpoint.paused ? t('resume') : t('pause')}
                variant="outline"
              />
              <ActionForm
                action={deleteWebhookAction.bind(null, workspaceSlug, endpoint.id)}
                submitLabel={t('delete')}
                variant="danger"
                confirm={t('deleteConfirm')}
              />
            </div>
          </li>
        ))}
        {endpoints.length === 0 && (
          <li className="p-6 text-sm text-muted-foreground">{t('empty')}</li>
        )}
      </ul>

      <section className="space-y-2">
        <h3 className="font-semibold">{t('deadLetters')}</h3>
        <ul className="rounded-xl border bg-card divide-y">
          {deadLetters.map((dl) => (
            <li key={dl.id} className="p-4 flex items-center justify-between gap-4 text-sm">
              <div>
                <span className="font-mono">{dl.event}</span>
                <span className="text-muted-foreground">
                  {' · '}
                  {t('failedAfter', {
                    attempts: dl.totalAttempts,
                    status: dl.finalStatusCode ?? '—',
                  })}
                  {' · '}
                  {format.relativeTime(new Date(dl.exhaustedAt))}
                </span>
              </div>
              <ActionForm
                action={retryDeadLetterAction.bind(null, workspaceSlug, dl.id)}
                submitLabel={t('retry')}
                variant="outline"
              />
            </li>
          ))}
          {deadLetters.length === 0 && (
            <li className="p-6 text-sm text-muted-foreground">{t('noDeadLetters')}</li>
          )}
        </ul>
      </section>
    </div>
  );
}
