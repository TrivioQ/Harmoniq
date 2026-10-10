// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { getTranslations } from 'next-intl/server';
import { ScimSettings } from '@/components/ScimSettings';
import { workspaceApi } from '@/lib/workspaceApi';

/** SSO-24: SCIM provisioning from the workspace's identity provider. */
export default async function ProvisioningPage(props: {
  params: Promise<{ workspaceSlug: string }>;
}) {
  const { workspaceSlug } = await props.params;
  const t = await getTranslations('ProvisioningPage');
  const [scim, { events }] = await Promise.all([
    workspaceApi.scim(workspaceSlug),
    workspaceApi.scimEvents(workspaceSlug),
  ]);

  return (
    <div className="space-y-4 max-w-3xl">
      <p className="text-sm text-muted-foreground">{t('description')}</p>
      <ScimSettings
        owner={{ kind: 'workspace', slug: workspaceSlug }}
        scim={scim}
        events={events}
        howItWorks={t('howItWorks')}
      />
    </div>
  );
}
