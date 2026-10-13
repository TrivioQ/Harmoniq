// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/routing';
import { ActionForm } from '@/components/ActionForm';
import { orgApi } from '@/lib/orgApi';
import {
  attachWorkspaceAction,
  createOrgWorkspaceAction,
  deleteOrgWorkspaceAction,
  detachWorkspaceAction,
  requestAccessAction,
} from '../actions';
import { restoreWorkspaceAction } from '../../lifecycleActions';

const input = 'rounded-md border px-3 py-1.5 text-sm';

const badge = 'mt-1 mr-1 inline-block rounded px-1.5 py-0.5 text-xs';

/** ORG-14, TAD-06: the organization home. */
export default async function OrgHomePage(props: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ query?: string; cursor?: string }>;
}) {
  const { orgSlug } = await props.params;
  const { query, cursor } = await props.searchParams;
  const t = await getTranslations('OrgHome');
  const format = await getFormatter();
  const org = await orgApi.home(orgSlug, { query, cursor });
  const admin = org.role === 'org_admin';
  const page = (next: { cursor?: string }) => {
    const qs = new URLSearchParams(
      Object.entries({ query, ...next }).filter((e): e is [string, string] => !!e[1])
    );
    return `/orgs/${orgSlug}${qs.size ? `?${qs}` : ''}`;
  };
  const pending = org.pendingApprovals ?? [];

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{org.name}</h1>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </div>
      {org.suspended && (
        <div role="status" className="rounded-md bg-amber-50 px-4 py-2 text-sm text-amber-900">
          {t('orgSuspended')}
        </div>
      )}

      {pending.length > 0 && (
        <section className="rounded-xl border border-amber-200 bg-amber-50/50 p-4 space-y-2">
          <h2 className="font-semibold text-sm">{t('pendingApprovals')}</h2>
          <ul className="text-sm divide-y">
            {pending.map((r) => (
              <li key={r.id} className="py-1.5 flex flex-wrap justify-between gap-2">
                <Link href={`/w/${r.workspace}/approvals`} className="hover:text-primary">
                  <span className="font-mono">{r.workspace}</span> · {r.type}
                </Link>
                <span className="text-xs text-muted-foreground">
                  {t('requestedAt', { when: format.relativeTime(new Date(r.createdAt)) })} ·{' '}
                  {t('expires', { when: format.relativeTime(new Date(r.expiresAt)) })}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <form method="get" className="flex flex-wrap items-center gap-2">
        <input
          name="query"
          type="search"
          defaultValue={query}
          placeholder={t('searchPlaceholder')}
          aria-label={t('search')}
          className={input}
        />
        <button type="submit" className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted">
          {t('search')}
        </button>
        {typeof org.total === 'number' && (
          <span className="text-xs text-muted-foreground">{t('count', { count: org.total })}</span>
        )}
      </form>

      <section className="rounded-xl border bg-card">
        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="p-3 font-medium">{t('workspace')}</th>
              <th className="p-3 font-medium">{t('modules')}</th>
              <th className="p-3 font-medium">{t('members')}</th>
              <th className="p-3 font-medium">{t('lastDeploy')}</th>
              <th className="p-3 font-medium">{t('health')}</th>
              {admin && <th className="p-3" />}
            </tr>
          </thead>
          <tbody>
            {org.workspaces.map((w) => (
              <tr key={w.slug} className="border-t">
                <td className="p-3">
                  {w.deletedAt ? (
                    <span className="font-medium text-muted-foreground line-through">{w.name}</span>
                  ) : w.yourRole === null ? (
                    // PPL-07: not a member: ask to join instead of a link that would 404.
                    <span className="font-medium">{w.name}</span>
                  ) : (
                    <Link href={`/w/${w.slug}`} className="font-medium hover:text-primary">
                      {w.name}
                    </Link>
                  )}
                  {!w.deletedAt && w.yourRole === null && (
                    <div className="mt-1">
                      {w.accessRequested ? (
                        <span className="text-xs text-muted-foreground">{t('requested')}</span>
                      ) : (
                        <ActionForm
                          action={requestAccessAction.bind(null, w.slug)}
                          submitLabel={t('requestAccess')}
                          variant="outline"
                        />
                      )}
                    </div>
                  )}
                  <div className="text-xs text-muted-foreground font-mono">{w.slug}</div>
                  {w.suspended && (
                    <span className={`${badge} bg-amber-100 text-amber-900`}>{t('suspended')}</span>
                  )}
                  {(w.frozenEnvironments ?? []).length > 0 && (
                    <span
                      className={`${badge} bg-blue-100 text-blue-900`}
                      title={w.frozenEnvironments!.join(', ')}
                    >
                      {t('frozen', { count: w.frozenEnvironments!.length })}
                    </span>
                  )}
                  {(w.pendingApprovals ?? 0) > 0 && (
                    <Link
                      href={`/w/${w.slug}/approvals`}
                      className={`${badge} bg-violet-100 text-violet-900`}
                    >
                      {t('approvalsWaiting', { count: w.pendingApprovals! })}
                    </Link>
                  )}
                  {w.deletedAt && (
                    <span className="mt-1 inline-block rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-800">
                      {w.purgeAfter
                        ? t('deletedUntil', {
                            date: format.dateTime(new Date(w.purgeAfter), 'short'),
                          })
                        : t('deleted')}
                    </span>
                  )}
                </td>
                <td className="p-3">{w.modules}</td>
                <td className="p-3">{w.members}</td>
                <td className="p-3">
                  {w.lastDeployAt ? format.relativeTime(new Date(w.lastDeployAt)) : '—'}
                </td>
                <td className="p-3">
                  {w.health
                    ? t('errorRate', {
                        rate: format.number(w.health.errorRate, {
                          style: 'percent',
                          maximumFractionDigits: 2,
                        }),
                        samples: w.health.samples,
                      })
                    : '—'}
                </td>
                {admin && (
                  <td className="p-3 text-right space-y-2">
                    {w.deletedAt ? (
                      <ActionForm
                        action={restoreWorkspaceAction.bind(null, w.slug)}
                        submitLabel={t('restore')}
                        variant="outline"
                      />
                    ) : (
                      <>
                        <ActionForm
                          action={detachWorkspaceAction.bind(null, org.slug, w.slug)}
                          submitLabel={t('detach')}
                          confirm={t('detachConfirm', { workspace: w.name })}
                          variant="outline"
                        />
                        <ActionForm
                          action={deleteOrgWorkspaceAction.bind(null, org.slug, w.slug)}
                          submitLabel={t('delete')}
                          confirm={t('deleteConfirm', { workspace: w.name })}
                          variant="danger"
                          className="flex justify-end gap-2"
                        >
                          <input
                            name="confirm"
                            required
                            placeholder={w.slug}
                            aria-label={t('typeSlug')}
                            className="w-32 rounded-md border px-2 py-1 text-xs font-mono"
                          />
                        </ActionForm>
                      </>
                    )}
                  </td>
                )}
              </tr>
            ))}
            {org.workspaces.length === 0 && (
              <tr>
                <td colSpan={6} className="p-6 text-center text-muted-foreground">
                  {t('noWorkspaces')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      {(cursor || org.nextCursor) && (
        <nav className="flex gap-4 text-sm" aria-label={t('pagination')}>
          {cursor && (
            <Link href={page({})} className="hover:text-primary">
              ← {t('firstPage')}
            </Link>
          )}
          {org.nextCursor && (
            <Link href={page({ cursor: org.nextCursor })} className="hover:text-primary">
              {t('nextPage')} →
            </Link>
          )}
        </nav>
      )}

      {admin && (
        <div className="grid gap-4 md:grid-cols-2">
          <section className="rounded-xl border bg-card p-4 space-y-2">
            <h2 className="font-semibold text-sm">{t('createWorkspace')}</h2>
            <ActionForm
              action={createOrgWorkspaceAction.bind(null, org.slug)}
              submitLabel={t('create')}
              className="flex flex-wrap gap-2"
            >
              <input
                name="name"
                required
                placeholder="Checkout team"
                aria-label={t('name')}
                className={input}
              />
              <input
                name="slug"
                required
                pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?"
                placeholder="checkout"
                aria-label={t('slug')}
                className={`${input} font-mono`}
              />
            </ActionForm>
          </section>
          <section className="rounded-xl border bg-card p-4 space-y-2">
            <h2 className="font-semibold text-sm">{t('attach')}</h2>
            <p className="text-xs text-muted-foreground">{t('attachHint')}</p>
            <ActionForm
              action={attachWorkspaceAction.bind(null, org.slug)}
              submitLabel={t('attachSubmit')}
              className="flex flex-wrap gap-2"
            >
              <input
                name="workspace"
                required
                placeholder="design-system"
                aria-label={t('slug')}
                className={`${input} font-mono`}
              />
            </ActionForm>
          </section>
        </div>
      )}

      <section className="rounded-xl border bg-card p-4 space-y-2">
        <h2 className="font-semibold text-sm">{t('recentDeploys')}</h2>
        {org.recentDeploys.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('noDeploys')}</p>
        ) : (
          <ul className="text-sm divide-y">
            {org.recentDeploys.map((d, i) => (
              <li key={i} className="py-1.5 flex flex-wrap gap-x-2">
                <span className="font-mono">
                  {d.workspace}/{d.module}@{d.version}
                </span>
                <span className="text-muted-foreground">
                  {d.environment} · {d.status} · {format.relativeTime(new Date(d.deployedAt))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
