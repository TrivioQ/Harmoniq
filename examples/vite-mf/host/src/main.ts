// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { createInstance } from '@module-federation/runtime';
import { EVENTS, HarmoniqClient, Manifest } from '@harmoniq/client';
import { harmoniqPlugin } from '@harmoniq/mf-plugin';

// Settings come from the query string so one build can be pointed anywhere
// (the e2e test uses this to make the registry or the CDN unreachable).
const params = new URLSearchParams(location.search);
const registryUrl = params.get('registry') ?? 'http://localhost:4000';
const workspaceSlug = params.get('workspace') ?? 'demo';
const environment = params.get('env') ?? 'production';
const cdnBaseUrl = params.get('cdn') ?? undefined;

const REMOTES = ['greeting', 'cart'] as const;
type Widget = { mount(el: HTMLElement): void };

/** Output of `harmoniq manifest pull`, bundled with the host as the last resort. */
async function loadFallback(): Promise<Manifest | undefined> {
  try {
    const res = await fetch(new URL('fallback-manifest.json', location.href));
    return res.ok ? ((await res.json()) as Manifest) : undefined;
  } catch {
    return undefined;
  }
}

const client = new HarmoniqClient({
  registryUrl,
  workspaceSlug,
  hostApp: 'default',
  environment,
  cdnBaseUrl,
  fallbackManifest: await loadFallback(),
  allowOverrides: true, // a demo; gate this on non-production builds in a real host
  pollIntervalMs: Number(params.get('poll') ?? 2000),
  timeoutMs: 2000,
  // Load outcomes from the MF plugin feed the module health in the dashboard.
  reportHealth: { flushIntervalMs: 1000 },
});

const mf = createInstance({
  name: 'host',
  // Entries are resolved from the Harmoniq manifest at load time; only the remote type
  // (@module-federation/vite builds ES module entries) is configured here.
  remotes: REMOTES.map((name) => ({ name, entry: `harmoniq:${name}`, type: 'module' })),
  plugins: [harmoniqPlugin(client)],
});

async function mountAll() {
  for (const name of REMOTES) {
    const el = document.getElementById(name)!;
    try {
      const widget = await mf.loadRemote<Widget>(`${name}/widget`);
      widget!.mount(el);
    } catch (err) {
      el.dataset.version = '';
      el.textContent = `${name} failed to load: ${(err as Error).message}`;
    }
  }
  renderStatus();
}

function renderStatus() {
  const manifest = client.getManifest();
  const status = {
    source: client.getSource(),
    environment: client.getEnvironment(),
    etag: manifest?.etag,
    modules: Object.fromEntries(manifest?.modules.map((m) => [m.name, m.version]) ?? []),
    overrides: client.getOverrides(),
  };
  document.getElementById('status')!.textContent = JSON.stringify(status, null, 2);
  document.body.dataset.source = status.source ?? '';
}

try {
  await client.init();
  await mountAll();
  document.body.dataset.state = 'ready';
  // A deploy or rollback swaps the remotes in place, without a reload. The Harmoniq
  // plugin re-registers remotes in its own listener, so re-mount on the next tick.
  client.on(EVENTS.manifestUpdate, () => setTimeout(mountAll, 0));
} catch (err) {
  document.body.dataset.state = 'error';
  document.getElementById('status')!.textContent = String(err);
}
