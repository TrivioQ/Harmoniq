// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

// End-to-end: Vite + Module Federation 2.0 host and remotes delivered through Harmoniq.
//
//   1. The build plugin deploys two remotes; the host (built once) loads them via the
//      Harmoniq MF runtime plugin from the CDN copy of the manifest.
//   2. A new remote version and a rollback reach an open page without a reload.
//   3. Registry down → served from the CDN; CDN down too → persisted copy; fresh
//      browser with both down → the fallback manifest bundled with the host.
//   4. `?harmoniq-override=` points one remote at a local build.
//
// Needs a registry with HARMONIQ_DEV_LOGIN=1 and STORAGE_ADAPTER=local (the dev defaults),
// the workspace packages built (pnpm build) and Chrome (CHROME_PATH, or the installed
// stable channel).
//
//   pnpm --filter @harmoniq-example/vite-mf e2e
import { execFileSync } from 'child_process';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer-core';
import { createCdn } from './serve.mjs';

const dir = fileURLToPath(new URL('.', import.meta.url));
const REGISTRY = (process.env.REGISTRY_URL ?? 'http://localhost:4000').replace(/\/$/, '');
const CDN_PORT = Number(process.env.CDN_PORT ?? 5080);
const UNREACHABLE = 'http://127.0.0.1:65530'; // nothing listens here: connection refused
const ENV = 'production';
const CLI = fileURLToPath(new URL('../../packages/cli/dist/index.mjs', import.meta.url));

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function api(method, path, token, body) {
  const res = await fetch(`${REGISTRY}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body && JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${JSON.stringify(json)}`);
  return json;
}

