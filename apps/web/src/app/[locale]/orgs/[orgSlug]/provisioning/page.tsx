// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { getTranslations } from 'next-intl/server';
import { ActionForm } from '@/components/ActionForm';
import { ScimSettings } from '@/components/ScimSettings';
import { orgApi } from '@/lib/orgApi';
import { saveOrgProvisioningAction } from '../../actions';

const input = 'block w-full rounded-md border px-3 py-1.5 text-sm font-mono';

/** ORG-07: IdP groups become org admins and workspace roles, from SSO or SCIM. */
export default async function OrgProvisioningPage(props: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await props.params;
  const t = await getTranslations('OrgProvisioning');
  const [rules, scim, { events }] = await Promise.all([
    orgApi.provisioning(orgSlug),
    orgApi.scim(orgSlug),
    orgApi.scimEvents(orgSlug),
  ]);

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </div>
      <div className="space-y-4 max-w-3xl">
        <section className="rounded-xl border bg-card p-4 space-y-2">
          <h2 className="font-semibold text-sm">{t('rulesTitle')}</h2>
          <p className="text-xs text-muted-foreground">{t('rulesHelp')}</p>
          <ActionForm
            action={saveOrgProvisioningAction.bind(null, orgSlug)}
            submitLabel={t('save')}
            className="space-y-3"
          >
            <label className="text-sm space-y-1 block">
              <span>{t('rules')}</span>
              <textarea
                name="rules"
                rows={6}
                defaultValue={rules.rules
                  .map((r) => `${r.group} = ${r.workspace}:${r.role}`)
                  .join('\n')}
                placeholder="engineering = checkout:developer"
                className={input}
              />
            </label>
            <label className="text-sm space-y-1 block">
              <span>{t('adminGroups')}</span>
              <textarea
                name="adminGroups"
                rows={2}
                defaultValue={rules.adminGroups.join('\n')}
                placeholder="platform-admins"
                className={input}
              />
            </label>
          </ActionForm>
        </section>
        <h2 className="font-semibold pt-2">{t('scimTitle')}</h2>
        <ScimSettings
          owner={{ kind: 'organization', slug: orgSlug }}
          scim={scim}
          events={events}
          howItWorks={t('scimHowItWorks')}
        />
      </div>
    </>
  );
}
