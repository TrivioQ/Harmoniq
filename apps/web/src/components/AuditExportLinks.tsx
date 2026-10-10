import { getTranslations } from 'next-intl/server';

/** Compliance export of an audit log (every event matching the filter), as CSV or JSONL. */
export async function AuditExportLinks({
  scope,
  slug,
  action,
  workspace,
}: {
  scope: 'workspace' | 'org' | 'instance';
  slug?: string;
  action?: string;
  /** Organization exports: one workspace only. */
  workspace?: string;
}) {
  const t = await getTranslations('AuditExport');
  const href = (format: 'csv' | 'jsonl') =>
    `/api/audit-export?${new URLSearchParams({
      scope,
      format,
      ...(slug && { slug }),
      ...(action && { action }),
      ...(workspace && { workspace }),
    })}`;
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="text-muted-foreground">{t('label')}</span>
      {/* Plain anchors: downloads from a route handler, not pages. */}
      <a href={href('csv')} className="underline hover:text-primary" download>
        CSV
      </a>
      <a href={href('jsonl')} className="underline hover:text-primary" download>
        JSON Lines
      </a>
    </div>
  );
}
