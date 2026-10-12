// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/routing';
import { orgApi } from '@/lib/orgApi';
import { AuditExportLinks } from '@/components/AuditExportLinks';

const input = 'rounded-md border px-3 py-1.5 text-sm';

/** ORG-09: one audit log across the organization's workspaces. */
export default async function OrgAuditPage(props: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ workspace?: string; action?: string; cursor?: string }>;
}) {
  const { orgSlug } = await props.params;
  const query = await props.searchParams;
  const t = await getTranslations('OrgAudit');
  const format = await getFormatter();
  const [{ events, nextCursor }, home] = await Promise.all([
    orgApi.audit(orgSlug, { ...query, limit: '50' }),
    orgApi.home(orgSlug),
  ]);
  const next = new URLSearchParams(
    Object.entries({ ...query, cursor: nextCursor ?? undefined }).filter(
      (e): e is [string, string] => !!e[1]
    )
  );

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
      <AuditExportLinks
        scope="org"
        slug={orgSlug}
        action={query.action}
        workspace={query.workspace}
      />
      {/* TLC-07: the organization and its live workspaces, everything, as JSON Lines. */}
      <a
        href={`/api/tenant-export?${new URLSearchParams({ scope: 'org', slug: orgSlug })}`}
        className="text-sm underline hover:text-primary"
        download
      >
        {t('fullExport')}
      </a>
      <form className="flex flex-wrap gap-2" method="get">
        <select
          name="workspace"
          defaultValue={query.workspace ?? ''}
          className={input}
          aria-label={t('workspace')}
        >
          <option value="">{t('allWorkspaces')}</option>
          {home.workspaces.map((w) => (
            <option key={w.slug} value={w.slug}>
              {w.name}
            </option>
          ))}
        </select>
        <input
          name="action"
          defaultValue={query.action}
          placeholder="module.deploy"
          aria-label={t('action')}
          className={`${input} font-mono`}
        />
        <button type="submit" className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted">
          {t('filter')}
        </button>
      </form>
      <section className="rounded-xl border bg-card">
        <table className="w-full text-sm">
          <tbody>
            {events.map((e) => (
              <tr key={e.id} className="border-t first:border-t-0">
                <td className="p-3 whitespace-nowrap text-muted-foreground">
                  {format.dateTime(new Date(e.createdAt), 'short')}
                </td>
                <td className="p-3">{e.workspace ?? <em>{t('organization')}</em>}</td>
                <td className="p-3 font-mono">{e.action}</td>
                <td className="p-3 text-xs text-muted-foreground">
                  {e.actorType}:{e.actorId}
                </td>
              </tr>
            ))}
            {events.length === 0 && (
              <tr>
                <td className="p-6 text-center text-muted-foreground">{t('empty')}</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
      {nextCursor && (
        <Link href={`/orgs/${orgSlug}/audit?${next}`} className="text-sm hover:text-primary">
          {t('older')} →
        </Link>
      )}
    </>
  );
}
