// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/routing';
import { workspaceApi, ManifestDiffResult } from '@/lib/workspaceApi';

const DIFFED_SNAPSHOTS = 10;

/** DIFF-03: every manifest change in one environment, with what it changed. */
export default async function EnvironmentHistoryPage(props: {
  params: Promise<{ workspaceSlug: string; hostApp: string; env: string }>;
}) {
  const { workspaceSlug, hostApp, env } = await props.params;
  const t = await getTranslations('EnvironmentHistory');
  const format = await getFormatter();
  const { snapshots } = await workspaceApi.snapshots(workspaceSlug, hostApp, env);

  // Each snapshot is diffed against the one before it (the oldest has no predecessor).
  const diffs = await Promise.all(
    snapshots
      .slice(0, DIFFED_SNAPSHOTS)
      .map((snap, i) =>
        snapshots[i + 1]
          ? workspaceApi.diff(workspaceSlug, hostApp, env, snapshots[i + 1].id, snap.id)
          : Promise.resolve<ManifestDiffResult | null>(null)
      )
  );

  return (
    <div className="container p-6 md:p-10 max-w-5xl space-y-6">
      <div>
        <Link
          href={`/w/${workspaceSlug}/environments`}
          className="text-sm text-muted-foreground hover:underline"
        >
          ← {t('back')}
        </Link>
        <h2 className="text-3xl font-bold tracking-tight mt-2">{t('title', { hostApp, env })}</h2>
      </div>

      <ol className="space-y-3">
        {snapshots.map((snap, i) => {
          const diff = diffs[i];
          return (
            <li key={snap.id} className="rounded-xl border bg-card p-4 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="font-medium">{snap.cause?.action ?? t('unknownChange')}</span>
                <time className="text-muted-foreground" dateTime={snap.createdAt}>
                  {format.dateTime(new Date(snap.createdAt), {
                    dateStyle: 'medium',
                    timeStyle: 'medium',
                  })}
                </time>
              </div>
              {diff && (
                <ul className="text-sm font-mono space-y-0.5">
                  {diff.added.map((m) => (
                    <li key={`a-${m.name}`} className="text-green-700">
                      + {m.name} {m.version}
                    </li>
                  ))}
                  {diff.removed.map((m) => (
                    <li key={`r-${m.name}`} className="text-red-700">
                      − {m.name} {m.version}
                    </li>
                  ))}
                  {diff.changed.map((c) => (
                    <li key={`c-${c.name}`} className="text-amber-800">
                      ~ {c.name} {c.from.version} → {c.to.version}
                    </li>
                  ))}
                  {!diff.added.length && !diff.removed.length && !diff.changed.length && (
                    <li className="text-muted-foreground">{t('noChange')}</li>
                  )}
                </ul>
              )}
              <p className="text-xs text-muted-foreground font-mono">{snap.etag}</p>
            </li>
          );
        })}
        {snapshots.length === 0 && <p className="text-muted-foreground">{t('empty')}</p>}
      </ol>
    </div>
  );
}
