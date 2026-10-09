import { getFormatter, getTranslations } from 'next-intl/server';
import { ActionForm } from '@/components/ActionForm';
import { workspaceApi } from '@/lib/workspaceApi';
import { disableScimAction, rotateScimTokenAction } from '../../actions';

/** SSO-24: SCIM provisioning from the workspace's identity provider. */
export default async function ProvisioningPage(props: {
  params: Promise<{ workspaceSlug: string }>;
}) {
  const { workspaceSlug } = await props.params;
  const t = await getTranslations('ProvisioningPage');
  const format = await getFormatter();
  const [scim, { events }] = await Promise.all([
    workspaceApi.scim(workspaceSlug),
    workspaceApi.scimEvents(workspaceSlug),
  ]);

  return (
    <div className="space-y-4 max-w-3xl">
      <p className="text-sm text-muted-foreground">{t('description')}</p>
      <section className="rounded-xl border bg-card p-4 space-y-3">
        <dl className="grid gap-x-3 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-muted-foreground">{t('baseUrl')}</dt>
          <dd>
            <code className="break-all text-xs">{scim.baseUrl}</code>
          </dd>
          <dt className="text-muted-foreground">{t('status')}</dt>
          <dd>
            {scim.enabled
              ? t('enabled', {
                  since: format.dateTime(new Date(scim.tokenCreatedAt!), 'short'),
                  users: scim.users,
                  groups: scim.groups,
                })
              : t('disabled')}
          </dd>
        </dl>
        <p className="text-xs text-muted-foreground">{t('howItWorks')}</p>
        <div className="flex gap-2">
          <ActionForm
            action={rotateScimTokenAction.bind(null, workspaceSlug)}
            submitLabel={scim.enabled ? t('rotate') : t('enable')}
            confirm={scim.enabled ? t('rotateConfirm') : undefined}
            secretHint={t('copyOnce')}
          />
          {scim.enabled && (
            <ActionForm
              action={disableScimAction.bind(null, workspaceSlug)}
              submitLabel={t('disable')}
              confirm={t('disableConfirm')}
              variant="danger"
            />
          )}
        </div>
      </section>

      <section className="rounded-xl border bg-card p-4 space-y-2">
        <h3 className="font-semibold text-sm">{t('events')}</h3>
        {events.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('noEvents')}</p>
        ) : (
          <table className="w-full text-xs">
            <tbody>
              {events.map((e) => (
                <tr key={e.id} className="border-t">
                  <td className="py-1 pr-2 whitespace-nowrap">
                    {format.dateTime(new Date(e.createdAt), 'short')}
                  </td>
                  <td className="py-1 pr-2 font-mono">{e.operation}</td>
                  <td className="py-1 pr-2 font-mono break-all">
                    {String(
                      (e.payload as { userName?: string; displayName?: string }).userName ??
                        (e.payload as { displayName?: string }).displayName ??
                        e.scimUserId
                    )}
                  </td>
                  <td className={`py-1 ${e.statusCode >= 400 ? 'text-red-600' : ''}`}>
                    {e.statusCode}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
