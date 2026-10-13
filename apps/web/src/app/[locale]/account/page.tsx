// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { getFormatter, getTranslations } from 'next-intl/server';
import type { SessionSummary } from '@harmoniq/core/dist/schemas/AuthSchemas';
import { ActionForm } from '@/components/ActionForm';
import { authedFetch } from '@/lib/registry';
import {
  disableMfaAction,
  endOtherSessionsAction,
  endSessionAction,
  newRecoveryCodesAction,
  startMfaSetupAction,
} from './actions';

const input = 'rounded-md border px-3 py-1.5 text-sm font-mono w-32';

/** A short description of a browser from its user agent. */
function browserOf(agent: string | null) {
  if (!agent) return null;
  const browser = /Edg\//.test(agent)
    ? 'Edge'
    : /Firefox\//.test(agent)
      ? 'Firefox'
      : /Chrome\//.test(agent)
        ? 'Chrome'
        : /Safari\//.test(agent)
          ? 'Safari'
          : null;
  const os = /Windows/.test(agent)
    ? 'Windows'
    : /Mac OS X|Macintosh/.test(agent)
      ? 'macOS'
      : /Android/.test(agent)
        ? 'Android'
        : /iPhone|iPad/.test(agent)
          ? 'iOS'
          : /Linux/.test(agent)
            ? 'Linux'
            : null;
  return [browser, os].filter(Boolean).join(' · ') || agent.slice(0, 60);
}

/** SES-02/03: sessions and multi-factor authentication. */
export default async function AccountPage() {
  const t = await getTranslations('AccountPage');
  const format = await getFormatter();
  const [{ sessions }, mfa] = await Promise.all([
    authedFetch<{ sessions: SessionSummary[] }>('/api/me/sessions'),
    authedFetch<{
      enabled: boolean;
      enabledAt: string | null;
      recoveryCodesLeft: number;
      sessionVerified: boolean;
    }>('/api/me/mfa'),
  ]);

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>

      <section className="rounded-xl border bg-card p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">{t('sessions')}</h2>
          {sessions.length > 1 && (
            <ActionForm
              action={endOtherSessionsAction}
              submitLabel={t('endOthers')}
              confirm={t('endOthersConfirm')}
              variant="outline"
            />
          )}
        </div>
        <ul className="divide-y text-sm">
          {sessions.map((s) => (
            <li key={s.id} className="py-2 flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="font-medium">
                  {browserOf(s.userAgent) ?? t('unknownBrowser')}
                  {s.current && (
                    <span className="ml-2 rounded bg-green-100 px-1.5 py-0.5 text-xs text-green-800">
                      {t('thisSession')}
                    </span>
                  )}
                  {s.mfa && (
                    <span className="ml-2 rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-800">
                      {t('mfaVerified')}
                    </span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">
                  {[
                    s.provider && t('via', { provider: s.provider }),
                    s.ip,
                    t('lastActive', { when: format.relativeTime(new Date(s.lastActiveAt)) }),
                    t('signedIn', { when: format.dateTime(new Date(s.createdAt), 'short') }),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              </div>
              {!s.current && (
                <ActionForm
                  action={endSessionAction.bind(null, s.id)}
                  submitLabel={t('end')}
                  variant="outline"
                />
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-xl border bg-card p-4 space-y-3">
        <h2 className="font-semibold">{t('mfa')}</h2>
        {mfa.enabled ? (
          <>
            <p className="text-sm">
              {t('mfaOn', {
                date: format.dateTime(new Date(mfa.enabledAt!), 'short'),
                left: mfa.recoveryCodesLeft,
              })}
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <h3 className="text-sm font-medium">{t('newCodes')}</h3>
                <ActionForm
                  action={newRecoveryCodesAction}
                  submitLabel={t('newCodesSubmit')}
                  secretHint={t('codesOnce')}
                  variant="outline"
                  className="flex flex-wrap gap-2"
                >
                  <input
                    name="code"
                    required
                    aria-label={t('code')}
                    placeholder="123456"
                    className={input}
                  />
                </ActionForm>
              </div>
              <div className="space-y-1">
                <h3 className="text-sm font-medium">{t('turnOff')}</h3>
                <ActionForm
                  action={disableMfaAction}
                  submitLabel={t('turnOffSubmit')}
                  confirm={t('turnOffConfirm')}
                  variant="danger"
                  className="flex flex-wrap gap-2"
                >
                  <input
                    name="code"
                    required
                    aria-label={t('code')}
                    placeholder="123456"
                    className={input}
                  />
                </ActionForm>
              </div>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">{t('mfaOff')}</p>
            <ActionForm action={startMfaSetupAction} submitLabel={t('setUp')} />
          </>
        )}
      </section>
    </>
  );
}
