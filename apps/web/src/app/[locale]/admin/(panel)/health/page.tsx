// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/routing';
import { adminApi, type Check } from '@/lib/adminApi';

const card = 'bg-white p-5 rounded-lg shadow-sm border border-gray-100 space-y-1';

function Status({ check, label, detail }: { check: Check; label: string; detail?: string }) {
  return (
    <div className={card}>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-700">{label}</h3>
        <span className={`text-xs font-medium ${check.ok ? 'text-green-700' : 'text-red-700'}`}>
          {check.ok ? 'OK' : 'FAIL'}
        </span>
      </div>
      <p className="text-xs text-gray-500">
        {detail ? `${detail} · ` : ''}
        {check.latencyMs} ms
      </p>
      {check.error && <p className="text-xs text-red-700 break-all">{check.error}</p>}
    </div>
  );
}

/** Seconds as "3 d 4 h", "5 h 2 min" or "40 s". */
function duration(seconds: number) {
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d} d ${h} h`;
  if (h) return `${h} h ${m} min`;
  if (m) return `${m} min`;
  return `${seconds} s`;
}

/** INST-08, INST-28: database, cache, storage, job queue, build, migrations and replicas. */
export default async function AdminHealthPage() {
  const t = await getTranslations('AdminHealthPage');
  const format = await getFormatter();
  const [{ status, checks }, system] = await Promise.all([
    adminApi.health(),
    adminApi.system().catch(() => null),
  ]);
  const { queue } = checks;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
      <p className={`text-sm ${status === 'ok' ? 'text-green-700' : 'text-red-700'}`}>
        {status === 'ok' ? t('ok') : t('degraded')}
      </p>
      <div className="grid gap-4 md:grid-cols-3">
        <Status check={checks.database} label={t('database')} />
        <Status check={checks.cache} label={t('cache')} detail={checks.cache.adapter} />
        <Status check={checks.storage} label={t('storage')} detail={checks.storage.adapter} />
      </div>
      {system && (
        <>
          <section className={card}>
            <h2 className="text-sm font-medium text-gray-700">{t('system')}</h2>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs md:grid-cols-4">
              <dt className="text-gray-500">{t('version')}</dt>
              <dd className="font-mono">{system.build.version}</dd>
              <dt className="text-gray-500">{t('commit')}</dt>
              <dd className="font-mono">{system.build.commit?.slice(0, 12) ?? '—'}</dd>
              <dt className="text-gray-500">{t('node')}</dt>
              <dd className="font-mono">{system.build.node}</dd>
              <dt className="text-gray-500">{t('latestMigration')}</dt>
              <dd className="font-mono break-all">{system.migrations.latest ?? '—'}</dd>
            </dl>
            {system.migrations.pending === null ? (
              <p className="text-xs text-gray-500">{t('migrationsUnknown')}</p>
            ) : system.migrations.pending.length ? (
              <p role="alert" className="text-xs text-red-700">
                {t('migrationsPending', { list: system.migrations.pending.join(', ') })}
              </p>
            ) : (
              <p className="text-xs text-green-700">
                {t('migrationsCurrent', { count: system.migrations.applied })}
              </p>
            )}
            {system.migrations.failed.length > 0 && (
              <p role="alert" className="text-xs text-red-700">
                {t('migrationsFailed', { list: system.migrations.failed.join(', ') })}
              </p>
            )}
          </section>
          <section className={card}>
            <h2 className="text-sm font-medium text-gray-700">{t('replicas')}</h2>
            <table className="w-full text-xs mt-2">
              <thead>
                <tr className="text-left text-gray-500">
                  <th className="py-1">{t('replica')}</th>
                  <th className="py-1">{t('version')}</th>
                  <th className="py-1">{t('uptime')}</th>
                  <th className="py-1">{t('configAge')}</th>
                  <th className="py-1">{t('lastSeen')}</th>
                </tr>
              </thead>
              <tbody>
                {system.replicas.map((r) => (
                  <tr key={r.id} className="border-t">
                    <td className="py-1 font-mono">
                      {r.hostname ?? r.id.slice(0, 8)}
                      {r.self && <span className="ml-1 text-gray-500">({t('thisReplica')})</span>}
                    </td>
                    <td className="py-1 font-mono">
                      {r.version}
                      {r.commit && ` · ${r.commit.slice(0, 7)}`}
                    </td>
                    <td className="py-1">{duration(r.uptimeSeconds)}</td>
                    <td className="py-1">
                      {r.configAgeSeconds === null ? '—' : duration(r.configAgeSeconds)}
                    </td>
                    <td className={`py-1 ${r.live ? 'text-green-700' : 'text-red-700'}`}>
                      {format.dateTime(new Date(r.lastSeenAt), 'short')}
                      {!r.live && ` · ${t('gone')}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
      <section className={card}>
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-medium text-gray-700">{t('queue')}</h2>
          <Link href="/admin/jobs" className="text-xs text-indigo-700 hover:underline">
            {t('jobs')}
          </Link>
        </div>
        {!queue.running ? (
          <p className="text-xs text-gray-500">{t('queueInline')}</p>
        ) : (
          <>
            <p className="text-xs text-gray-500">
              {t('queueTotals', { queued: queue.queued, active: queue.active })}
            </p>
            {queue.error && <p className="text-xs text-red-700">{queue.error}</p>}
            <table className="w-full text-xs mt-2">
              <thead>
                <tr className="text-left text-gray-500">
                  <th className="py-1">{t('queueName')}</th>
                  <th className="py-1">{t('queued')}</th>
                  <th className="py-1">{t('active')}</th>
                </tr>
              </thead>
              <tbody>
                {queue.queues.map((q) => (
                  <tr key={q.name} className="border-t">
                    <td className="py-1 font-mono">{q.name}</td>
                    <td className="py-1">{q.queued}</td>
                    <td className="py-1">{q.active}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>
    </div>
  );
}
