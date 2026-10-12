// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/routing';
import { orgApi } from '@/lib/orgApi';
import { AuditExportLinks } from '@/components/AuditExportLinks';
import {
  AuditActorLabel,
  AuditFilters,
  AuditMetadata,
  type AuditQuery,
  auditHref,
  auditRange,
} from '@/components/AuditView';

/** ORG-09, AUD-07/08: one audit log across the organization's workspaces. */
export default async function OrgAuditPage(props: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<AuditQuery>;
}) {
  const { orgSlug } = await props.params;
  const query = await props.searchParams;
  const t = await getTranslations('OrgAudit');
  const format = await getFormatter();
  const [{ events, nextCursor }, home] = await Promise.all([
    orgApi.audit(orgSlug, { ...query, ...auditRange(query), limit: '50' }),
    orgApi.home(orgSlug, { limit: '200' }),
  ]);

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
      <AuditFilters query={query} workspaces={home.workspaces} />
      <section className="rounded-xl border bg-card">
        <table className="w-full text-sm">
          <tbody>
            {events.map((e) => (
              <tr key={e.id} className="border-t first:border-t-0">
                <td className="p-3 whitespace-nowrap text-muted-foreground">
                  {format.dateTime(new Date(e.createdAt), 'short')}
                </td>
                <td className="p-3">{e.workspace ?? <em>{t('organization')}</em>}</td>
                <td className="p-3">
                  <span className="font-mono">{e.action}</span>
                  <AuditMetadata
                    metadata={e.metadata}
                    resource={`${e.resourceType} ${e.resourceId}`}
                  />
                </td>
                <td className="p-3 text-xs">
                  <AuditActorLabel {...e} />
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
        <Link
          href={auditHref(`/orgs/${orgSlug}/audit`, { ...query, cursor: nextCursor })}
          className="text-sm hover:text-primary"
        >
          {t('older')} →
        </Link>
      )}
    </>
  );
}
