// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import type { ModuleFederation } from '@module-federation/runtime';
import type { ModuleFederationRuntimePlugin } from '@module-federation/runtime/types';
import { EVENTS, HarmoniqClient, Manifest } from '@harmoniq/client';

export interface HarmoniqPluginOptions {
  /**
   * Module Federation remote name → Harmoniq module name, when they differ.
   * By default a remote named `checkout` uses the Harmoniq module `checkout`.
   */
  remoteNames?: Record<string, string>;
  /**
   * Refuse to load remotes that are not in the Harmoniq manifest (default: fall back to
   * the remote's static configuration).
   */
  strict?: boolean;
  /**
   * Report each remote's first load (time from request to module, or the error) through
   * `client.reportModuleLoad`, for health and canary comparisons (HLT-01). Only sent when
   * the client has `reportHealth` on. Default true.
   */
  reportLoads?: boolean;
}

type Remote = {
  name: string;
  alias?: string;
  entry?: string;
  version?: string;
  type?: string;
};

/**
 * Module Federation 2.0 runtime plugin: resolves remote entries from the Harmoniq
 * manifest at request time, verifies them with SRI, and hot-swaps remotes when a new
 * version is deployed or rolled back — no rebuild of the host.
 *
 *   import { init } from '@module-federation/enhanced/runtime';
 *   init({ name: 'host', remotes: [], plugins: [harmoniqPlugin(client)] });
 */
export function harmoniqPlugin(
  client: HarmoniqClient,
  options: HarmoniqPluginOptions = {}
): ModuleFederationRuntimePlugin {
  const toModule = (remote: string) => options.remoteNames?.[remote] ?? remote;
  const toRemote = (module: string) =>
    Object.entries(options.remoteNames ?? {}).find(([, m]) => m === module)?.[0] ?? module;

  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const nameOf = (id: string) =>
    id
      .split('/')
      .slice(0, id.startsWith('@') ? 2 : 1)
      .join('/');
  // Request id → start time, and what was already reported: later loads of the same
  // remote entry and expose come from the runtime's cache and would skew load times.
  const started = new Map<string, number>();
  const reported = new Set<string>();

  let instance: ModuleFederation | undefined;
  let unsubscribe: (() => void) | undefined;
  // remoteEntry URL → integrity, for SRI on the scripts the runtime injects.
  const integrityByUrl = new Map<string, string>();

  const index = (manifest: Manifest | null) => {
    integrityByUrl.clear();
    for (const m of manifest?.modules ?? []) integrityByUrl.set(m.url, m.integrity);
  };

  /** Re-register remotes whose URL changed, so the next load fetches the new version. */
  const onManifest = (manifest: Manifest) => {
    const before = new Map(integrityByUrl);
    index(manifest);
    if (!instance) return;
    const configured = instance.options.remotes as Remote[];
    // Keep the remote's other settings (e.g. `type: 'module'` for ES module entries).
    const changed = manifest.modules
      .filter((m) => !before.has(m.url))
      .map((m) => {
        const name = toRemote(m.name);
        const previous: Remote = { ...configured.find((r) => r.name === name), name };
        delete previous.version; // version-based resolution would bypass the entry
        return { ...previous, entry: m.url };
      });
    if (changed.length) instance.registerRemotes(changed, { force: true });
  };

  /** Binds to the MF instance once; beforeInit may run before plugins are registered. */
  const attach = (origin: ModuleFederation) => {
    if (instance === origin) return;
    instance = origin;
    unsubscribe?.();
    unsubscribe = client.on(EVENTS.manifestUpdate, onManifest);
    index(client.getManifest());
  };

  return {
    name: 'harmoniq-plugin',

    beforeInit(args) {
      attach(args.origin);
      return args;
    },

    async beforeRequest(args) {
      if (!started.has(args.id)) started.set(args.id, now());
      attach(args.origin);
      await client.init();
      const remotes = args.options.remotes as Remote[];
      // Request ids look like `<remote name or alias>/<expose>`; names may be scoped.
      const remote = remotes.find(
        (r) =>
          args.id === r.name ||
          args.id.startsWith(`${r.name}/`) ||
          (!!r.alias && (args.id === r.alias || args.id.startsWith(`${r.alias}/`)))
      );
      const name = remote?.name ?? nameOf(args.id);
      // Kill switch: refuse to load, so the host's error handling renders a fallback.
      const killed = client.isModuleDisabled(toModule(name));
      if (killed) {
        throw new Error(
          `[harmoniq] Remote "${name}" is disabled${killed.reason ? `: ${killed.reason}` : ''}`
        );
      }
      const entry = client.getModuleEntry(toModule(name));

      if (!entry) {
        if (options.strict) {
          throw new Error(`[harmoniq] Remote "${name}" is not in the Harmoniq manifest`);
        }
        return args;
      }
      integrityByUrl.set(entry.url, entry.integrity);
      if (remote) {
        remote.entry = entry.url;
        delete remote.version; // version-based (snapshot) resolution would bypass the entry
      } else {
        remotes.push({ name, entry: entry.url });
      }
      return args;
    },

    afterLoadRemote(args) {
      const start = started.get(args.id);
      started.delete(args.id);
      if (options.reportLoads === false) return;
      const remoteName = args.remote?.name ?? nameOf(args.id);
      const key = `${remoteName}|${args.expose ?? ''}|${args.remote?.entry ?? ''}`;
      if (!args.error && reported.has(key)) return;
      reported.add(key);
      client.reportModuleLoad(toModule(remoteName), {
        success: !args.error, // a recovered load still failed to load the real module
        ...(start !== undefined && { loadMs: now() - start }),
        ...(args.error !== undefined && { error: args.error }),
      });
    },

    // SRI-04: remote entries are loaded with integrity checking when Harmoniq knows the hash.
    createScript({ url, attrs }) {
      const integrity = integrityByUrl.get(url);
      if (!integrity || typeof document === 'undefined') return;
      const script = document.createElement('script');
      for (const [key, value] of Object.entries(attrs ?? {})) {
        if (key === 'async' || key === 'defer')
          (script as unknown as Record<string, unknown>)[key] = value;
        else script.setAttribute(key, String(value));
      }
      if (attrs?.type === 'module') script.type = 'module';
      script.integrity = integrity;
      script.crossOrigin = 'anonymous';
      return script;
    },
  };
}

/** Remotes for `init({ remotes })` from an already-loaded client. */
export function harmoniqRemotes(
  client: HarmoniqClient,
  options: Pick<HarmoniqPluginOptions, 'remoteNames'> = {}
): Array<{ name: string; entry: string }> {
  const toRemote = (module: string) =>
    Object.entries(options.remoteNames ?? {}).find(([, m]) => m === module)?.[0] ?? module;
  return (client.getManifest()?.modules ?? []).map((m) => ({
    name: toRemote(m.name),
    entry: m.url,
  }));
}
