import { getTranslations } from 'next-intl/server';
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

/** INST-08: database, cache, storage and job queue. */
export default async function AdminHealthPage() {
  const t = await getTranslations('AdminHealthPage');
  const { status, checks } = await adminApi.health();
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
      <section className={card}>
        <h2 className="text-sm font-medium text-gray-700">{t('queue')}</h2>
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
