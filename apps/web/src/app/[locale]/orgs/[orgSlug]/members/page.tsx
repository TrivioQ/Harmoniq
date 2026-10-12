// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/routing';
import { ActionForm } from '@/components/ActionForm';
import { orgApi } from '@/lib/orgApi';
import { getMe } from '@/lib/registry';
import {
  addOrgMemberAction,
  changeOrgMemberRoleAction,
  removeOrgMemberAction,
} from '../../actions';

const input = 'rounded-md border px-3 py-1.5 text-sm';
const ROLES = ['org_member', 'org_admin', 'org_auditor', 'org_billing'] as const;

/** ORG-04/08: organization members. Org admins administer every workspace in the org. */
export default async function OrgMembersPage(props: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await props.params;
  const t = await getTranslations('OrgMembers');
  const [{ members }, me] = await Promise.all([orgApi.members(orgSlug), getMe()]);
  const admin = me?.organizations.find((o) => o.slug === orgSlug)?.role === 'org_admin';

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </div>
      <section className="rounded-xl border bg-card divide-y">
        {members.map((m) => (
          <div key={m.id} className="p-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-sm font-medium">{m.user.name ?? m.user.email}</div>
              <div className="text-xs text-muted-foreground">{m.user.email}</div>
            </div>
            {admin ? (
              <div className="flex gap-2">
                <ActionForm
                  action={changeOrgMemberRoleAction.bind(null, orgSlug, m.id)}
                  submitLabel={t('save')}
                  variant="outline"
                  className="flex gap-2"
                >
                  <select
                    name="role"
                    defaultValue={m.role}
                    className={input}
                    aria-label={t('role')}
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {t(r)}
                      </option>
                    ))}
                  </select>
                </ActionForm>
                <ActionForm
                  action={removeOrgMemberAction.bind(null, orgSlug, m.id)}
                  submitLabel={t('remove')}
                  confirm={t('removeConfirm', { email: m.user.email })}
                  variant="danger"
                  className="flex items-center gap-2"
                >
                  {/* PPL-04: their API keys in the org are revoked unless kept. */}
                  <label className="flex items-center gap-1 text-xs text-muted-foreground">
                    <input type="checkbox" name="keepKeys" />
                    {t('keepKeys')}
                  </label>
                </ActionForm>
              </div>
            ) : (
              <span className="text-sm text-muted-foreground">{t(m.role)}</span>
            )}
          </div>
        ))}
      </section>
      {admin && (
        <section className="rounded-xl border bg-card p-4 space-y-2">
          <h2 className="font-semibold text-sm">{t('add')}</h2>
          <ActionForm
            action={addOrgMemberAction.bind(null, orgSlug)}
            submitLabel={t('addSubmit')}
            className="flex flex-wrap gap-2"
          >
            <input
              name="email"
              type="email"
              required
              placeholder="dev@acme.com"
              aria-label="Email"
              className={input}
            />
            <select name="role" defaultValue="org_member" className={input} aria-label={t('role')}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {t(r)}
                </option>
              ))}
            </select>
          </ActionForm>
        </section>
      )}
      {admin && (
        <p className="text-xs text-muted-foreground">
          {t.rich('transferMoved', {
            link: (chunks) => (
              <Link href={`/orgs/${orgSlug}/settings`} className="underline">
                {chunks}
              </Link>
            ),
          })}
        </p>
      )}
    </>
  );
}
