import { readFile } from 'fs/promises';
import { join } from 'path';
import { computeIntegrity } from '@harmoniq/core/dist/validation/bundle';

export interface HarmoniqBuildOptions {
  /** Harmoniq module slug or id. */
  module: string;
  /** Target environment, e.g. `staging`. */
  environment: string;
  /** Version being built, e.g. `1.2.3` or a commit SHA. */
  version: string;
  /** Public URL the remote entry will be served from once uploaded. */
  url: string;
  /** Build output directory (bundler-agnostic, so it must be given). */
  outDir: string;
  /** Remote entry file inside `outDir`. Default `remoteEntry.js`. */
  entry?: string;
  /** Defaults to HARMONIQ_REGISTRY_URL. */
  registryUrl?: string;
  /** Defaults to HARMONIQ_API_KEY. Needs the `deploy:write` scope. */
  apiKey?: string;
  /** Defaults to HARMONIQ_WORKSPACE. */
  workspace?: string;
  /** Defaults to GITHUB_SHA / CI_COMMIT_SHA. */
  commitSha?: string;
  /**
   * Register the deploy with the registry. Default: only in CI (`CI=true`); local builds
   * just print the integrity hash.
   */
  deploy?: boolean;
  /** Validate on the registry and print the projected change without deploying. */
  dryRun?: boolean;
  /**
   * Dependency ranges for the registry's dependency gate (M3.7). By default read from the
   * `shared` section of `mf-manifest.json`; these entries are added or take precedence.
   */
  dependencies?: Record<string, string>;
  /** Deploy despite dependency conflicts or removed exposes (audited by the registry). */
  force?: boolean;
  log?: (message: string) => void;
}

export interface HarmoniqBuildResult {
  integrity: string;
  exposes?: Record<string, string>;
  dependencies?: Record<string, string>;
  deployed: boolean;
  response?: Record<string, unknown>;
}

const nonEmpty = (record: Record<string, string>) =>
  Object.keys(record).length ? record : undefined;

/**
 * Reads `exposes` and shared dependencies (`requiredVersion`, else `^version`) from Module
 * Federation 2.0's `mf-manifest.json`, when the build emits one.
 */
async function readMfManifest(outDir: string): Promise<{
  exposes?: Record<string, string>;
  dependencies?: Record<string, string>;
}> {
  try {
    const manifest = JSON.parse(await readFile(join(outDir, 'mf-manifest.json'), 'utf8')) as {
      exposes?: Array<{ name?: string; path?: string }>;
      shared?: Array<{ name?: string; version?: string; requiredVersion?: string | false }>;
    };
    const exposes = Object.fromEntries(
      (manifest.exposes ?? []).filter((e) => e.path).map((e) => [e.path!, e.name ?? e.path!])
    );
    const dependencies = Object.fromEntries(
      (manifest.shared ?? [])
        .filter((d) => d.name && (d.requiredVersion || d.version))
        .map((d) => [d.name!, d.requiredVersion || `^${d.version}`])
    );
    return { exposes: nonEmpty(exposes), dependencies: nonEmpty(dependencies) };
  } catch {
    return {};
  }
}

/**
 * Computes the SRI hash of the built remote entry and, in CI, registers the version with
 * Harmoniq. Upload the build output to `url`'s location before the deploy takes traffic.
 */
export async function harmoniqDeploy(options: HarmoniqBuildOptions): Promise<HarmoniqBuildResult> {
  const log = options.log ?? ((m: string) => console.log(`[harmoniq] ${m}`));
  const entryPath = join(options.outDir, options.entry ?? 'remoteEntry.js');

  let content: Buffer;
  try {
    content = await readFile(entryPath);
  } catch {
    throw new Error(
      `[harmoniq] Remote entry not found at ${entryPath} (set \`outDir\` / \`entry\`)`
    );
  }
  const integrity = await computeIntegrity(
    content.buffer.slice(
      content.byteOffset,
      content.byteOffset + content.byteLength
    ) as ArrayBuffer,
    'sha384'
  );
  const mf = await readMfManifest(options.outDir);
  const exposes = mf.exposes;
  const dependencies =
    mf.dependencies || options.dependencies
      ? { ...mf.dependencies, ...options.dependencies }
      : undefined;

  const shouldDeploy = options.deploy ?? process.env.CI === 'true';
  if (!shouldDeploy && !options.dryRun) {
    log(
      `${options.module} ${options.version}: ${integrity} (not deployed; set \`deploy\` or run in CI)`
    );
    return { integrity, exposes, dependencies, deployed: false };
  }

  const registryUrl = (options.registryUrl ?? process.env.HARMONIQ_REGISTRY_URL)?.replace(
    /\/$/,
    ''
  );
  const apiKey = options.apiKey ?? process.env.HARMONIQ_API_KEY;
  const workspace = options.workspace ?? process.env.HARMONIQ_WORKSPACE;
  const missing = [
    !registryUrl && 'registryUrl / HARMONIQ_REGISTRY_URL',
    !apiKey && 'apiKey / HARMONIQ_API_KEY',
    !workspace && 'workspace / HARMONIQ_WORKSPACE',
  ].filter(Boolean);
  if (missing.length) throw new Error(`[harmoniq] Missing ${missing.join(', ')}`);

  const commitSha = options.commitSha ?? process.env.GITHUB_SHA ?? process.env.CI_COMMIT_SHA;
  const res = await fetch(
    `${registryUrl}/api/workspaces/${encodeURIComponent(workspace!)}/modules/${encodeURIComponent(options.module)}/deploy`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        environment: options.environment,
        url: options.url,
        version: options.version,
        integrity,
        ...(commitSha && { commitSha }),
        ...(exposes && { exposes }),
        ...(dependencies && { dependencies }),
        dryRun: !!options.dryRun,
        ...(options.force && { force: true }),
      }),
    }
  );
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const message =
      (body.error as { message?: string } | undefined)?.message ?? `HTTP ${res.status}`;
    throw new Error(`[harmoniq] Deploy of ${options.module} ${options.version} failed: ${message}`);
  }

  log(
    options.dryRun
      ? `dry run OK: ${options.module} ${options.version} → ${options.environment}`
      : `deployed ${options.module} ${options.version} → ${options.environment} (${integrity})`
  );
  return { integrity, exposes, dependencies, deployed: !options.dryRun, response: body };
}
