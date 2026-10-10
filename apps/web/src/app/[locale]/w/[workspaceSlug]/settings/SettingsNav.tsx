'use client';

import { Link, usePathname } from '@/i18n/routing';

export function SettingsNav({
  workspaceSlug,
  labels,
}: {
  workspaceSlug: string;
  labels: {
    storage: string;
    keys: string;
    members: string;
    webhooks: string;
    alerts: string;
    approvals: string;
    sso: string;
    provisioning: string;
  };
}) {
  const pathname = usePathname();
  const base = `/w/${workspaceSlug}/settings`;
  const items = [
    [base, labels.storage],
    [`${base}/keys`, labels.keys],
    [`${base}/members`, labels.members],
    [`${base}/webhooks`, labels.webhooks],
    [`${base}/alerts`, labels.alerts],
    [`${base}/approvals`, labels.approvals],
    [`${base}/sso`, labels.sso],
    [`${base}/provisioning`, labels.provisioning],
  ] as const;
  return (
    <nav className="flex md:flex-col gap-1 text-sm">
      {items.map(([href, label]) => (
        <Link
          key={href}
          href={href}
          className={`rounded-md px-3 py-1.5 ${pathname === href ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/50'}`}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
