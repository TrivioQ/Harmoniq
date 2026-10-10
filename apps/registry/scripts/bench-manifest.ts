// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

/**
 * Manifest endpoint benchmark (target: p99 < 50 ms on a cache hit). Builds the registry
 * in-process against the configured database, deploys three modules through the API,
 * warms the cache, then runs autocannon on full fetches and ETag revalidations (304).
 * Exits 1 when a p99 misses the target.
 *
 *   pnpm --filter @harmoniq/registry bench [-- --duration 10 --connections 50]
 */
import { parseArgs } from 'node:util';
import { AddressInfo } from 'node:net';
import autocannon from 'autocannon';
import { buildApp } from '../src/app';
import { Fixtures } from '../src/__tests__/helpers/fixtures';

const { values } = parseArgs({
  // `pnpm run bench -- …` passes the separator through.
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: {
    duration: { type: 'string', default: '10' },
    connections: { type: 'string', default: '50' },
    target: { type: 'string', default: '50' },
  },
});
const duration = Number(values.duration);
const connections = Number(values.connections);
const targetMs = Number(values.target);

// The bench client is one IP; don't let the per-IP manifest limit answer with 429s.
process.env.HARMONIQ_MANIFEST_RATE_LIMIT = '100000000';

async function main() {
  const app = await buildApp();
  await app.ready();
  app.log.level = 'warn';
  const fx = new Fixtures(app);
  try {
    const { workspace } = await fx.workspace();
    const { raw } = await fx.apiKey(workspace.id);
    for (const name of ['checkout', 'cart', 'profile']) {
      if (name !== 'checkout') {
        await fx.module(workspace.id, (await hostAppId(app, workspace.id))!, name);
      }
      const res = await app.inject({
        method: 'POST',
        url: `/api/workspaces/${workspace.slug}/modules/${name}/deploy`,
        headers: { authorization: `Bearer ${raw}` },
        payload: {
          environment: 'production',
          version: '1.0.0',
          url: `https://cdn.example.com/${name}/1.0.0/remoteEntry.js`,
          integrity: `sha384-${name}100`,
        },
      });
      if (res.statusCode !== 201) throw new Error(`deploy ${name}: ${res.statusCode} ${res.body}`);
    }

    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/api/manifest/${workspace.slug}/portal/production`;
    const warm = await fetch(url);
    const etag = warm.headers.get('etag');
    if (warm.status !== 200 || !etag) throw new Error(`warm-up: ${warm.status}`);

    let failed = false;
    for (const [label, headers, expected] of [
      ['200 (cache hit)', {}, 200],
      ['304 (If-None-Match)', { 'if-none-match': etag }, 304],
    ] as const) {
      const result = await autocannon({ url, connections, duration, headers });
      const unexpected = result.non2xx - (expected === 304 ? result['3xx'] : 0);
      const ok = result.latency.p99 < targetMs && unexpected === 0 && result.errors === 0;
      failed ||= !ok;
      console.log(
        `${ok ? '✓' : '✗'} ${label}: p50 ${result.latency.p50} ms, p90 ${result.latency.p90} ms, ` +
          `p99 ${result.latency.p99} ms, ${Math.round(result.requests.average)} req/s, ` +
          `${unexpected} unexpected responses, ${result.errors} errors`
      );
    }
    console.log(
      `${connections} connections, ${duration}s each; target p99 < ${targetMs} ms (cache: ${app.config.cacheAdapter})`
    );
    process.exitCode = failed ? 1 : 0;
  } finally {
    await fx.cleanup();
    await app.close();
  }
}

async function hostAppId(app: Awaited<ReturnType<typeof buildApp>>, workspaceId: string) {
  return (await app.container.systemDb.hostApp.findFirst({ where: { workspaceId } }))?.id;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
