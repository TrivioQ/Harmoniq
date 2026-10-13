// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ActionForm } from '@/components/ActionForm';
import { DomainSettings } from '@/components/DomainSettings';
import { orgApi } from '@/lib/orgApi';
import { deleteOrgAction, renameOrgAction, transferOrgAction } from '../../actions';

const input = 'rounded-md border px-3 py-1.5 text-sm';

/** TAD-01: the organization's name, plan, verified domains and danger zone (org admins). */
export default async function OrgSettingsPage(props: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await props.params;
  const t = await getTranslations('OrgSettings');
  const org = await orgApi.home(orgSlug, { limit: '1' });
  // INST-20: also read through support access (the layout makes it read-only).
  if (org.role !== 'org_admin' && !org.support) notFound();
  const [{ oidc }, { saml }] = await Promise.all([orgApi.oidc(orgSlug), orgApi.saml(orgSlug)]);

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </div>

      <section className="rounded-xl border bg-card p-4 space-y-3 max-w-3xl">
        <h2 className="font-semibold text-sm">{t('general')}</h2>
        <ActionForm
          action={renameOrgAction.bind(null, orgSlug)}
          submitLabel={t('rename')}
          className="flex flex-wrap items-center gap-2"
        >
          <input
            name="name"
            required
            maxLength={120}
            defaultValue={org.name}
            aria-label={t('name')}
            className={input}
          />
        </ActionForm>
        <dl className="grid grid-cols-[8rem_1fr] gap-y-1 text-sm">
          <dt className="text-muted-foreground">{t('slug')}</dt>
          <dd className="font-mono">{org.slug}</dd>
          <dt className="text-muted-foreground">{t('plan')}</dt>
          <dd>
            <span className="capitalize">{org.plan}</span>{' '}
            <span className="text-xs text-muted-foreground">{t('planHint')}</span>
          </dd>
          <dt className="text-muted-foreground">{t('workspaces')}</dt>
          <dd>{org.total ?? org.workspaces.length}</dd>
        </dl>
      </section>

      <DomainSettings
        owner={{ kind: 'organization', slug: orgSlug }}
        trusted={[...(oidc?.trustedDomains ?? []), ...(saml?.trustedDomains ?? [])]}
      />

      <section className="rounded-xl border bg-card p-4 space-y-2 max-w-3xl">
        <h2 className="font-semibold text-sm">{t('export')}</h2>
        <p className="text-xs text-muted-foreground">{t('exportHint')}</p>
        {/* TLC-07: the organization and its live workspaces, everything, as JSON Lines. */}
        <a
          href={`/api/tenant-export?${new URLSearchParams({ scope: 'org', slug: orgSlug })}`}
          className="inline-block rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
          download
        >
          {t('exportSubmit')}
        </a>
      </section>

      <section className="rounded-xl border border-red-200 bg-card p-4 space-y-4 max-w-3xl">
        <h2 className="font-semibold text-sm text-red-700">{t('dangerZone')}</h2>
        {/* TLC-06: hand your admin seat to a member; you become a member when they accept. */}
        <div className="space-y-2">
          <h3 className="text-sm font-medium">{t('transfer')}</h3>
          <p className="text-xs text-muted-foreground">{t('transferHint')}</p>
          <ActionForm
            action={transferOrgAction.bind(null, orgSlug)}
            submitLabel={t('transferSubmit')}
            variant="outline"
            className="flex flex-wrap gap-2"
          >
            <input
              name="email"
              type="email"
              required
              placeholder="new-admin@acme.com"
              aria-label={t('email')}
              className={input}
            />
          </ActionForm>
        </div>
        {/* TLC-02: needs every workspace detached or deleted; restorable by an instance admin. */}
        <div className="space-y-2 border-t pt-4">
          <h3 className="text-sm font-medium">{t('delete')}</h3>
          <p className="text-xs text-muted-foreground">{t('deleteHint')}</p>
          <ActionForm
            action={deleteOrgAction.bind(null, orgSlug)}
            submitLabel={t('deleteSubmit')}
            confirm={t('deleteConfirm', { name: org.name })}
            variant="danger"
            className="flex flex-wrap gap-2"
          >
            <input
              name="confirm"
              required
              placeholder={orgSlug}
              aria-label={t('typeSlug')}
              className={`${input} font-mono`}
            />
          </ActionForm>
        </div>
      </section>
    </>
  );
}
