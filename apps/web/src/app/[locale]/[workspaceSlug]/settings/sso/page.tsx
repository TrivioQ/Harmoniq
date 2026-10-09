import { getTranslations } from 'next-intl/server';
import { ActionForm } from '@/components/ActionForm';
import { getAppUrl } from '@/lib/env';
import { workspaceApi } from '@/lib/workspaceApi';
import { deleteSsoAction, saveSsoAction } from '../../actions';

const input = 'block w-full rounded-md border px-3 py-1.5 text-sm';

/** SSO-03: a workspace's OpenID Connect sign-in. */
export default async function SsoSettingsPage(props: {
  params: Promise<{ workspaceSlug: string }>;
}) {
  const { workspaceSlug } = await props.params;
  const t = await getTranslations('SsoPage');
  const { oidc } = await workspaceApi.sso(workspaceSlug);
  const callback = `${getAppUrl()}/api/auth/callback/${encodeURIComponent(`oidc:${workspaceSlug}`)}`;
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

  return (
    <div className="space-y-4 max-w-3xl">
      <p className="text-sm text-muted-foreground">{t('description')}</p>
      <div className="rounded-xl border bg-card p-4 space-y-1">
        <div className="text-sm font-medium">{t('callback')}</div>
        <code className="block text-xs break-all">{callback}</code>
        <p className="text-xs text-muted-foreground">{t('loginHint')}</p>
      </div>
      <section className="rounded-xl border bg-card p-4">
        <ActionForm
          action={saveSsoAction.bind(null, workspaceSlug)}
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
          <label className="text-sm space-y-1 block sm:col-span-2">
            <span>{t('roleMapping')}</span>
            <textarea
              name="roleMapping"
              rows={4}
              defaultValue={Object.entries(oidc?.roleMapping ?? {})
                .map(([group, role]) => `${group} = ${role}`)
                .join('\n')}
              className={`${input} font-mono`}
            />
          </label>
          <label className="text-sm space-y-1 block">
            <span>{t('defaultRole')}</span>
            <select
              name="defaultRole"
              defaultValue={oidc?.defaultRole ?? 'viewer'}
              className={input}
            >
              {['viewer', 'developer', 'admin'].map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm flex items-center gap-2 sm:col-span-2">
            <input type="checkbox" name="forceSso" defaultChecked={oidc?.forceSso ?? false} />
            {t('forceSso')}
          </label>
        </ActionForm>
      </section>
      {oidc && (
        <ActionForm
          action={deleteSsoAction.bind(null, workspaceSlug)}
          submitLabel={t('remove')}
          confirm={t('removeConfirm')}
          variant="danger"
        />
      )}
    </div>
  );
}
