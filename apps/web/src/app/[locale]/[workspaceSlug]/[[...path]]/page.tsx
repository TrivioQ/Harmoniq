import { permanentRedirect } from 'next/navigation';

/**
 * ORG-15: workspace pages live under `/w/:workspaceSlug`, so no workspace slug can
 * clash with a dashboard path (`/orgs`, `/admin`, …). Links to the old
 * `/:workspaceSlug/…` URLs keep working through this redirect.
 */
export default async function LegacyWorkspaceRedirect(props: {
  params: Promise<{ locale: string; workspaceSlug: string; path?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale, workspaceSlug, path = [] } = await props.params;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await props.searchParams)) {
    for (const v of Array.isArray(value) ? value : value ? [value] : []) query.append(key, v);
  }
  const rest = [workspaceSlug, ...path].map(encodeURIComponent).join('/');
  permanentRedirect(`/${locale}/w/${rest}${query.size ? `?${query}` : ''}`);
}
