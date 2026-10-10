import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/routing';
import { SsoSettings } from '@/components/SsoSettings';
import { orgApi } from '@/lib/orgApi';

/** ORG-05/06: single sign-on for the whole organization. */
export default async function OrgSsoPage(props: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ samlTest?: string }>;
}) {
  const { orgSlug } = await props.params;
  const { samlTest } = await props.searchParams;
  const t = await getTranslations('OrgSso');
  const [overview, { oidc }, { serviceProvider, saml }, testResult] = await Promise.all([
    orgApi.sso(orgSlug),
    orgApi.oidc(orgSlug),
    orgApi.saml(orgSlug),
    samlTest ? orgApi.samlTest(orgSlug, samlTest).catch(() => null) : null,
  ]);
  const configured = !!(oidc || saml);

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </div>
      <section className="rounded-xl border bg-card p-4 space-y-2 max-w-3xl">
        <h2 className="font-semibold text-sm">{t('workspaces')}</h2>
        {overview.workspaces.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('noWorkspaces')}</p>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {overview.workspaces.map((ws) => (
                <tr key={ws.slug} className="border-t">
                  <td className="py-1.5 pr-2">
                    <Link href={`/w/${ws.slug}`} className="font-medium hover:text-primary">
                      {ws.name}
                    </Link>
                  </td>
                  <td className="py-1.5 text-muted-foreground">
                    {ws.own
                      ? t('ownSso', { protocol: ws.own === 'oidc' ? 'OpenID Connect' : 'SAML' })
                      : configured
                        ? t('inherits')
                        : t('none')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <SsoSettings
        owner={{ kind: 'organization', slug: orgSlug }}
        oidc={oidc}
        serviceProvider={serviceProvider}
        saml={saml}
        samlTest={samlTest}
        testResult={testResult}
      />
    </>
  );
}
