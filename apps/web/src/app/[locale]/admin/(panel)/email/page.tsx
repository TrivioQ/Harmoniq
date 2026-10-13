// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/routing';
import { ActionForm } from '@/components/ActionForm';
import { EMAIL_TEMPLATES, adminApi } from '@/lib/adminApi';
import { saveEmailTemplatesAction, saveSettingAction, testEmailAction } from '../actions';
import { SettingSource } from '../SettingSource';

const input = 'block w-full rounded-md border px-3 py-1.5 text-sm';

/** INST-12, INST-38: outbound email, the delivery log and the templates' wording. */
export default async function AdminEmailPage(props: {
  searchParams: Promise<{ to?: string; status?: string; cursor?: string }>;
}) {
  const q = await props.searchParams;
  const t = await getTranslations('AdminSettings');
  const tl = await getTranslations('AdminEmailLog');
  const format = await getFormatter();
  const [{ email, emailTemplates }, log] = await Promise.all([
    adminApi.settings(),
    adminApi.emailDeliveries(q),
  ]);
  const templates = emailTemplates?.source === 'database' ? emailTemplates.value : {};
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

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-gray-900">{tl('templates')}</h2>
        <p className="text-sm text-gray-600">{tl('templatesHint')}</p>
        <ActionForm
          action={saveEmailTemplatesAction.bind(null, EMAIL_TEMPLATES)}
          submitLabel={t('save')}
          className="space-y-3 bg-white p-4 rounded-lg shadow-sm border border-gray-100"
        >
          {EMAIL_TEMPLATES.map((name) => (
            <fieldset key={name} className="grid gap-2 sm:grid-cols-2 border-t pt-3 first:border-0">
              <legend className="text-sm font-medium text-gray-800">
                {tl(`template_${name}`)}
              </legend>
              {field(`${name}.subject`, tl('subject'), {
                maxLength: 200,
                defaultValue: templates[name]?.subject,
                placeholder: tl('defaultSubject'),
              })}
              <label className="text-sm space-y-1 block">
                <span>{tl('intro')}</span>
                <textarea
                  name={`${name}.intro`}
                  maxLength={2000}
                  rows={2}
                  defaultValue={templates[name]?.intro}
                  className={input}
                />
              </label>
            </fieldset>
          ))}
        </ActionForm>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-gray-900">{tl('title')}</h2>
        <p className="text-sm text-gray-600">{tl('hint')}</p>
        <form className="flex flex-wrap gap-2">
          <input
            name="to"
            defaultValue={q.to}
            placeholder={tl('recipient')}
            aria-label={tl('recipient')}
            className="rounded-md border px-3 py-1.5 text-sm w-64"
          />
          <select
            name="status"
            defaultValue={q.status ?? ''}
            aria-label={tl('status')}
            className="rounded-md border px-2 py-1.5 text-sm"
          >
            <option value="">{tl('allResults')}</option>
            <option value="sent">{tl('sent')}</option>
            <option value="failed">{tl('failed')}</option>
          </select>
          <button className="rounded-md border px-3 py-1.5 text-sm bg-white">{tl('filter')}</button>
        </form>
        {log.deliveries.length === 0 ? (
          <p className="text-sm text-gray-500">{tl('empty')}</p>
        ) : (
          <table className="w-full bg-white rounded-lg shadow-sm border border-gray-100 text-sm">
            <tbody>
              {log.deliveries.map((d) => (
                <tr key={d.id} className="border-t align-top">
                  <td className="p-2 whitespace-nowrap text-gray-500">
                    {format.dateTime(new Date(d.createdAt), 'short')}
                  </td>
                  <td className="p-2 break-all">{d.to}</td>
                  <td className="p-2 text-xs">{tl(`template_${d.template}`)}</td>
                  <td
                    className={`p-2 text-xs ${d.status === 'sent' ? 'text-green-700' : 'text-red-700'}`}
                  >
                    {d.status === 'sent' ? tl('sent') : tl('failed')}
                    {d.error && <span className="block break-all text-gray-600">{d.error}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {log.nextCursor && (
          <Link
            href={`/admin/email?${new URLSearchParams({
              ...(q.to && { to: q.to }),
              ...(q.status && { status: q.status }),
              cursor: log.nextCursor,
            })}`}
            className="text-sm text-indigo-600"
          >
            {tl('next')}
          </Link>
        )}
      </section>
    </div>
  );
}
