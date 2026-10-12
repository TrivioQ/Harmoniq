// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { DomainSettings } from '@/components/DomainSettings';
import { SsoSettings } from '@/components/SsoSettings';
import { workspaceApi } from '@/lib/workspaceApi';

/** SSO-03/11: a workspace's OpenID Connect and SAML 2.0 sign-in. */
export default async function SsoSettingsPage(props: {
  params: Promise<{ workspaceSlug: string }>;
  searchParams: Promise<{ samlTest?: string }>;
}) {
  const { workspaceSlug } = await props.params;
  const { samlTest } = await props.searchParams;
  const [{ oidc }, { serviceProvider, saml }, testResult] = await Promise.all([
    workspaceApi.sso(workspaceSlug),
    workspaceApi.saml(workspaceSlug),
    samlTest ? workspaceApi.samlTest(workspaceSlug, samlTest).catch(() => null) : null,
  ]);
  return (
    <>
      <DomainSettings
        owner={{ kind: 'workspace', slug: workspaceSlug }}
        trusted={[...(oidc?.trustedDomains ?? []), ...(saml?.trustedDomains ?? [])]}
      />
      <SsoSettings
        owner={{ kind: 'workspace', slug: workspaceSlug }}
        oidc={oidc}
        serviceProvider={serviceProvider}
        saml={saml}
        samlTest={samlTest}
        testResult={testResult}
      />
    </>
  );
}
