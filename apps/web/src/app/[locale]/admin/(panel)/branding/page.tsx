import { getTranslations } from 'next-intl/server';
import { ActionForm } from '@/components/ActionForm';
import { adminApi } from '@/lib/adminApi';
import { saveSettingAction } from '../actions';
import { SettingSource } from '../SettingSource';

const input = 'block w-full rounded-md border px-3 py-1.5 text-sm';

/** INST-14: the instance's name and look (dashboard header, emails). */
export default async function AdminBrandingPage() {
  const t = await getTranslations('AdminSettings');
  const { branding } = await adminApi.settings();
  const v = branding.value;
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
      <h1 className="text-2xl font-bold text-gray-900">{t('brandingTitle')}</h1>
      <SettingSource settingKey="branding" source={branding.source} />
      <section className="bg-white p-4 rounded-lg shadow-sm border border-gray-100">
        <ActionForm
          action={saveSettingAction.bind(null, 'branding')}
          submitLabel={t('save')}
          className="grid gap-3 sm:grid-cols-2"
        >
          {field('name', t('brandName'), { required: true, maxLength: 60, defaultValue: v.name })}
          {field('accentColor', t('brandAccent'), {
            defaultValue: v.accentColor,
            placeholder: '#4f46e5',
            pattern: '#[0-9a-fA-F]{6}',
          })}
          {field('logoUrl', t('brandLogo'), { type: 'url', defaultValue: v.logoUrl })}
          {field('supportUrl', t('brandSupport'), { type: 'url', defaultValue: v.supportUrl })}
        </ActionForm>
      </section>
    </div>
  );
}
