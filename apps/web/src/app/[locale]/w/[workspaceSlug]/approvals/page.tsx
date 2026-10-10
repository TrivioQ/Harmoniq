import { getFormatter, getTranslations } from 'next-intl/server';
import { ActionForm } from '@/components/ActionForm';
import { workspaceApi, type ApprovalRequest } from '@/lib/workspaceApi';
import { bypassApprovalAction, decideApprovalAction } from '../actions';

const statusStyle: Record<string, string> = {
  pending_approval: 'bg-blue-100 text-blue-800',
  executing: 'bg-amber-100 text-amber-800',
  executed: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
  rejected: 'bg-red-100 text-red-800',
  expired: 'bg-muted text-muted-foreground',
};

/** APR-16: the review queue, with the full chain of each request (APR-18). */
export default async function ApprovalsPage(props: { params: Promise<{ workspaceSlug: string }> }) {
  const { workspaceSlug } = await props.params;
  const t = await getTranslations('ApprovalsPage');
  const format = await getFormatter();
  const [{ requests }, workspace] = await Promise.all([
    workspaceApi.approvals(workspaceSlug),
    workspaceApi.get(workspaceSlug),
  ]);
  const pending = requests.filter((r) => r.status === 'pending_approval');
  const decided = requests.filter((r) => r.status !== 'pending_approval');
  const isOwner = workspace.role === 'owner';
  const when = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });

  const card = (r: ApprovalRequest) => (
    <li key={r.id} className="p-4 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">
          {r.type} · {r.module} → {r.environment}
        </span>
        <span className={`rounded px-2 py-0.5 text-xs ${statusStyle[r.status] ?? ''}`}>
          {t(`statuses.${r.status}`)}
        </span>
        {r.bypassed && <span className="text-xs font-medium text-red-700">⚠️ BYPASSED</span>}
        {r.changeTicket &&
          (r.changeTicket.url ? (
            <a href={r.changeTicket.url} className="font-mono text-xs text-primary underline">
              {r.changeTicket.id}
            </a>
          ) : (
            <span className="font-mono text-xs">{r.changeTicket.id}</span>
          ))}
      </div>
      <div className="text-sm text-muted-foreground">
        {t('requestedBy', { who: r.requestedBy.email ?? t('apiKey') })} · {when(r.createdAt)} ·{' '}
        {t('approvals', {
          count: r.approvals.filter((a) => a.decision === 'approved').length,
          required: r.requiredApprovers,
        })}
        {r.status === 'pending_approval' && ` · ${t('expires', { when: when(r.expiresAt) })}`}
      </div>
      <pre className="text-xs bg-muted/50 rounded p-2 overflow-x-auto">
        {JSON.stringify(r.request, null, 2)}
      </pre>
      {r.approvals.length > 0 && (
        <ul className="text-sm">
          {r.approvals.map((a) => (
            <li key={a.approverId}>
              {a.decision === 'approved' ? '✓' : '✗'} {a.approverEmail ?? a.approverId} ·{' '}
              {when(a.decidedAt)}
              {a.comment && <span className="text-muted-foreground"> — {a.comment}</span>}
            </li>
          ))}
        </ul>
      )}
      {r.bypassJustification && <p className="text-sm text-red-800">⚠️ {r.bypassJustification}</p>}
      {r.status === 'pending_approval' &&
        (r.canDecide ? (
          <div className="flex flex-wrap items-start gap-2">
            <ActionForm
              action={decideApprovalAction.bind(null, workspaceSlug, r.id, 'approve')}
              submitLabel={t('approve')}
              className="flex flex-wrap items-center gap-2"
            >
              <input
                name="comment"
                maxLength={1000}
                placeholder={t('comment')}
                aria-label={t('comment')}
                className="rounded-md border px-2 py-1.5 text-sm w-72"
              />
            </ActionForm>
            <ActionForm
              action={decideApprovalAction.bind(null, workspaceSlug, r.id, 'reject')}
              submitLabel={t('reject')}
              confirm={t('rejectConfirm')}
              variant="danger"
            />
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            {t('cannotDecide', { reason: r.cannotDecideBecause ?? '' })}
          </p>
        ))}
      {r.status === 'pending_approval' && isOwner && (
        <details className="text-sm">
          <summary className="cursor-pointer text-red-700">{t('bypass')}</summary>
          <p className="mt-1 text-xs text-muted-foreground">{t('bypassHint')}</p>
          <ActionForm
            action={bypassApprovalAction.bind(null, workspaceSlug, r.id)}
            submitLabel={t('bypass')}
            confirm={t('bypassConfirm')}
            variant="danger"
            className="mt-2 flex flex-wrap items-center gap-2"
          >
            <input
              name="justification"
              required
              minLength={20}
              placeholder={t('justification')}
              aria-label={t('justification')}
              className="rounded-md border px-2 py-1.5 text-sm w-96"
            />
          </ActionForm>
        </details>
      )}
    </li>
  );

  return (
    <div className="container p-6 md:p-10 max-w-6xl space-y-6">
      <div>
        <h2 className="text-3xl font-bold tracking-tight">{t('title')}</h2>
        <p className="text-muted-foreground mt-2 max-w-3xl">{t('description')}</p>
      </div>
      <section className="space-y-2">
        <h3 className="font-semibold">{t('pending')}</h3>
        <ul className="rounded-xl border bg-card divide-y">
          {pending.map(card)}
          {pending.length === 0 && (
            <li className="p-6 text-sm text-muted-foreground">{t('empty')}</li>
          )}
        </ul>
      </section>
      {decided.length > 0 && (
        <section className="space-y-2">
          <h3 className="font-semibold">{t('recent')}</h3>
          <ul className="rounded-xl border bg-card divide-y">{decided.map(card)}</ul>
        </section>
      )}
    </div>
  );
}
