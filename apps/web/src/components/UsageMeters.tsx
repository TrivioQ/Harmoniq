// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { getFormatter, getTranslations } from 'next-intl/server';
import { type DailyUsage, type WorkspaceUsage, WARN_AT, dailySeries, quotaUse } from '@/lib/usage';

// TAD-02, PLN-05: usage against quotas as bars, and daily trends.

/** One bar per quota; amber from 80%, red at the limit. */
export async function QuotaBars({ usage }: { usage: WorkspaceUsage }) {
  const t = await getTranslations('Usage');
  const format = await getFormatter();
  return (
    <ul className="space-y-2">
      {quotaUse(usage).map((q) => {
        const pct = q.share === null ? 0 : Math.min(100, Math.round(q.share * 100));
        const tone =
          q.share === null
            ? 'bg-muted-foreground/30'
            : q.share >= 1
              ? 'bg-red-600'
              : q.share >= WARN_AT
                ? 'bg-amber-500'
                : 'bg-primary';
        const used =
          q.quota === 'storageGb'
            ? format.number(q.used, { maximumFractionDigits: 2 })
            : format.number(q.used);
        return (
          <li key={q.quota} className="text-sm">
            <div className="flex justify-between gap-2">
              <span>{t(`quota.${q.quota}`)}</span>
              <span className="text-muted-foreground tabular-nums">
                {q.limit === null
                  ? t('unlimited', { used })
                  : t('ofLimit', { used, limit: format.number(q.limit) })}
              </span>
            </div>
            <div
              className="mt-1 h-1.5 w-full rounded bg-muted"
              role="progressbar"
              aria-label={t(`quota.${q.quota}`)}
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className={`h-1.5 rounded ${tone}`}
                style={{ width: `${q.limit === null ? 0 : pct}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** A small bar chart of one daily counter. */
export async function Trend({
  daily,
  field,
  days,
}: {
  daily: DailyUsage[];
  field: 'manifestRequests' | 'deploys' | 'healthEvents';
  days: number;
}) {
  const t = await getTranslations('Usage');
  const format = await getFormatter();
  const series = dailySeries(daily, field, days);
  const max = Math.max(1, ...series.map((s) => s.value));
  const total = series.reduce((n, s) => n + s.value, 0);
  const w = 3;
  return (
    <figure className="space-y-1">
      <figcaption className="flex justify-between text-xs text-muted-foreground">
        <span>{t(`trend.${field}`)}</span>
        <span className="tabular-nums">{format.number(total)}</span>
      </figcaption>
      <svg
        viewBox={`0 0 ${series.length * (w + 1)} 32`}
        className="h-8 w-full"
        preserveAspectRatio="none"
        role="img"
        aria-label={t('trendLabel', { what: t(`trend.${field}`), total, days })}
      >
        {series.map((s, i) => {
          const h = Math.max(s.value ? 1 : 0, Math.round((s.value / max) * 32));
          return (
            <rect
              key={s.day}
              x={i * (w + 1)}
              y={32 - h}
              width={w}
              height={h}
              className="fill-primary/70"
            >
              <title>{`${s.day}: ${s.value}`}</title>
            </rect>
          );
        })}
      </svg>
    </figure>
  );
}
