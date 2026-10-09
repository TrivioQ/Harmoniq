import { Command } from 'commander';
import { validateBundle } from '@harmoniq/core/dist/validation/bundle';
import { ApiClient } from '../lib/api';
import { requireWorkspace, resolveContext } from '../lib/context';
import { EXIT } from '../lib/errors';
import { emit, enc } from '../lib/output';

type Status = 'ok' | 'warn' | 'fail' | 'skip';
interface Check {
  name: string;
  status: Status;
  detail: string;
}

interface ManifestModule {
  name: string;
  url: string;
  integrity: string;
  version: string;
  exposes?: Record<string, string>;
}

interface PublishedInfo {
  manifestUrl: string | null;
  etag: string | null;
  error: string | null;
}

const ICON: Record<Status, string> = { ok: '✓', warn: '!', fail: '✗', skip: '-' };

/** MF 2.0 emits `mf-manifest.json` next to the remote entry; compare declared exposes. */
async function checkExposes(mod: ManifestModule): Promise<Check> {
  const name = 'exposes match the bundle';
  if (!mod.exposes || !Object.keys(mod.exposes).length) {
    return { name, status: 'skip', detail: 'no exposes declared for this version' };
  }
  try {
    const res = await fetch(new URL('mf-manifest.json', mod.url));
    if (!res.ok)
      return {
        name,
        status: 'warn',
        detail: `no mf-manifest.json next to the entry (HTTP ${res.status})`,
      };
    const built = (await res.json()) as { exposes?: Array<{ path?: string }> };
    const actual = new Set((built.exposes ?? []).map((e) => e.path));
    const missing = Object.keys(mod.exposes).filter((p) => !actual.has(p));
    return missing.length
      ? { name, status: 'fail', detail: `declared but not built: ${missing.join(', ')}` }
      : { name, status: 'ok', detail: `${actual.size} exposed modules` };
  } catch (err) {
    return {
      name,
      status: 'warn',
      detail: `could not read mf-manifest.json: ${(err as Error).message}`,
    };
  }
}

export const doctorCommand = new Command('doctor')
  .description(
    'Diagnose why a module may not load: registry, key, manifest, bundle, CORS, SRI, CDN copy'
  )
  .requiredOption('--module <module>', 'Module name as it appears in the manifest')
  .requiredOption('--env <environment>', 'Environment')
  .option('--host <hostApp>', 'Host app slug (default: the workspace default host app)')
  .action(async (opts, command: Command) => {
    const ctx = await resolveContext(command);
    const workspace = requireWorkspace(ctx);
    const checks: Check[] = [];
    const add = (check: Check) => checks.push(check);
    const pub = new ApiClient(ctx.registryUrl);

    // 1. Registry
    try {
      await pub.get('/health');
      add({ name: 'registry reachable', status: 'ok', detail: ctx.registryUrl });
    } catch (err) {
      add({ name: 'registry reachable', status: 'fail', detail: (err as Error).message });
    }

    // 2. API key (optional; enables the published-copy check)
    let published = null as PublishedInfo | null;
    if (ctx.apiKey) {
      try {
        const ws = await new ApiClient(ctx.registryUrl, ctx.apiKey).get<{
          hostApps: Array<{
            slug: string;
            isDefault: boolean;
            environments: Array<{ slug: string; published: PublishedInfo | null }>;
          }>;
        }>(`/api/workspaces/${enc(workspace)}`);
        add({ name: 'API key valid for workspace', status: 'ok', detail: workspace });
        const host =
          ws.hostApps.find((h) => (opts.host ? h.slug === opts.host : h.isDefault)) ??
          ws.hostApps[0];
        published = host?.environments.find((e) => e.slug === opts.env)?.published ?? null;
      } catch (err) {
        add({
          name: 'API key valid for workspace',
          status: 'fail',
          detail: (err as Error).message,
        });
      }
    } else {
      add({ name: 'API key valid for workspace', status: 'skip', detail: 'no API key configured' });
    }

    // 3. Manifest
    let manifest: { etag: string; modules: ManifestModule[] } | null = null;
    const manifestPath = opts.host
      ? `/api/manifest/${enc(workspace)}/${enc(opts.host)}/${enc(opts.env)}`
      : `/api/manifest/${enc(workspace)}/${enc(opts.env)}`;
    try {
      manifest = await pub.get(manifestPath);
      add({
        name: 'manifest resolves',
        status: 'ok',
        detail: `${manifest!.modules.length} modules (${manifest!.etag})`,
      });
    } catch (err) {
      add({ name: 'manifest resolves', status: 'fail', detail: (err as Error).message });
    }

    const mod = manifest?.modules.find((m) => m.name === opts.module);
    if (manifest && !mod) {
      add({
        name: `module "${opts.module}" in manifest`,
        status: 'fail',
        detail: 'not deployed to this environment',
      });
    }

    // 4. Bundle
    if (mod) {
      add({
        name: `module "${opts.module}" in manifest`,
        status: 'ok',
        detail: `${mod.version} → ${mod.url}`,
      });
      const v = await validateBundle(mod.url, mod.integrity);
      add({
        name: 'bundle reachable',
        status: v.urlReachable ? 'ok' : 'fail',
        detail: v.urlReachable ? (v.contentType ?? '') : v.errors.join('; '),
      });
      if (v.urlReachable) {
        add({
          name: 'integrity (SRI) matches',
          status: v.integrityMatch ? 'ok' : 'fail',
          detail: v.integrityMatch
            ? mod.integrity
            : (v.errors.find((e) => e.includes('Integrity')) ?? 'mismatch'),
        });
        add({
          name: 'CORS allows cross-origin loading',
          status: v.corsAllowed ? 'ok' : 'warn',
          detail: v.corsAllowed
            ? 'Access-Control-Allow-Origin present'
            : 'missing Access-Control-Allow-Origin',
        });
      }
      add(await checkExposes(mod));
    }

    // 5. Published (CDN) copy
    if (published?.manifestUrl && manifest) {
      try {
        const res = await fetch(published.manifestUrl, { cache: 'no-store' } as RequestInit);
        const copy = (await res.json()) as { etag?: string };
        add({
          name: 'published copy is current',
          status: copy.etag === manifest.etag ? 'ok' : 'warn',
          detail:
            copy.etag === manifest.etag
              ? published.manifestUrl
              : `CDN serves ${copy.etag}, registry ${manifest.etag}`,
        });
      } catch (err) {
        add({ name: 'published copy is current', status: 'warn', detail: (err as Error).message });
      }
    } else if (published?.error) {
      add({ name: 'published copy is current', status: 'fail', detail: published.error });
    } else {
      add({
        name: 'published copy is current',
        status: 'skip',
        detail: 'no published copy (or no API key)',
      });
    }

    const failed = checks.some((c) => c.status === 'fail');
    emit(ctx, { ok: !failed, checks }, () =>
      checks.map((c) => `${ICON[c.status]} ${c.name}: ${c.detail}`).join('\n')
    );
    if (failed) process.exitCode = EXIT.validation;
  });
