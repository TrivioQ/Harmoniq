import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/routing';
import { CopyButton } from '@/components/CopyButton';
import { getPublicRegistryUrl } from '@/lib/env';
import { workspaceApi } from '@/lib/workspaceApi';

/** DX-04 / ADP-05: copy-paste integration for this workspace's host apps. */
export default async function QuickstartPage(props: {
  params: Promise<{ workspaceSlug: string }>;
  searchParams: Promise<{ host?: string; env?: string }>;
}) {
  const { workspaceSlug: ws } = await props.params;
  const query = await props.searchParams;
  const t = await getTranslations('QuickstartPage');
  const [workspace, { modules }] = await Promise.all([
    workspaceApi.get(ws),
    workspaceApi.modules(ws),
  ]);

  const host = workspace.hostApps.find((h) => h.slug === query.host) ?? workspace.hostApps[0];
  if (!host) return <p className="p-10 text-muted-foreground">{t('noHostApps')}</p>;
  const env = host.environments.find((e) => e.slug === query.env) ?? host.environments[0];
  const registry = getPublicRegistryUrl();
  const moduleSlug = modules.find((m) => m.hostApp.slug === host.slug)?.slug ?? 'checkout';
  const cdn = env?.published?.manifestUrl?.replace(/\/manifests\/.*$/, '');
  const envSlug = env?.slug ?? 'production';

  const clientOptions = `{
  registryUrl: '${registry}',${cdn ? `\n  cdnBaseUrl: '${cdn}',` : ''}
  workspaceSlug: '${ws}',
  hostApp: '${host.slug}',
  environment: '${envSlug}',
  pollIntervalMs: 30_000,
}`;

  const sections: Array<{ id: string; title: string; hint?: string; code: string }> = [
    {
      id: 'ci',
      title: t('sections.ci'),
      hint: t('hints.ci'),
      code: `export HARMONIQ_REGISTRY_URL=${registry}
export HARMONIQ_WORKSPACE=${ws}
export HARMONIQ_API_KEY=hq_…   # Settings → API keys (deploy:write)

npx @harmoniq/cli deploy --module ${moduleSlug} --env ${envSlug} \\
  --release "$GITHUB_SHA" \\
  --url "https://cdn.example.com/${moduleSlug}/$GITHUB_SHA/remoteEntry.js" \\
  --file dist/remoteEntry.js`,
    },
    {
      id: 'action',
      title: t('sections.action'),
      code: `- uses: <org>/harmoniq/actions/deploy@v1
  with:
    registry-url: ${registry}
    api-key: \${{ secrets.HARMONIQ_API_KEY }}
    workspace: ${ws}
    module: ${moduleSlug}
    environment: ${envSlug}
    version: \${{ github.sha }}
    url: https://cdn.example.com/${moduleSlug}/\${{ github.sha }}/remoteEntry.js
    file: dist/remoteEntry.js`,
    },
    {
      id: 'react',
      title: 'React',
      code: `import { HarmoniqProvider, useRemoteModule } from '@harmoniq/client/react';

const options = ${clientOptions};

<HarmoniqProvider options={options}>
  <App />
</HarmoniqProvider>

const { url, integrity, loading } = useRemoteModule('${moduleSlug}');`,
    },
    {
      id: 'mf',
      title: t('sections.mf'),
      code: `import { init, loadRemote } from '@module-federation/enhanced/runtime';
import { HarmoniqClient } from '@harmoniq/client';
import { harmoniqPlugin } from '@harmoniq/mf-plugin';

const client = new HarmoniqClient(${clientOptions.replace(/\n/g, '\n  ')});
init({ name: '${host.slug}', remotes: [], plugins: [harmoniqPlugin(client)] });

const mod = await loadRemote('${moduleSlug}/…');`,
    },
    {
      id: 'vue',
      title: 'Vue',
      code: `import { createHarmoniq, useHarmoniq } from '@harmoniq/client/vue';

app.use(createHarmoniq(${clientOptions.replace(/\n/g, '\n  ')}));

const { url, integrity } = useHarmoniq('${moduleSlug}');`,
    },
    {
      id: 'angular',
      title: 'Angular',
      code: `import { HARMONIQ_OPTIONS, HarmoniqService } from '@harmoniq/client/angular';

providers: [{ provide: HARMONIQ_OPTIONS, useValue: ${clientOptions.replace(/\n/g, '\n  ')} }]

harmoniq.getModule('${moduleSlug}').subscribe(({ url, integrity }) => …);`,
    },
    {
      id: 'importmap',
      title: t('sections.importMap'),
      hint: t('hints.importMap'),
      code: `<script type="importmap-shim" src="${registry}/api/importmap/${ws}/${host.slug}/${envSlug}"></script>
<script async src="https://ga.jspm.io/npm:es-module-shims@1.10.0/dist/es-module-shims.js"></script>
<script type="module-shim">
  import { mount } from '${moduleSlug}';
</script>`,
    },
    {
      id: 'federation',
      title: 'Native Federation',
      code: `await initFederation('${registry}/api/federation-manifest/${ws}/${host.slug}/${envSlug}');`,
    },
  ];

  const href = (h: string, e: string) => `/${ws}/quickstart?host=${h}&env=${e}`;

  return (
    <div className="container p-6 md:p-10 max-w-5xl space-y-8">
      <div>
        <h2 className="text-3xl font-bold tracking-tight">{t('title')}</h2>
        <p className="text-muted-foreground mt-2">{t('description')}</p>
      </div>

      <nav className="flex flex-wrap gap-2 text-sm" aria-label={t('target')}>
        {workspace.hostApps.flatMap((h) =>
          h.environments.map((e) => (
            <Link
              key={`${h.slug}/${e.slug}`}
              href={href(h.slug, e.slug)}
              className={`rounded-full border px-3 py-1 ${h.slug === host.slug && e.slug === envSlug ? 'bg-primary text-primary-foreground' : 'bg-background'}`}
            >
              {h.name} / {e.name}
            </Link>
          ))
        )}
      </nav>

      <dl className="rounded-xl border bg-card p-4 text-sm grid gap-2">
        <div>
          <dt className="text-muted-foreground">{t('manifestUrl')}</dt>
          <dd className="font-mono break-all">{`${registry}/api/manifest/${ws}/${host.slug}/${envSlug}`}</dd>
        </div>
        {env?.published?.manifestUrl && (
          <div>
            <dt className="text-muted-foreground">{t('publishedUrl')}</dt>
            <dd className="font-mono break-all">{env.published.manifestUrl}</dd>
          </div>
        )}
      </dl>

      {sections.map((section) => (
        <section key={section.id} className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold">{section.title}</h3>
            <CopyButton text={section.code} label={t('copy')} copiedLabel={t('copied')} />
          </div>
          {section.hint && <p className="text-sm text-muted-foreground">{section.hint}</p>}
          <pre className="rounded-lg border bg-muted/40 p-4 text-xs overflow-x-auto">
            <code>{section.code}</code>
          </pre>
        </section>
      ))}
    </div>
  );
}
