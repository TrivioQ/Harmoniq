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
  searchParams: Promise<AuditQuery & { verify?: string }>;
}) {
  const query = await props.searchParams;
  const t = await getTranslations('AdminAuditPage');
  const format = await getFormatter();
  const { events, nextCursor } = await adminApi.audit({
    cursor: query.cursor,
    actor: query.actor,
    action: query.action,
    ...auditRange(query),
  });

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
      <AuditFilters query={query} actionPlaceholder="instance." />
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
