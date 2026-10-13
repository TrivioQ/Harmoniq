// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { getFormatter, getTranslations } from 'next-intl/server';
import { ActionForm } from '@/components/ActionForm';
import { Link } from '@/i18n/routing';
import { adminApi } from '@/lib/adminApi';
import { retryJobAction, runJobAction } from '../actions';

const th = 'px-3 py-2 text-left text-xs font-medium text-gray-500';
const td = 'px-3 py-2 text-xs text-gray-700 align-top';

/** INST-28: background jobs: schedules, last runs, failures to retry, maintenance on demand. */
export default async function AdminJobsPage(props: { searchParams: Promise<{ queue?: string }> }) {
  const { queue } = await props.searchParams;
  const t = await getTranslations('AdminJobsPage');
  const format = await getFormatter();
  const [{ queueRunning, queues }, { jobs: failed }] = await Promise.all([
    adminApi.jobs(),
    adminApi.failedJobs(queue),
  ]);
  const when = (d: string | null) => (d ? format.dateTime(new Date(d), 'short') : '—');

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
      {!queueRunning && (
        <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-800">{t('notRunning')}</p>
      )}
      <div className="bg-white rounded-lg shadow-sm border border-gray-100 overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className={th}>{t('queue')}</th>
              <th className={th}>{t('schedule')}</th>
              <th className={th}>{t('lastRun')}</th>
              <th className={th}>{t('lastSuccess')}</th>
              <th className={th}>{t('lastFailure')}</th>
              <th className={th}>{t('waiting')}</th>
              <th className={th} />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {queues.map((q) => (
              <tr key={q.name}>
                <td className={`${td} font-mono`}>{q.name}</td>
                <td className={`${td} font-mono`}>{q.schedule ?? t('onDemand')}</td>
                <td className={td}>{when(q.lastRun)}</td>
                <td className={`${td} text-green-700`}>{when(q.lastSuccess)}</td>
                <td className={td}>
                  {q.failed > 0 ? (
                    <Link
                      href={`/admin/jobs?queue=${encodeURIComponent(q.name)}`}
                      className="text-red-700 hover:underline"
                    >
                      {when(q.lastFailure)} · {t('failedCount', { count: q.failed })}
                    </Link>
                  ) : (
                    when(q.lastFailure)
                  )}
                </td>
                <td className={td}>
                  {q.queued} / {q.active}
                </td>
                <td className={td}>
                  {q.runnable && queueRunning && (
                    <ActionForm
                      action={runJobAction.bind(null, q.name)}
                      submitLabel={t('runNow')}
                      variant="outline"
                      confirm={t('runConfirm', { queue: q.name })}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section className="space-y-2">
        <div className="flex items-baseline gap-3">
          <h2 className="text-lg font-semibold text-gray-900">
            {queue ? t('failedIn', { queue }) : t('failed')}
          </h2>
          {queue && (
            <Link href="/admin/jobs" className="text-sm text-indigo-700 hover:underline">
              {t('allQueues')}
            </Link>
          )}
        </div>
        {failed.length === 0 ? (
          <p className="text-sm text-gray-500">{t('noFailed')}</p>
        ) : (
          <ul className="bg-white rounded-lg shadow-sm border border-gray-100 divide-y">
            {failed.map((j) => (
              <li key={j.id} className="p-3 text-sm flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="font-mono text-xs">
                    {j.queue} · {j.id}
                  </div>
                  <div className="text-red-700 break-all">{j.error ?? '—'}</div>
                  <div className="text-xs text-gray-500">
                    {when(j.failedAt)} · {t('retries', { count: j.retries })}
                  </div>
                </div>
                {queueRunning && (
                  <ActionForm
                    action={retryJobAction.bind(null, j.id)}
                    submitLabel={t('retry')}
                    variant="outline"
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
