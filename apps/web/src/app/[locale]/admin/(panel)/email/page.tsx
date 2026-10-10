import { getTranslations } from 'next-intl/server';
import { ActionForm } from '@/components/ActionForm';
import { adminApi } from '@/lib/adminApi';
import { saveSettingAction, testEmailAction } from '../actions';
import { SettingSource } from '../SettingSource';

const input = 'block w-full rounded-md border px-3 py-1.5 text-sm';

/** INST-12: outbound email (sign-in links, notifications). */
export default async function AdminEmailPage() {
  const t = await getTranslations('AdminSettings');
  const { email } = await adminApi.settings();
  const v = email.value;
  const field = (
    name: string,
    label: string,
    props: React.InputHTMLAttributes<HTMLInputElement>
  ) => (
    <label className="text-sm space-y-1 block">
      <span>{label}</span>
      <input name={name} className={input} {...props} />
    </label>
  );

  return (
    <div className="space-y-6 max-w-3xl">
      <h1 className="text-2xl font-bold text-gray-900">{t('emailTitle')}</h1>
      <p className="text-sm text-gray-600">{t('emailDescription')}</p>
      <SettingSource settingKey="email" source={email.source} />
      {email.source === 'environment' && v.smtpUrl && (
        <p className="text-xs text-gray-500">{t('emailFromEnv')}</p>
      )}
      <section className="bg-white p-4 rounded-lg shadow-sm border border-gray-100">
        <ActionForm
          action={saveSettingAction.bind(null, 'email')}
          submitLabel={t('save')}
          className="grid gap-3 sm:grid-cols-2"
        >
          {field('host', t('smtpHost'), {
            required: true,
            defaultValue: v.host,
            placeholder: 'smtp.example.com',
          })}
          {field('port', t('smtpPort'), {
            required: true,
            type: 'number',
            defaultValue: v.port ?? 587,
          })}
          <label className="text-sm space-y-1 block">
            <span>{t('smtpSecurity')}</span>
            <select name="security" defaultValue={v.security ?? 'starttls'} className={input}>
              <option value="starttls">STARTTLS (587)</option>
              <option value="tls">TLS (465)</option>
              <option value="none">{t('smtpPlain')}</option>
            </select>
          </label>
          {field('from', t('smtpFrom'), {
            required: true,
            defaultValue: v.from,
            placeholder: 'Harmoniq <no-reply@example.com>',
          })}
          {field('username', t('smtpUsername'), { defaultValue: v.username, autoComplete: 'off' })}
          {field('password', t('smtpPassword'), {
            type: 'password',
            autoComplete: 'off',
            placeholder: v.password ? t('keepSecret', { masked: v.password }) : '',
          })}
        </ActionForm>
      </section>
      <ActionForm action={testEmailAction} submitLabel={t('sendTest')} variant="outline" />
    </div>
  );
}