async function waitFor(what, fn, timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn().catch(() => undefined);
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

// ---------------------------------------------------------------------------
// Workspace, modules and an API key
// ---------------------------------------------------------------------------

const ws = `vite-mf-${Date.now()}`;
const { accessToken } = await fetch(`${REGISTRY}/api/auth/dev/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: `${ws}@example.com` }),
}).then((r) => {
  if (!r.ok) throw new Error(`Dev login failed (HTTP ${r.status}); is HARMONIQ_DEV_LOGIN=1 set?`);
  return r.json();
});
await api('POST', '/api/workspaces', accessToken, { name: 'Vite MF example', slug: ws });
for (const slug of ['greeting', 'cart']) {
  await api('POST', `/api/workspaces/${ws}/modules`, accessToken, {
    hostApp: 'default',
    name: slug,
    slug,
  });
}
const { key } = await api('POST', `/api/workspaces/${ws}/api-keys`, accessToken, { name: 'e2e' });

const cdn = createCdn({ port: CDN_PORT, origin: REGISTRY });
await cdn.listen();

const harmoniqEnv = {
  ...process.env,
  CDN_URL: cdn.url,
  HARMONIQ_REGISTRY_URL: REGISTRY,
  HARMONIQ_API_KEY: key,
  HARMONIQ_WORKSPACE: ws,
  HARMONIQ_ENV: ENV,
};

/** Builds a remote with Vite; the Harmoniq build plugin deploys it when `deploy`. */
function build(remote, version, deploy = true) {
  execFileSync('pnpm', ['exec', 'vite', 'build', '--logLevel', 'warn'], {
    cwd: `${dir}/${remote}`,
    env: { ...harmoniqEnv, VERSION: version, HARMONIQ_DEPLOY: deploy ? '1' : '0' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
}

const cli = (...args) =>
  execFileSync(
    'node',
    [CLI, '--registry-url', REGISTRY, '--workspace', ws, '--api-key', key, ...args],
    { encoding: 'utf8' }
  );

/** Resolves once the CDN copy matches what the registry serves. */
async function published() {
  const path = `/api/manifest/${ws}/default/${ENV}`;
  const live = await fetch(`${REGISTRY}${path}`).then((r) => r.json());
  await waitFor('the published manifest', async () => {
    const res = await fetch(`${REGISTRY}/static/manifests/${ws}/default/${ENV}.json`);
    return res.ok && (await res.json()).etag === live.etag;
  });
  return live;
}

let browser;
try {
  // -------------------------------------------------------------------------
  // Deploy 1.0.0 of both remotes, pull the fallback manifest, build the host once
  // -------------------------------------------------------------------------
  build('greeting', '1.0.0');
  build('cart', '1.0.0');
  const v1 = await published();
  check(
    'build plugin deployed both remotes',
    v1.modules
      .map((m) => `${m.name}@${m.version}`)
      .sort()
      .join(',') === 'cart@1.0.0,greeting@1.0.0'
  );
  const exposes = v1.modules.find((m) => m.name === 'greeting')?.exposes;
  check('exposes read from mf-manifest.json', !!exposes?.['./widget'], JSON.stringify(exposes));

  cli('manifest', 'pull', '--env', ENV, '--out', `${dir}/host/public/fallback-manifest.json`);
  execFileSync('pnpm', ['exec', 'vite', 'build', '--logLevel', 'warn'], {
    cwd: `${dir}/host`,
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH }
      : { channel: 'chrome' }),
    headless: true,
    args: ['--no-sandbox'],
  });

  const hostUrl = (q = {}) =>
    `${cdn.url}/?${new URLSearchParams({ registry: REGISTRY, workspace: ws, env: ENV, cdn: cdn.url, ...q })}`;

  async function open(page, url) {
    await page.goto(url);
    await page.waitForFunction(() => document.body.dataset.state !== 'loading', {
      timeout: 15_000,
    });
    return read(page);
  }
  const read = (page) =>
    page.evaluate(() => ({
      state: document.body.dataset.state,
      source: document.body.dataset.source,
      greeting: document.getElementById('greeting').dataset.version,
      cart: document.getElementById('cart').dataset.version,
      text: document.getElementById('status').textContent,
    }));
  const versions = (s) => `greeting ${s.greeting}, cart ${s.cart}, source ${s.source}`;

  // -------------------------------------------------------------------------
  // Normal load, live upgrade and rollback
  // -------------------------------------------------------------------------
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  let s = await open(page, hostUrl({ poll: '500' }));
  check(
    'host loads remotes from the CDN manifest',
    s.state === 'ready' && s.greeting === '1.0.0' && s.cart === '1.0.0' && s.source === 'network',
    versions(s)
  );
  const cartClick = await page.$('#cart button');
  await cartClick.click();
  check(
    'remote is interactive',
    (await page.$eval('#cart button', (b) => b.textContent)) === 'Cart 1.0.0: 1 items'
  );

  const health = await waitFor('health reports', async () => {
    const res = await api(
      'GET',
      `/api/workspaces/${ws}/modules/greeting/health?environment=${ENV}`,
      accessToken
    );
    return res.sampleCount >= 1 && res;
  });
  check(
    'load reports from the MF plugin reach the registry',
    health.variants.stable.sampleCount >= 1 && health.p50LoadMs !== null && health.errorCount === 0,
    `${health.sampleCount} samples, p50 ${health.p50LoadMs} ms`
  );

  build('greeting', '2.0.0');
  await published();
  await page.waitForFunction(
    () => document.getElementById('greeting').dataset.version === '2.0.0',
    { timeout: 15_000 }
  );
  s = await read(page);
  check('deploying 2.0.0 swaps the remote in the open page', s.greeting === '2.0.0', versions(s));

  cli('rollback', '--module', 'greeting', '--env', ENV);
  await published();
  await page.waitForFunction(
    () => document.getElementById('greeting').dataset.version === '1.0.0',
    { timeout: 15_000 }
  );
  check('rollback swaps it back without a reload', true);

  build('greeting', '2.0.0'); // a fresh deploy of 2.0.0 for the outage checks
  await published();
  s = await open(page, hostUrl());
  check('reload after redeploy shows 2.0.0', s.greeting === '2.0.0', versions(s));

  // -------------------------------------------------------------------------
  // Outages
  // -------------------------------------------------------------------------
  cdn.state.origin = null; // the CDN can no longer reach the registry either
  s = await open(page, hostUrl({ registry: UNREACHABLE }));
  check(
    'registry down: boots from the CDN copy',
    s.state === 'ready' && s.greeting === '2.0.0' && s.source === 'network',
    versions(s)
  );

  s = await open(page, hostUrl({ registry: UNREACHABLE, cdn: UNREACHABLE }));
  check(
    'registry and CDN down: boots from the persisted copy',
    s.state === 'ready' && s.greeting === '2.0.0' && s.source === 'persisted',
    versions(s)
  );

  const fresh = await browser.createBrowserContext();
  const freshPage = await fresh.newPage();
  s = await open(freshPage, hostUrl({ registry: UNREACHABLE, cdn: UNREACHABLE }));
  check(
    'first visit with both down: boots from the bundled fallback manifest',
    s.state === 'ready' && s.greeting === '1.0.0' && s.cart === '1.0.0' && s.source === 'fallback',
    versions(s)
  );
  cdn.state.origin = REGISTRY;

  // -------------------------------------------------------------------------
  // Local override
  // -------------------------------------------------------------------------
  build('greeting', 'local-dev', false);
  s = await open(
    page,
    hostUrl({ 'harmoniq-override': `greeting@${cdn.url}/greeting/local-dev/remoteEntry.js` })
  );
  check(
    '?harmoniq-override= loads a local build of one remote',
    s.greeting === 'local-dev' && s.cart === '1.0.0',
    versions(s)
  );

  // Kill switch: the MF plugin refuses the remote; the rest of the page keeps working.
  await api('PUT', `/api/workspaces/${ws}/modules/greeting/kill-switch`, accessToken, {
    environment: ENV,
    disabled: true,
    reason: 'e2e kill switch',
  });
  await published();
  s = await open(page, hostUrl());
  const greetingText = await page.$eval('#greeting', (el) => el.textContent);
  check(
    'kill switch: disabled remote is not loaded, others still are',
    /disabled: e2e kill switch/.test(greetingText) && s.cart === '1.0.0',
    greetingText
  );
  await api('PUT', `/api/workspaces/${ws}/modules/greeting/kill-switch`, accessToken, {
    environment: ENV,
    disabled: false,
  });

  check('no uncaught errors in the page', pageErrors.length === 0, pageErrors.join('; '));
} catch (err) {
  check('e2e run', false, err.message);
} finally {
  await browser?.close();
  await cdn.close();
  writeFileSync(`${dir}/.last-workspace`, `${ws}\n`);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
