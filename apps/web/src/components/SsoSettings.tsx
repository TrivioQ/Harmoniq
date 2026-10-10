import { getTranslations } from 'next-intl/server';
import { ActionForm } from '@/components/ActionForm';
import { getAppUrl } from '@/lib/env';
import type {
  OidcSettings,
  SamlSettings,
  SamlSettingsResponse,
  SamlTestResult,
} from '@/lib/workspaceApi';
import {
  type SsoOwner,
  deleteSamlAction,
  deleteSsoAction,
  saveSamlAction,
  saveSsoAction,
  testSamlAction,
} from '@/app/[locale]/ssoActions';

const input = 'block w-full rounded-md border px-3 py-1.5 text-sm';

/**
 * SSO-03/11, ORG-05/06: OpenID Connect and SAML 2.0 settings of a workspace or an
 * organization. Organizations have no role mapping: their group rules assign roles.
 */
export async function SsoSettings({
  owner,
  oidc,
  serviceProvider,
  saml,
  samlTest,
  testResult,
}: {
  owner: SsoOwner;
  oidc: OidcSettings | null;
  serviceProvider: SamlSettingsResponse['serviceProvider'];
  saml: SamlSettings | null;
  samlTest?: string;
  testResult: SamlTestResult | null;
}) {
  const t = await getTranslations('SsoPage');
  const providerId = `${owner.kind === 'organization' ? 'org-' : ''}oidc:${owner.slug}`;
  const callback = `${getAppUrl()}/api/auth/callback/${encodeURIComponent(providerId)}`;
  const field = (
    name: string,
    label: string,
    props: React.InputHTMLAttributes<HTMLInputElement> = {}
  ) => (
    <label className="text-sm space-y-1 block">
      <span>{label}</span>
      <input name={name} className={input} {...props} />
    </label>
  );
  const roleFields = (current: OidcSettings | SamlSettings | null) =>
    owner.kind === 'workspace' && (
      <>
        <label className="text-sm space-y-1 block sm:col-span-2">
          <span>{t('roleMapping')}</span>
          <textarea
            name="roleMapping"
            rows={4}
            defaultValue={Object.entries(current?.roleMapping ?? {})
              .map(([group, role]) => `${group} = ${role}`)
              .join('\n')}
            className={`${input} font-mono`}
          />
        </label>
        <label className="text-sm space-y-1 block">
          <span>{t('defaultRole')}</span>
          <select
            name="defaultRole"
            defaultValue={current?.defaultRole ?? 'viewer'}
            className={input}
          >
            {['viewer', 'developer', 'admin'].map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </select>
        </label>
      </>
    );

  return (
    <div className="space-y-4 max-w-3xl">
      <h2 className="font-semibold">{t('oidcTitle')}</h2>
      <p className="text-sm text-muted-foreground">{t('description')}</p>
      {owner.kind === 'organization' && (
        <p className="text-sm text-muted-foreground">{t('orgRolesHint')}</p>
      )}
      <div className="rounded-xl border bg-card p-4 space-y-1">
        <div className="text-sm font-medium">{t('callback')}</div>
        <code className="block text-xs break-all">{callback}</code>
        <p className="text-xs text-muted-foreground">{t('loginHint')}</p>
      </div>
      <section className="rounded-xl border bg-card p-4">
        <ActionForm
          action={saveSsoAction.bind(null, owner)}
          submitLabel={t('save')}
          className="grid gap-3 sm:grid-cols-2"
        >
          {field('issuer', t('issuer'), {
            type: 'url',
            required: true,
            defaultValue: oidc?.issuer,
            placeholder: 'https://acme.okta.com',
          })}
          {field('clientId', t('clientId'), { required: true, defaultValue: oidc?.clientId })}
          {field('clientSecret', t('clientSecret'), {
            type: 'password',
            required: !oidc,
            autoComplete: 'off',
            placeholder: oidc ? t('secretKeep', { masked: oidc.clientSecret }) : '',
          })}
          {field('scopes', t('scopes'), {
            defaultValue: (oidc?.scopes ?? ['openid', 'email', 'profile']).join(' '),
          })}
          {field('groupsClaim', t('groupsClaim'), { defaultValue: oidc?.groupsClaim ?? 'groups' })}
          {field('trustedDomains', t('trustedDomains'), {
            defaultValue: oidc?.trustedDomains.join(', '),
            placeholder: 'acme.com',
          })}
          {roleFields(oidc)}
          <label className="text-sm flex items-center gap-2 sm:col-span-2">
            <input type="checkbox" name="forceSso" defaultChecked={oidc?.forceSso ?? false} />
            {t('forceSso')}
          </label>
        </ActionForm>
      </section>
      {oidc && (
        <ActionForm
          action={deleteSsoAction.bind(null, owner)}
          submitLabel={t('remove')}
          confirm={t('removeConfirm')}
          variant="danger"
        />
      )}

      <h2 id="saml" className="font-semibold pt-6">
        {t('samlTitle')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('samlDescription')}</p>
      <div className="rounded-xl border bg-card p-4 space-y-2">
        <div className="text-sm font-medium">{t('samlSp')}</div>
        <dl className="grid gap-x-3 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
          {(
            [
              ['samlEntityId', serviceProvider.entityId],
              ['samlAcs', serviceProvider.acs],
              ['samlMetadata', serviceProvider.metadata],
              ['samlSlo', serviceProvider.slo],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{t(label)}</dt>
              <dd>
                <code className="break-all">{value}</code>
              </dd>
            </div>
          ))}
        </dl>
        {serviceProvider.cert ? (
          <details className="text-xs">
            <summary className="cursor-pointer">{t('samlSpCert')}</summary>
            <pre className="mt-1 whitespace-pre-wrap break-all">{serviceProvider.cert}</pre>
          </details>
        ) : (
          <p className="text-xs text-muted-foreground">{t('samlCertLater')}</p>
        )}
        <details className="text-xs">
          <summary className="cursor-pointer">{t('samlGuides')}</summary>
          <ul className="mt-1 list-disc pl-5 space-y-1">
            <li>{t('samlOkta')}</li>
            <li>{t('samlEntra')}</li>
            <li>{t('samlAdfs')}</li>
          </ul>
        </details>
      </div>

      {samlTest && (
        <section className="rounded-xl border bg-card p-4 space-y-2">
          <div className="text-sm font-medium">{t('samlTestResult')}</div>
          {!testResult ? (
            <p className="text-sm text-red-600">{t('samlTestExpired')}</p>
          ) : testResult.mapped.error ? (
            <p className="text-sm text-red-600">{testResult.mapped.error}</p>
          ) : (
            <p className="text-sm">
              {t('samlTestMapped', {
                email: testResult.mapped.email ?? '',
                groups: (testResult.mapped.groups ?? []).join(', ') || '—',
              })}
            </p>
          )}
          {testResult && (
            <pre className="text-xs whitespace-pre-wrap break-all">
              {JSON.stringify(testResult.attributes, null, 2)}
            </pre>
          )}
        </section>
      )}

      <section className="rounded-xl border bg-card p-4">
        <ActionForm
          action={saveSamlAction.bind(null, owner)}
          submitLabel={t('samlSave')}
          className="grid gap-3 sm:grid-cols-2"
        >
          <label className="text-sm space-y-1 block sm:col-span-2">
            <span>{t('samlImport')}</span>
            <textarea
              name="metadataXml"
              rows={3}
              placeholder="<md:EntityDescriptor …>"
              className={`${input} font-mono`}
            />
          </label>
          {field('idpEntityId', t('samlIdpEntityId'), { defaultValue: saml?.idpEntityId })}
          {field('idpSsoUrl', t('samlIdpSsoUrl'), { type: 'url', defaultValue: saml?.idpSsoUrl })}
          {field('idpSloUrl', t('samlIdpSloUrl'), { type: 'url', defaultValue: saml?.idpSloUrl })}
          <label className="text-sm space-y-1 block sm:col-span-2">
            <span>{t('samlIdpCert')}</span>
            <textarea
              name="idpCert"
              rows={3}
              defaultValue={saml?.idpCert}
              className={`${input} font-mono`}
            />
          </label>
          {field('emailAttribute', t('samlEmailAttribute'), {
            defaultValue: saml?.attributeMapping.email,
            placeholder: 'NameID',
          })}
          {field('nameAttribute', t('samlNameAttribute'), {
            defaultValue: saml?.attributeMapping.name,
          })}
          {field('groupsAttribute', t('samlGroupsAttribute'), {
            defaultValue: saml?.attributeMapping.groups,
            placeholder: 'groups',
          })}
          {field('trustedDomains', t('trustedDomains'), {
            defaultValue: saml?.trustedDomains.join(', '),
            placeholder: 'acme.com',
          })}
          {roleFields(saml)}
          <label className="text-sm flex items-center gap-2 sm:col-span-2">
            <input type="checkbox" name="forceSso" defaultChecked={saml?.forceSso ?? false} />
            {t('forceSso')}
          </label>
          <label className="text-sm flex items-center gap-2 sm:col-span-2">
            <input
              type="checkbox"
              name="allowIdpInitiated"
              defaultChecked={saml?.allowIdpInitiated ?? false}
            />
            {t('samlIdpInitiated')}
          </label>
        </ActionForm>
      </section>
      {saml && (
        <div className="flex gap-2">
          <ActionForm
            action={testSamlAction.bind(null, owner)}
            submitLabel={t('samlTest')}
            variant="outline"
          />
          <ActionForm
            action={deleteSamlAction.bind(null, owner)}
            submitLabel={t('samlRemove')}
            confirm={t('removeConfirm')}
            variant="danger"
          />
        </div>
      )}
    </div>
  );
}
