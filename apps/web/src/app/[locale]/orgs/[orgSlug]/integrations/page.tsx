// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { notFound } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { ActionForm } from '@/components/ActionForm';
import { orgApi } from '@/lib/orgApi';
import {
  createAuditSinkAction,
  createNotificationAction,
  createOrgWebhookAction,
  deleteAuditSinkAction,
  deleteNotificationAction,
  deleteOrgWebhookAction,
  testAuditSinkAction,
  testNotificationAction,
  toggleAuditSinkAction,
  toggleOrgWebhookAction,
} from '../../actions';

const input = 'rounded-md border px-3 py-1.5 text-sm bg-background';
const EVENTS = [
  'org.member.added',
  'org.member.removed',
  'org.member.role_changed',
  'org.workspace.created',
  'org.workspace.deleted',
  'org.key.created',
  'org.key.revoked',
  'org.policy.updated',
  'quota.warning',
  'quota.exceeded',
  'plan.changed',
  'deploy.approval_requested',
  'domain.verification_lost',
] as const;

/** Event checkboxes; none ticked means every event. */
async function EventPicker({ name = 'events' }: { name?: string }) {
  const t = await getTranslations('OrgIntegrations');
  return (
    <fieldset className="text-xs">
      <legend className="text-muted-foreground">{t('events')}</legend>
      <div className="mt-1 grid gap-x-4 gap-y-1 sm:grid-cols-2">
        {EVENTS.map((e) => (
          <label key={e} className="flex items-center gap-1">
            <input type="checkbox" name={name} value={e} />
            <code>{e}</code>
          </label>
        ))}
      </div>
      <p className="mt-1 text-muted-foreground">{t('allEvents')}</p>
    </fieldset>
  );
}

