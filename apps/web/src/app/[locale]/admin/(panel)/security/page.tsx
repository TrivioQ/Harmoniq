// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/routing';
import { adminApi } from '@/lib/adminApi';

const card = 'bg-white p-4 rounded-lg shadow-sm border border-gray-100 space-y-2';
const PERIODS = ['1', '7', '30', '90'];

function List({
  title,
  empty,
  rows,
}: {
  title: string;
  empty: string;
  rows: Array<[string, string, string]>;
}) {
  return (
    <section className={card}>
      <h2 className="text-sm font-medium text-gray-700">{title}</h2>
      {rows.length === 0 ? (
        <p className="text-xs text-gray-500">{empty}</p>
      ) : (
        <table className="w-full text-xs">
          <tbody>
            {rows.map(([a, b, c], i) => (
              <tr key={i} className="border-t">
                <td className="py-1 font-mono break-all">{a}</td>
                <td className="py-1 text-right">{b}</td>
                <td className="py-1 text-right text-gray-500">{c}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** INST-39: failed sign-ins, rejected keys, rate limits and SCIM errors. */
export default async function AdminSecurityPage(props: {
  searchParams: Promise<{ days?: string }>;
}) {
  const { days } = await props.searchParams;
  const t = await getTranslations('AdminSecurityPage');
  const format = await getFormatter();
  const r = await adminApi.security(days);
  const when = (d: string | null) => (d ? format.dateTime(new Date(d), 'short') : '—');
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
      <nav className="flex gap-2 text-sm" aria-label={t('period')}>
        {PERIODS.map((p) => (
          <Link
            key={p}
            href={`/admin/security?days=${p}`}
            className={`rounded-md border px-2 py-1 ${String(r.days) === p ? 'bg-indigo-50 text-indigo-700' : 'bg-white'}`}
          >
            {t('days', { count: Number(p) })}
          </Link>
        ))}
      </nav>
      <p className="text-sm text-gray-700">
        {t('summary', { succeeded: r.signIns.succeeded, failed: r.signIns.failed })}
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        <List
          title={t('failedByIp')}
          empty={t('none')}
          rows={r.failedByIp.map((x) => [x.ip ?? '—', String(x.failures), when(x.lastAt)])}
        />
        <List
          title={t('failedByEmail')}
          empty={t('none')}
          rows={r.failedByEmail.map((x) => [x.email ?? '—', String(x.failures), when(x.lastAt)])}
        />
        <List
          title={t('rejectedKeys')}
          empty={t('none')}
          rows={r.rejectedKeys.map((k) => [
            `${k.prefix ?? '?'} (${k.reason === 'expired' ? t('expired') : t('revoked')})`,
            String(k.attempts),
            when(k.lastAt),
          ])}
        />
        <List
          title={t('rateLimited')}
          empty={t('none')}
          rows={r.rateLimitedWorkspaces.map((w) => [w.workspace, String(w.requests), ''])}
        />
      </div>
      <section className={card}>
        <h2 className="text-sm font-medium text-gray-700">{t('scimErrors')}</h2>
        {r.scimErrors.length === 0 ? (
          <p className="text-xs text-gray-500">{t('none')}</p>
        ) : (
          <table className="w-full text-xs">
            <tbody>
              {r.scimErrors.map((e, i) => (
                <tr key={i} className="border-t">
                  <td className="py-1">{when(e.createdAt)}</td>
                  <td className="py-1">{e.tenant.slug ?? '—'}</td>
                  <td className="py-1 font-mono">{e.operation}</td>
                  <td className="py-1 text-red-700">{e.statusCode}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className={card}>
        <h2 className="text-sm font-medium text-gray-700">{t('recentFailures')}</h2>
        {r.recentFailures.length === 0 ? (
          <p className="text-xs text-gray-500">{t('none')}</p>
        ) : (
          <table className="w-full text-xs">
            <tbody>
              {r.recentFailures.map((f, i) => (
                <tr key={i} className="border-t">
                  <td className="py-1 whitespace-nowrap">{when(f.createdAt)}</td>
                  <td className="py-1 break-all">{f.email ?? '—'}</td>
                  <td className="py-1">{f.method}</td>
                  <td className="py-1 font-mono">{f.reason ?? '—'}</td>
                  <td className="py-1 font-mono">{f.ip ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
