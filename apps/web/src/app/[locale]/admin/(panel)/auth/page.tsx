// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { getTranslations } from 'next-intl/server';
import { ActionForm } from '@/components/ActionForm';
import { adminApi } from '@/lib/adminApi';
import { saveSettingAction } from '../actions';
import { SettingSource } from '../SettingSource';

const input = 'block w-full rounded-md border px-3 py-1.5 text-sm';

/** INST-13: sign-in methods for the whole instance. */
export default async function AdminAuthPage() {
  const t = await getTranslations('AdminSettings');
  const { auth, tenancy } = await adminApi.settings();
  const creation = tenancy?.value.creation ?? 'anyone';
  const v = auth.value;
  const locked = new Set<string>(auth.locked ?? []);
  // A locked switch is disabled, so the form posts it as off, as the registry requires.
  const toggle = (name: 'email' | 'github' | 'oidc' | 'saml', label: string, on?: boolean) => (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        name={name}
        defaultChecked={!locked.has(name) && (on ?? true)}
        disabled={locked.has(name)}
      />
      <span className={locked.has(name) ? 'text-gray-400' : undefined}>{label}</span>
      {locked.has(name) && <span className="text-xs text-gray-500">{t('authLocked')}</span>}
    </label>
  );

  return (
    <div className="space-y-6 max-w-3xl">
      <h1 className="text-2xl font-bold text-gray-900">{t('authTitle')}</h1>
      <p className="text-sm text-gray-600">{t('authDescription')}</p>
      <SettingSource settingKey="auth" source={auth.source} />
      {auth.methodsFromEnvironment && (
        <p className="text-sm text-gray-600 bg-gray-50 border border-gray-200 rounded-md p-3">
          {t('authFromEnvironment', { methods: auth.allowedMethods.join(', ') })}
        </p>
      )}
      <section className="bg-white p-4 rounded-lg shadow-sm border border-gray-100">
        <ActionForm
          action={saveSettingAction.bind(null, 'auth')}
          submitLabel={t('save')}
          className="space-y-4"
        >
          {toggle('email', t('authEmail'), v.email?.enabled)}
          <fieldset className="space-y-2 border rounded-md p-3">
            {toggle('github', t('authGithub'), v.github?.enabled)}
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-sm space-y-1 block">
                <span>{t('githubClientId')}</span>
                <input name="githubClientId" defaultValue={v.github?.clientId} className={input} />
              </label>
              <label className="text-sm space-y-1 block">
                <span>{t('githubClientSecret')}</span>
                <input
                  name="githubClientSecret"
                  type="password"
                  autoComplete="off"
                  placeholder={
                    v.github?.clientSecret ? t('keepSecret', { masked: v.github.clientSecret }) : ''
                  }
                  className={input}
                />
              </label>
            </div>
            <p className="text-xs text-gray-500">{t('githubHint')}</p>
          </fieldset>
          {toggle('oidc', t('authOidc'), v.oidc?.enabled)}
          {toggle('saml', t('authSaml'), v.saml?.enabled)}
          {/* SES-01: organizations can only shorten these (POL-07). */}
          <fieldset className="grid gap-3 sm:grid-cols-2 border rounded-md p-3">
            <legend className="text-sm font-medium px-1">{t('sessionLegend')}</legend>
            <label className="text-sm space-y-1 block">
              <span>{t('sessionMaxDays')}</span>
              <input
                name="sessionMaxDays"
                type="number"
                min={1}
                max={365}
                defaultValue={v.session?.maxDays ?? 30}
                className={input}
              />
            </label>
            <label className="text-sm space-y-1 block">
              <span>{t('sessionIdleMinutes')}</span>
              <input
                name="sessionIdleMinutes"
                type="number"
                min={5}
                max={129600}
                defaultValue={v.session?.idleMinutes ?? ''}
                placeholder={t('noIdleLimit')}
                className={input}
              />
            </label>
          </fieldset>
        </ActionForm>
      </section>

      {/* TLC-08: who may create organizations and standalone workspaces. */}
      <h2 className="text-lg font-semibold text-gray-900">{t('tenancyTitle')}</h2>
      <p className="text-sm text-gray-600">{t('tenancyDescription')}</p>
      {tenancy && <SettingSource settingKey="tenancy" source={tenancy.source} />}
      <section className="bg-white p-4 rounded-lg shadow-sm border border-gray-100">
        <ActionForm
          action={saveSettingAction.bind(null, 'tenancy')}
          submitLabel={t('save')}
          className="space-y-3"
        >
          {(['anyone', 'verified_domains', 'instance_admins'] as const).map((value) => (
            <label key={value} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="creation"
                value={value}
                defaultChecked={creation === value}
              />
              {t(`tenancy_${value}`)}
            </label>
          ))}
          <label className="text-sm space-y-1 block">
            <span>{t('tenancyAllowedDomains')}</span>
            <input
              name="allowedDomains"
              defaultValue={(tenancy?.value.allowedDomains ?? []).join(', ')}
              placeholder="acme.com, acme.co.uk"
              className={input}
            />
          </label>
        </ActionForm>
      </section>
    </div>
  );
}
