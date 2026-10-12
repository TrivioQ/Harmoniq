// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/routing';
import { ActionForm } from '@/components/ActionForm';
import { type CatalogQuery, orgApi } from '@/lib/orgApi';
import { requestAccessAction } from '../../actions';

const input = 'rounded-md border px-3 py-1.5 text-sm bg-background';

type Search = CatalogQuery & { consumers?: string };

/**
 * ORG-12, TAD-07: every module in the organization, with its team and versions per
 * environment; searchable and filterable. `?consumers=<id>` shows which workspaces load a
 * shared module.
 */
export default async function OrgCatalogPage(props: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<Search>;
}) {
  const { orgSlug } = await props.params;
  const search = await props.searchParams;
  const { consumers: consumersOf, ...query } = search;
  const t = await getTranslations('OrgCatalog');
  const [catalog, home, consumers] = await Promise.all([
    orgApi.catalog(orgSlug, query),
    orgApi.home(orgSlug, { limit: '200' }),
    consumersOf ? orgApi.consumers(orgSlug, consumersOf).catch(() => null) : null,
  ]);
  const { modules } = catalog;
  const envs = [...new Set(modules.flatMap((m) => Object.keys(m.versions)))].sort();
  const href = (next: Search) => {
    const qs = new URLSearchParams(
      Object.entries(next).filter((e): e is [string, string] => !!e[1])
    );
    return `/orgs/${orgSlug}/catalog${qs.size ? `?${qs}` : ''}`;
  };
  const shown = consumersOf ? modules.find((m) => m.id === consumersOf) : undefined;
  // PPL-07: offer to join a team you are not in, once per workspace.
  const team = new Map(home.workspaces.map((w) => [w.slug, w]));
  const offered = new Set<string>();

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </div>

      <form method="get" className="flex flex-wrap items-center gap-2" aria-label={t('filters')}>
        <input
          name="query"
          type="search"
          defaultValue={query.query}
          placeholder={t('searchPlaceholder')}
          aria-label={t('search')}
          className={input}
        />
        <select
          name="workspace"
          defaultValue={query.workspace ?? ''}
          aria-label={t('team')}
          className={input}
        >
          <option value="">{t('allTeams')}</option>
          {home.workspaces
            .filter((w) => !w.deletedAt)
            .map((w) => (
              <option key={w.slug} value={w.slug}>
                {w.name}
              </option>
            ))}
        </select>
        <input
          name="environment"
          defaultValue={query.environment}
          placeholder={t('environmentPlaceholder')}
          aria-label={t('environment')}
          list="catalog-envs"
          className={`${input} font-mono w-36`}
        />
        <datalist id="catalog-envs">
          {envs.map((env) => (
            <option key={env} value={env} />
          ))}
        </datalist>
        <select
          name="shared"
          defaultValue={query.shared ?? ''}
          aria-label={t('sharing')}
          className={input}
        >
          <option value="">{t('anySharing')}</option>
          <option value="true">{t('sharedOnly')}</option>
          <option value="false">{t('notShared')}</option>
        </select>
        <button type="submit" className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted">
          {t('apply')}
        </button>
        {typeof catalog.total === 'number' && (
          <span className="text-xs text-muted-foreground">
            {t('count', { count: catalog.total })}
          </span>
        )}
      </form>

      {consumersOf && (
        <section className="rounded-xl border bg-card p-4 space-y-2" aria-live="polite">
          <div className="flex justify-between gap-2">
            <h2 className="font-semibold text-sm">
              {t('consumersOf', { module: shown?.name ?? consumersOf })}
            </h2>
            <Link href={href(query)} className="text-xs text-muted-foreground hover:text-primary">
              {t('close')}
            </Link>
          </div>
          {!consumers ? (
            <p className="text-sm text-muted-foreground">{t('consumersUnavailable')}</p>
          ) : !consumers.shared ? (
            <p className="text-sm text-muted-foreground">{t('notSharedHint')}</p>
          ) : consumers.consumers.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('noConsumers')}</p>
          ) : (
            <ul className="text-sm divide-y">
              {consumers.consumers.map((c) => (
                <li key={c.workspace} className="py-1.5 flex flex-wrap gap-x-2">
                  <span className="font-medium">{c.workspace}</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {c.environments.join(', ')}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

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
                    <Link
                      href={href({ ...query, consumers: m.id })}
                      className="ml-2 rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-800 hover:underline"
                      title={t('showConsumers')}
                    >
                      {t('shared')}
                    </Link>
                  )}
                  {m.description && (
                    <div className="text-xs text-muted-foreground">{m.description}</div>
                  )}
                </td>
                <td className="p-3">
                  {m.workspaceName}
                  {(() => {
                    const w = team.get(m.workspace);
                    if (!w || w.yourRole !== null || offered.has(m.workspace)) return null;
                    offered.add(m.workspace);
                    return w.accessRequested ? (
                      <div className="text-xs text-muted-foreground">{t('requested')}</div>
                    ) : (
                      <ActionForm
                        action={requestAccessAction.bind(null, m.workspace)}
                        submitLabel={t('requestAccess')}
                        variant="outline"
                        className="mt-1"
                      />
                    );
                  })()}
                </td>
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

      {(query.cursor || catalog.nextCursor) && (
        <nav className="flex gap-4 text-sm" aria-label={t('pagination')}>
          {query.cursor && (
            <Link href={href({ ...query, cursor: undefined })} className="hover:text-primary">
              ← {t('firstPage')}
            </Link>
          )}
          {catalog.nextCursor && (
            <Link
              href={href({ ...query, cursor: catalog.nextCursor })}
              className="hover:text-primary"
            >
              {t('nextPage')} →
            </Link>
          )}
        </nav>
      )}
    </>
  );
}
