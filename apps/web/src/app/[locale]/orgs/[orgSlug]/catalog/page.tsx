// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/routing';
import { orgApi } from '@/lib/orgApi';

/** ORG-12: every module in the organization, with its team and versions per environment. */
export default async function OrgCatalogPage(props: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await props.params;
  const t = await getTranslations('OrgCatalog');
  const { modules } = await orgApi.catalog(orgSlug);
  const envs = [...new Set(modules.flatMap((m) => Object.keys(m.versions)))].sort();

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </div>
      <section className="rounded-xl border bg-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="p-3 font-medium">{t('module')}</th>
              <th className="p-3 font-medium">{t('team')}</th>
              <th className="p-3 font-medium">{t('owners')}</th>
              {envs.map((env) => (
                <th key={env} className="p-3 font-medium">
                  {env}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {modules.map((m) => (
              <tr key={m.id} className="border-t">
                <td className="p-3">
                  <Link
                    href={`/w/${m.workspace}/modules/${m.slug}`}
                    className="font-medium hover:text-primary"
                  >
                    {m.name}
                  </Link>
                  {m.shared && (
                    <span className="ml-2 rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-800">
                      {t('shared')}
                    </span>
                  )}
                  {m.description && (
                    <div className="text-xs text-muted-foreground">{m.description}</div>
                  )}
                </td>
                <td className="p-3">{m.workspaceName}</td>
                <td className="p-3 text-xs">{m.owners.join(', ') || '—'}</td>
                {envs.map((env) => (
                  <td key={env} className="p-3 font-mono text-xs">
                    {m.versions[env] ?? '—'}
                  </td>
                ))}
              </tr>
            ))}
            {modules.length === 0 && (
              <tr>
                <td colSpan={3 + envs.length} className="p-6 text-center text-muted-foreground">
                  {t('empty')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </>
  );
}
