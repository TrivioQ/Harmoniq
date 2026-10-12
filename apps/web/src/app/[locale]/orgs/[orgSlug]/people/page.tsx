// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/routing';
import { ActionForm } from '@/components/ActionForm';
import { orgApi } from '@/lib/orgApi';
import { getMe } from '@/lib/registry';
import {
  inviteOrgMemberAction,
  resendOrgInvitationAction,
  revokeOrgInvitationAction,
} from '../../actions';

const ROLES = ['org_member', 'org_admin', 'org_auditor', 'org_billing'] as const;
const input = 'rounded-md border px-3 py-1.5 text-sm';

/**
 * PPL-03: everyone with access to the organization or its workspaces, how they got it,
 * and pending invitations. Org admins and auditors.
 */
export default async function OrgPeoplePage(props: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ query?: string; cursor?: string }>;
}) {
  const { orgSlug } = await props.params;
  const query = await props.searchParams;
  const t = await getTranslations('OrgPeople');
  const tm = await getTranslations('OrgMembers');
  const format = await getFormatter();
  const [{ people, nextCursor, invitations }, me] = await Promise.all([
    orgApi.people(orgSlug, query),
    getMe(),
  ]);
  const admin = me?.organizations.find((o) => o.slug === orgSlug)?.role === 'org_admin';

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </div>

      {admin && (
        <section className="rounded-xl border bg-card p-4 space-y-2">
          <h2 className="font-semibold text-sm">{t('invite')}</h2>
          <ActionForm
            action={inviteOrgMemberAction.bind(null, orgSlug)}
            submitLabel={t('inviteSubmit')}
            className="flex flex-wrap gap-2"
            secretHint={t('inviteLink')}
          >
            <input
              name="email"
              type="email"
              required
              placeholder="dev@acme.com"
              aria-label="Email"
              className={input}
            />
            <select name="role" defaultValue="org_member" className={input} aria-label={tm('role')}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {tm(r)}
                </option>
              ))}
            </select>
          </ActionForm>
        </section>
      )}

      {invitations.length > 0 && (
        <section className="rounded-xl border bg-card p-4 space-y-2">
          <h2 className="font-semibold text-sm">{t('invitations')}</h2>
          <ul className="divide-y text-sm">
            {invitations.map((i) => (
              <li key={i.id} className="py-2 flex flex-wrap items-center justify-between gap-2">
                <span>
                  {i.email} · {i.workspace ?? t('organization')} · {i.role}
                  <span className="block text-xs text-muted-foreground">
                    {t('expires', { date: format.dateTime(new Date(i.expiresAt), 'short') })}
                  </span>
                </span>
                {admin && !i.workspace && (
                  <span className="flex gap-2">
                    <ActionForm
                      action={resendOrgInvitationAction.bind(null, orgSlug, i.id)}
                      submitLabel={t('resend')}
                      variant="outline"
                      secretHint={t('inviteLink')}
                    />
                    <ActionForm
                      action={revokeOrgInvitationAction.bind(null, orgSlug, i.id)}
                      submitLabel={t('revoke')}
                      variant="danger"
                      confirm={t('revokeConfirm', { email: i.email })}
                    />
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <form className="flex gap-2" method="get">
        <input
          name="query"
          defaultValue={query.query}
          placeholder={t('search')}
          aria-label={t('search')}
          className={input}
        />
        <button type="submit" className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted">
          {t('searchButton')}
        </button>
      </form>

      <section className="rounded-xl border bg-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="p-3 font-medium">{t('person')}</th>
              <th className="p-3 font-medium">{t('orgRole')}</th>
              <th className="p-3 font-medium">{t('workspaces')}</th>
              <th className="p-3 font-medium">{t('lastSignIn')}</th>
              <th className="p-3 font-medium">{t('apiKeys')}</th>
            </tr>
          </thead>
          <tbody>
            {people.map((p) => (
              <tr key={p.user.id} className="border-t align-top">
                <td className="p-3">
                  <div className="font-medium">{p.user.name ?? p.user.email}</div>
                  <div className="text-xs text-muted-foreground">{p.user.email}</div>
                  {p.scim && (
                    <span className="text-xs text-muted-foreground">
                      {p.scim.active ? t('scim') : t('scimInactive')}
                    </span>
                  )}
                </td>
                <td className="p-3">{p.orgRole ? tm(p.orgRole) : '—'}</td>
                <td className="p-3 text-xs space-y-1">
                  {p.implicitAdmin && (
                    <div className="text-muted-foreground">{t('allWorkspaces')}</div>
                  )}
                  {p.workspaces.map((w) => (
                    <div key={w.slug}>
                      <Link href={`/w/${w.slug}`} className="hover:text-primary font-mono">
                        {w.slug}
                      </Link>{' '}
                      · {w.role}
                      {w.source === 'org_rules' && ` · ${t('viaRules')}`}
                    </div>
                  ))}
                  {!p.implicitAdmin && p.workspaces.length === 0 && '—'}
                </td>
                <td className="p-3 text-xs">
                  {p.user.lastLoginAt
                    ? format.relativeTime(new Date(p.user.lastLoginAt))
                    : t('never')}
                </td>
                <td className="p-3">{p.apiKeys}</td>
              </tr>
            ))}
            {people.length === 0 && (
              <tr>
                <td colSpan={5} className="p-6 text-center text-muted-foreground">
                  {t('empty')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
      {nextCursor && (
        <Link
          href={`/orgs/${orgSlug}/people?${new URLSearchParams({
            ...(query.query && { query: query.query }),
            cursor: nextCursor,
          })}`}
          className="text-sm hover:text-primary"
        >
          {t('next')} →
        </Link>
      )}
    </>
  );
}
