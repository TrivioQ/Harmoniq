import { getTranslations } from 'next-intl/server';
import { ActionForm } from '@/components/ActionForm';
import { adminApi } from '@/lib/adminApi';
import { saveSettingAction } from '../actions';
import { SettingSource } from '../SettingSource';

const input = 'block w-full rounded-md border px-3 py-1.5 text-sm';

/** INST-13: sign-in methods for the whole instance. */
export default async function AdminAuthPage() {
  const t = await getTranslations('AdminSettings');
  const { auth } = await adminApi.settings();
  const v = auth.value;
  const toggle = (name: string, label: string, on: boolean | undefined) => (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" name={name} defaultChecked={on ?? true} />
      {label}
    </label>
  );

  return (
    <div className="space-y-6 max-w-3xl">
      <h1 className="text-2xl font-bold text-gray-900">{t('authTitle')}</h1>
      <p className="text-sm text-gray-600">{t('authDescription')}</p>
      <SettingSource settingKey="auth" source={auth.source} />
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
        </ActionForm>
      </section>
    </div>
  );
}
