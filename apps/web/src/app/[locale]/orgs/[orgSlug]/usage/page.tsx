// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/routing';
import { QuotaBars, Trend } from '@/components/UsageMeters';
import { orgApi } from '@/lib/orgApi';
import { nearLimits } from '@/lib/usage';

const PERIODS = [30, 90] as const;

/** TAD-02, USG-03: usage against quotas per workspace, trends and CSV (admins, billing, auditors). */
export default async function OrgUsagePage(props: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ days?: string }>;
}) {
  const { orgSlug } = await props.params;
  const days = (await props.searchParams).days === '90' ? 90 : 30;
  const t = await getTranslations('OrgUsage');
  const format = await getFormatter();
  const usage = await orgApi.usage(orgSlug, days);
  const workspaceLimit = usage.limits.workspaces;
  const gb = (bytes: number) => format.number(bytes / 1024 ** 3, { maximumFractionDigits: 2 });

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('plan', { plan: usage.plan })}
            {usage.planExpiresAt &&
              ` · ${t('trialUntil', { date: format.dateTime(new Date(usage.planExpiresAt), 'short') })}`}
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          {PERIODS.map((p) => (
            <Link
              key={p}
              href={`/orgs/${orgSlug}/usage?days=${p}`}
              className={`rounded-full border px-3 py-1 ${p === days ? 'bg-primary text-primary-foreground' : ''}`}
            >
              {t('days', { days: p })}
            </Link>
          ))}
          <a
            href={`/api/usage-export?${new URLSearchParams({ scope: 'org', slug: orgSlug, days: String(days) })}`}
            className="underline hover:text-primary"
            download
          >
            {t('csv')}
          </a>
        </div>
      </div>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          [
            t('workspaces'),
            workspaceLimit === null
              ? format.number(usage.totals.workspaces)
              : t('ofLimit', { used: usage.totals.workspaces, limit: workspaceLimit }),
          ],
          [t('members'), format.number(usage.totals.members)],
          [t('storage'), t('gb', { value: gb(usage.totals.storageBytes) })],
          [t('deploysThisMonth'), format.number(usage.totals.deploysPerMonth)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl border bg-card p-4">
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="text-xl font-semibold tabular-nums">{value}</div>
          </div>
        ))}
      </section>

      <section className="rounded-xl border bg-card p-4 grid gap-4 md:grid-cols-3">
        {(['manifestRequests', 'deploys', 'healthEvents'] as const).map((field) => (
          <Trend
            key={field}
            field={field}
            days={days}
            daily={Object.values(
              usage.workspaces
                .flatMap((w) => w.daily)
                .reduce<Record<string, (typeof usage.workspaces)[number]['daily'][number]>>(
                  (acc, d) => {
                    const sum = (acc[d.day] ??= {
                      ...d,
                      manifestRequests: 0,
                      deploys: 0,
                      healthEvents: 0,
                    });
                    sum.manifestRequests += d.manifestRequests;
                    sum.deploys += d.deploys;
                    sum.healthEvents += d.healthEvents;
                    return acc;
                  },
                  {}
                )
            )}
          />
        ))}
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        {usage.workspaces.map((w) => {
          const near = nearLimits(w);
          return (
            <section key={w.slug} className="rounded-xl border bg-card p-4 space-y-3">
              <div className="flex justify-between gap-2">
                <Link href={`/w/${w.slug}`} className="font-semibold text-sm hover:text-primary">
                  {w.name}
                </Link>
                <span className="text-xs text-muted-foreground capitalize">{w.plan}</span>
              </div>
              {near.length > 0 && (
                <p className="text-xs text-amber-800">{t('nearLimit', { count: near.length })}</p>
              )}
              <QuotaBars usage={w} />
              <Trend daily={w.daily} field="manifestRequests" days={days} />
            </section>
          );
        })}
        {usage.workspaces.length === 0 && (
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        )}
      </div>
    </>
  );
}
