// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/routing';
import { adminApi } from '@/lib/adminApi';
import { AuditExportLinks } from '@/components/AuditExportLinks';
import { ChainCheck } from '@/components/ChainCheck';
import {
  AuditActorLabel,
  AuditFilters,
  AuditMetadata,
  type AuditQuery,
  auditHref,
  auditRange,
} from '@/components/AuditView';

/** INST-18, AUD-07/08: instance changes, newest first. Values and secrets are never recorded. */
export default async function AdminAuditPage(props: {
  searchParams: Promise<AuditQuery & { verify?: string; who?: string }>;
}) {
  const query = await props.searchParams;
  const t = await getTranslations('AdminAuditPage');
  const format = await getFormatter();
  const [{ events, nextCursor }, everywhere] = await Promise.all([
    adminApi.audit({
      cursor: query.cursor,
      actor: query.actor,
      action: query.action,
      resourceType: query.resourceType,
      ...auditRange(query),
    }),
    // INST-36: one person across every workspace, organization and the instance (audited).
    query.who?.trim() ? adminApi.auditSearch({ actor: query.who.trim() }) : null,
  ]);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
      <AuditExportLinks scope="instance" />
      <ChainCheck
        href="/admin/audit?verify=1"
        reports={
          query.verify ? [{ label: t('instance'), ...(await adminApi.verifyAudit()) }] : null
        }
      />
      <AuditFilters query={query} actionPlaceholder="instance." resourceType />
      <section className="bg-white p-4 rounded-lg shadow-sm border border-gray-100 space-y-3">
        <h2 className="text-sm font-medium text-gray-700">{t('searchEverywhere')}</h2>
        <p className="text-xs text-gray-500">{t('searchEverywhereHint')}</p>
        <form className="flex gap-2">
          <input
            name="who"
            defaultValue={query.who}
            placeholder="person@example.com"
            aria-label={t('searchEverywhere')}
            className="rounded-md border px-3 py-1.5 text-sm w-72"
          />
          <button className="rounded-md border px-3 py-1.5 text-sm bg-white">{t('search')}</button>
        </form>
        {everywhere &&
          (everywhere.events.length === 0 ? (
            <p className="text-sm text-gray-500">{t('nothingFound')}</p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {everywhere.events.map((e) => (
                  <tr key={`${e.scope}-${e.id}`} className="border-t align-top">
                    <td className="p-2 whitespace-nowrap text-gray-500">
                      {format.dateTime(new Date(e.createdAt), 'short')}
                    </td>
                    <td className="p-2 text-xs">
                      {t(`scope_${e.scope}`)}
                      {e.tenant && (
                        <Link
                          href={
                            e.scope === 'workspace'
                              ? `/admin/workspaces/${e.tenant}`
                              : `/admin/orgs/${e.tenant}`
                          }
                          className="block text-indigo-700 hover:underline"
                        >
                          {e.tenant}
                        </Link>
                      )}
                    </td>
                    <td className="p-2 font-mono text-xs">{e.action}</td>
                    <td className="p-2 text-xs text-gray-600">
                      <AuditMetadata
                        metadata={e.metadata as Record<string, unknown> | null}
                        resource={`${e.resourceType} ${e.resourceId}`}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
      </section>
      {events.length === 0 ? (
        <p className="text-sm text-gray-500">{t('empty')}</p>
      ) : (
        <table className="w-full text-sm bg-white rounded-lg shadow-sm border border-gray-100">
          <tbody>
            {events.map((e) => (
              <tr key={e.id} className="border-t align-top">
                <td className="p-3 whitespace-nowrap text-gray-500">
                  {format.dateTime(new Date(e.createdAt), 'short')}
                </td>
                <td className="p-3 font-mono text-xs">{e.action}</td>
                <td className="p-3 text-xs text-gray-600">
                  <AuditMetadata
                    metadata={e.metadata}
                    resource={`${e.resourceType} ${e.resourceId}`}
                  />
                </td>
                <td className="p-3 text-xs text-gray-700 break-all">
                  <AuditActorLabel {...e} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {nextCursor && (
        <Link
          href={auditHref('/admin/audit', { ...query, cursor: nextCursor })}
          className="text-sm text-indigo-600"
        >
          {t('next')}
        </Link>
      )}
    </div>
  );
}
