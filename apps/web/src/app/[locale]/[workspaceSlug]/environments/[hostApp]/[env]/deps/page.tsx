import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/routing';
import { RegistryError } from '@/lib/registry';
import { workspaceApi } from '@/lib/workspaceApi';

const HOST_SOURCE = '(host)';

/** DEP-04: packages × modules, conflicting cells in red. */
export default async function DependencyMatrixPage(props: {
  params: Promise<{ workspaceSlug: string; hostApp: string; env: string }>;
}) {
  const { workspaceSlug, hostApp, env } = await props.params;
  const t = await getTranslations('DependencyMatrix');
  const matrix = await workspaceApi.dependencies(workspaceSlug, hostApp, env).catch((err) => {
    if (err instanceof RegistryError && err.status === 404) notFound();
    throw err;
  });

  // Cells (package × source) that take part in a conflict, with what they clash with.
  const clashes = new Map<string, string[]>();
  for (const c of matrix.conflicts) {
    for (const side of c.between) {
      const others = c.between.filter((b) => b !== side).map((b) => `${b.range} (${b.source})`);
      const key = `${c.package}|${side.source}`;
      clashes.set(key, [
        ...(clashes.get(key) ?? []),
        ...(c.reason === 'invalid_range' ? [t('invalid')] : others),
      ]);
    }
  }
  const label = (source: string) => (source === HOST_SOURCE ? t('host') : source);

  return (
    <div className="container p-6 md:p-10 max-w-6xl space-y-6">
      <div>
        <Link
          href={`/${workspaceSlug}/environments`}
          className="text-sm text-muted-foreground hover:underline"
        >
          ← {t('back')}
        </Link>
        <h2 className="text-3xl font-bold tracking-tight mt-2">
          {t('title', { hostApp: matrix.hostApp, env: matrix.environment })}
        </h2>
        <p className="text-muted-foreground mt-2 max-w-3xl">{t('description')}</p>
        <p
          className={`mt-2 text-sm font-medium ${matrix.conflicts.length ? 'text-red-700' : 'text-green-700'}`}
        >
          {t('conflicts', { count: matrix.conflicts.length })}
        </p>
      </div>

      {matrix.packages.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <div className="rounded-xl border bg-card overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className="px-4 py-2 font-medium">{t('package')}</th>
                {matrix.sources.map((s) => (
                  <th key={s.name} className="px-4 py-2 font-medium">
                    {label(s.name)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {matrix.packages.map((pkg) => (
                <tr key={pkg}>
                  <th scope="row" className="px-4 py-2 text-left font-mono font-normal">
                    {pkg}
                  </th>
                  {matrix.sources.map((s) => {
                    const range = s.dependencies[pkg];
                    const clash = clashes.get(`${pkg}|${s.name}`);
                    return (
                      <td
                        key={s.name}
                        className={`px-4 py-2 font-mono ${clash ? 'bg-red-50 text-red-800' : ''}`}
                        title={clash?.join(', ')}
                      >
                        {range ?? <span className="text-muted-foreground">—</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-muted-foreground font-mono">{t('sharedHint')}</p>
    </div>
  );
}
