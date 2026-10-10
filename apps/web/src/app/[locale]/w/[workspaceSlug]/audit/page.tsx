import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/routing';
import { workspaceApi } from '@/lib/workspaceApi';
import { AuditLine } from '../AuditLine';
import { AuditExportLinks } from '@/components/AuditExportLinks';

const FILTERS = ['', 'module.', 'env.', 'apiKey.', 'member.', 'webhook.'] as const;

/** AUD-03: filterable, paginated audit log. */
export default async function AuditPage(props: {
  params: Promise<{ workspaceSlug: string }>;
  searchParams: Promise<{ action?: string; cursor?: string }>;
}) {
  const { workspaceSlug } = await props.params;
  const { action, cursor } = await props.searchParams;
  const t = await getTranslations('AuditPage');
  const format = await getFormatter();
  const { role } = await workspaceApi.get(workspaceSlug);
  const { events, nextCursor } = await workspaceApi.audit(workspaceSlug, {
    action,
    cursor,
    limit: '50',
  });

  const href = (params: Record<string, string | undefined>) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v) as [string, string][]
    );
    return `/w/${workspaceSlug}/audit${qs.size ? `?${qs}` : ''}`;
  };

  return (
    <div className="container p-6 md:p-10 max-w-5xl space-y-6">
      <div>
        <h2 className="text-3xl font-bold tracking-tight">{t('title')}</h2>
        <p className="text-muted-foreground mt-2">{t('description')}</p>
      </div>
      {(role === 'admin' || role === 'owner') && (
        <AuditExportLinks scope="workspace" slug={workspaceSlug} action={action} />
      )}

      <nav className="flex flex-wrap gap-2" aria-label={t('filter')}>
        {FILTERS.map((f) => (
          <Link
            key={f}
            href={href({ action: f || undefined })}
            className={`rounded-full border px-3 py-1 text-sm ${(action ?? '') === f ? 'bg-primary text-primary-foreground' : 'bg-background'}`}
          >
            {t(`filters.${f ? f.replace('.', '') : 'all'}`)}
          </Link>
        ))}
      </nav>

      <ul className="rounded-xl border bg-card divide-y">
        {events.map((event) => (
          <li key={event.id} className="px-5 py-3 flex justify-between gap-4 text-sm">
            <AuditLine event={event} />
            <time className="text-muted-foreground whitespace-nowrap" dateTime={event.createdAt}>
              {format.dateTime(new Date(event.createdAt), {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            </time>
          </li>
        ))}
        {events.length === 0 && <li className="p-6 text-muted-foreground text-sm">{t('empty')}</li>}
      </ul>

      {nextCursor && (
        <Link
          href={href({ action, cursor: nextCursor })}
          className="text-sm text-primary hover:underline"
        >
          {t('older')}
        </Link>
      )}
    </div>
  );
}
