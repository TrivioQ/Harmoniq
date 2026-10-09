import { getFormatter, getTranslations } from 'next-intl/server';
import { ActionForm } from '@/components/ActionForm';
import { roleAtLeast, workspaceApi } from '@/lib/workspaceApi';
import { cancelScheduledAction } from '../actions';

const statusStyle: Record<string, string> = {
  pending: 'bg-blue-100 text-blue-800',
  running: 'bg-amber-100 text-amber-800',
  done: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
  cancelled: 'bg-muted text-muted-foreground',
};

const TYPES = [
  'deploy',
  'promote',
  'rollback',
  'canary_traffic',
  'canary_promote',
  'canary_abort',
  'kill_switch',
] as const;

export default async function ScheduledPage(props: { params: Promise<{ workspaceSlug: string }> }) {
  const { workspaceSlug } = await props.params;
  const t = await getTranslations('ScheduledPage');
  const format = await getFormatter();
  const [{ operations }, workspace] = await Promise.all([
    workspaceApi.scheduled(workspaceSlug),
    workspaceApi.get(workspaceSlug),
  ]);
  const canCancel = roleAtLeast(workspace.role, 'developer');
  const typeLabel = (type: string) =>
    TYPES.includes(type as (typeof TYPES)[number])
      ? t(`types.${type as (typeof TYPES)[number]}`)
      : type;

  return (
    <div className="container p-6 md:p-10 max-w-6xl space-y-6">
      <div>
        <h2 className="text-3xl font-bold tracking-tight">{t('title')}</h2>
        <p className="text-muted-foreground mt-2 max-w-3xl">{t('description')}</p>
        <p className="text-xs text-muted-foreground mt-2 font-mono">{t('hint')}</p>
      </div>
      <ul className="rounded-xl border bg-card divide-y">
        {operations.map((op) => (
          <li key={op.id} className="p-4 flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="font-medium">
                  {typeLabel(op.type)} · {op.module}
                  {op.environment && ` → ${op.environment}`}
                </span>
                <span className={`rounded px-2 py-0.5 text-xs ${statusStyle[op.status] ?? ''}`}>
                  {t(`statuses.${op.status}`)}
                </span>
              </div>
              <div className="text-sm text-muted-foreground">
                <time dateTime={op.runAt}>
                  {format.dateTime(new Date(op.runAt), { dateStyle: 'medium', timeStyle: 'short' })}
                </time>
                {op.description && ` · ${op.description}`}
              </div>
              {op.error && <div className="text-xs text-red-700">{op.error}</div>}
            </div>
            {canCancel && op.status === 'pending' && (
              <ActionForm
                action={cancelScheduledAction.bind(null, workspaceSlug, op.id)}
                submitLabel={t('cancel')}
                confirm={t('cancelConfirm')}
                variant="outline"
              />
            )}
          </li>
        ))}
        {operations.length === 0 && (
          <li className="p-6 text-sm text-muted-foreground">{t('empty')}</li>
        )}
      </ul>
    </div>
  );
}