/** TAD-09/10, AUD-06: org webhooks, notification channels and audit sinks (org admins). */
export default async function OrgIntegrationsPage(props: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await props.params;
  const t = await getTranslations('OrgIntegrations');
  const format = await getFormatter();
  const home = await orgApi.home(orgSlug, { limit: '1' });
  if (home.role !== 'org_admin') notFound();
  const [{ endpoints }, { channels }, { sinks }] = await Promise.all([
    orgApi.webhooks(orgSlug),
    orgApi.notifications(orgSlug),
    orgApi.auditSinks(orgSlug),
  ]);
  const when = (iso: string | null) => (iso ? format.relativeTime(new Date(iso)) : t('never'));

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </div>

      {/* TAD-09 */}
      <section className="rounded-xl border bg-card p-4 space-y-3 max-w-4xl">
        <h2 className="font-semibold">{t('notifications')}</h2>
        <p className="text-xs text-muted-foreground">{t('notificationsHint')}</p>
        <ul className="divide-y text-sm">
          {channels.map((c) => (
            <li key={c.id} className="py-2 flex flex-wrap items-start justify-between gap-2">
              <div>
                <div className="font-medium">
                  {c.name}{' '}
                  <span className="text-xs text-muted-foreground">{t(`kind.${c.kind}`)}</span>
                </div>
                <div className="text-xs text-muted-foreground">
                  {c.target ?? t('webhookHidden')} · {c.events.join(', ')}
                </div>
                <div className="text-xs">
                  {c.lastError ? (
                    <span className="text-red-700">{t('lastError', { error: c.lastError })}</span>
                  ) : (
                    <span className="text-muted-foreground">
                      {t('lastSent', { when: when(c.lastSentAt) })}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex gap-2">
                <ActionForm
                  action={testNotificationAction.bind(null, orgSlug, c.id)}
                  submitLabel={t('test')}
                  variant="outline"
                />
                <ActionForm
                  action={deleteNotificationAction.bind(null, orgSlug, c.id)}
                  submitLabel={t('delete')}
                  confirm={t('deleteConfirm', { name: c.name })}
                  variant="danger"
                />
              </div>
            </li>
          ))}
          {channels.length === 0 && (
            <li className="py-2 text-muted-foreground">{t('noChannels')}</li>
          )}
        </ul>
        <details>
          <summary className="cursor-pointer text-sm font-medium">{t('addChannel')}</summary>
          <ActionForm
            action={createNotificationAction.bind(null, orgSlug)}
            submitLabel={t('add')}
            className="mt-3 space-y-3"
          >
            <div className="flex flex-wrap gap-2">
              <select
                name="kind"
                defaultValue="email"
                aria-label={t('kindLabel')}
                className={input}
              >
                {(['email', 'slack', 'teams'] as const).map((k) => (
                  <option key={k} value={k}>
                    {t(`kind.${k}`)}
                  </option>
                ))}
              </select>
              <input
                name="name"
                required
                placeholder={t('namePlaceholder')}
                aria-label={t('name')}
                className={input}
              />
              <input
                name="target"
                required
                placeholder={t('targetPlaceholder')}
                aria-label={t('target')}
                className={`${input} flex-1 min-w-64`}
              />
            </div>
            <EventPicker />
          </ActionForm>
        </details>
      </section>

      {/* TAD-10 */}
      <section className="rounded-xl border bg-card p-4 space-y-3 max-w-4xl">
        <h2 className="font-semibold">{t('webhooks')}</h2>
        <p className="text-xs text-muted-foreground">{t('webhooksHint')}</p>
        <ul className="divide-y text-sm">
          {endpoints.map((e) => (
            <li key={e.id} className="py-2 flex flex-wrap items-start justify-between gap-2">
              <div>
                <div className="font-mono text-xs break-all">{e.url}</div>
                <div className="text-xs text-muted-foreground">{e.events.join(', ')}</div>
                <div className="text-xs">
                  {e.paused && <span className="mr-2 text-amber-700">{t('paused')}</span>}
                  {e.lastDelivery ? (
                    <span className={e.lastDelivery.success ? 'text-green-700' : 'text-red-700'}>
                      {t('lastDelivery', {
                        status: e.lastDelivery.statusCode ?? '—',
                        when: when(e.lastDelivery.createdAt),
                      })}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">{t('noDeliveries')}</span>
                  )}
                </div>
              </div>
              <div className="flex gap-2">
                <ActionForm
                  action={toggleOrgWebhookAction.bind(null, orgSlug, e.id, !e.paused)}
                  submitLabel={e.paused ? t('resume') : t('pause')}
                  variant="outline"
                />
                <ActionForm
                  action={deleteOrgWebhookAction.bind(null, orgSlug, e.id)}
                  submitLabel={t('delete')}
                  confirm={t('deleteConfirm', { name: e.url })}
                  variant="danger"
                />
              </div>
            </li>
          ))}
          {endpoints.length === 0 && (
            <li className="py-2 text-muted-foreground">{t('noWebhooks')}</li>
          )}
        </ul>
        <details>
          <summary className="cursor-pointer text-sm font-medium">{t('addWebhook')}</summary>
          <ActionForm
            action={createOrgWebhookAction.bind(null, orgSlug)}
            submitLabel={t('add')}
            secretHint={t('secretOnce')}
            className="mt-3 space-y-3"
          >
            <input
              name="url"
              type="url"
              required
              placeholder="https://hooks.example.com/harmoniq"
              aria-label={t('url')}
              className={`${input} w-full max-w-xl`}
            />
            <EventPicker />
          </ActionForm>
        </details>
      </section>

      {/* AUD-06 */}
      <section className="rounded-xl border bg-card p-4 space-y-3 max-w-4xl">
        <h2 className="font-semibold">{t('sinks')}</h2>
        <p className="text-xs text-muted-foreground">{t('sinksHint')}</p>
        <ul className="divide-y text-sm">
          {sinks.map((s) => (
            <li key={s.id} className="py-2 flex flex-wrap items-start justify-between gap-2">
              <div>
                <div className="font-medium">
                  {s.name}{' '}
                  <span className="text-xs text-muted-foreground">{t(`sinkKind.${s.kind}`)}</span>
                  {!s.enabled && (
                    <span className="ml-2 text-xs text-amber-700">{t('disabled')}</span>
                  )}
                </div>
                <div className="font-mono text-xs text-muted-foreground break-all">{s.target}</div>
                <div className="text-xs">
                  {s.lastError ? (
                    <span className="text-red-700">
                      {t('sinkFailing', { failures: s.failures, error: s.lastError })}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">
                      {t('lastDelivered', { when: when(s.lastDeliveredAt) })}
                    </span>
                  )}
                  {s.deadLetters > 0 && (
                    <span className="ml-2 text-amber-700">
                      {t('deadLetters', { count: s.deadLetters })}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <ActionForm
                  action={testAuditSinkAction.bind(null, orgSlug, s.id)}
                  submitLabel={t('test')}
                  variant="outline"
                />
                <ActionForm
                  action={toggleAuditSinkAction.bind(null, orgSlug, s.id, !s.enabled)}
                  submitLabel={s.enabled ? t('disable') : t('enable')}
                  variant="outline"
                />
                <ActionForm
                  action={deleteAuditSinkAction.bind(null, orgSlug, s.id)}
                  submitLabel={t('delete')}
                  confirm={t('deleteConfirm', { name: s.name })}
                  variant="danger"
                />
              </div>
            </li>
          ))}
          {sinks.length === 0 && <li className="py-2 text-muted-foreground">{t('noSinks')}</li>}
        </ul>
        <details>
          <summary className="cursor-pointer text-sm font-medium">{t('addHttpsSink')}</summary>
          <ActionForm
            action={createAuditSinkAction.bind(null, orgSlug)}
            submitLabel={t('add')}
            secretHint={t('secretOnce')}
            className="mt-3 flex flex-wrap items-center gap-2"
          >
            <input type="hidden" name="kind" value="https" />
            <input
              name="name"
              required
              placeholder="SIEM"
              aria-label={t('name')}
              className={input}
            />
            <input
              name="url"
              type="url"
              required
              placeholder="https://siem.example.com/harmoniq"
              aria-label={t('url')}
              className={`${input} flex-1 min-w-64`}
            />
            <label className="text-xs flex items-center gap-1">
              <input type="checkbox" name="backfill" />
              {t('backfill')}
            </label>
          </ActionForm>
        </details>
        <details>
          <summary className="cursor-pointer text-sm font-medium">{t('addS3Sink')}</summary>
          <ActionForm
            action={createAuditSinkAction.bind(null, orgSlug)}
            submitLabel={t('add')}
            className="mt-3 grid gap-2 sm:grid-cols-2"
          >
            <input type="hidden" name="kind" value="s3" />
            <input
              name="name"
              required
              placeholder="Audit archive"
              aria-label={t('name')}
              className={input}
            />
            <input
              name="bucket"
              required
              placeholder="audit-logs"
              aria-label={t('bucket')}
              className={input}
            />
            <input
              name="region"
              required
              placeholder="eu-west-1"
              aria-label={t('region')}
              className={input}
            />
            <input
              name="prefix"
              placeholder="harmoniq/"
              aria-label={t('prefix')}
              className={input}
            />
            <input
              name="endpoint"
              type="url"
              placeholder={t('endpointPlaceholder')}
              aria-label={t('endpoint')}
              className={input}
            />
            <input
              name="accessKeyId"
              required
              placeholder={t('accessKeyId')}
              aria-label={t('accessKeyId')}
              className={input}
            />
            <input
              name="secretAccessKey"
              required
              type="password"
              autoComplete="off"
              placeholder={t('secretAccessKey')}
              aria-label={t('secretAccessKey')}
              className={input}
            />
            <label className="text-xs flex items-center gap-1">
              <input type="checkbox" name="backfill" />
              {t('backfill')}
            </label>
          </ActionForm>
        </details>
      </section>
    </>
  );
}
