// Stands in for a CDN in front of two origins:
//   /                       → host/dist (the host app)
//   /<remote>/<version>/…   → <remote>/dist/<version>/… (immutable remote builds)
//   /manifests/…            → the registry's published manifests (STORAGE_ADAPTER=local
//                             serves them at /static). Like a CDN with stale-if-error, the
//                             last good copy is served while the origin is unreachable.
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { extname, join, normalize } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const root = fileURLToPath(new URL('.', import.meta.url));
const REMOTES = new Set(['greeting', 'cart']);
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
};

export function createCdn({ port = 5080, origin = 'http://localhost:4000' } = {}) {
  const cache = new Map();
  // `origin: null` simulates the registry being unreachable from the CDN.
  const state = { origin };

  async function manifest(path, res) {
    try {
      if (!state.origin) throw new Error('origin disabled');
      const upstream = await fetch(`${state.origin}/static${path}`, { cache: 'no-store' });
      if (upstream.status === 404) return send(res, 404, 'not found');
      if (!upstream.ok) throw new Error(`origin HTTP ${upstream.status}`);
      const body = Buffer.from(await upstream.arrayBuffer());
      cache.set(path, body);
      send(res, 200, body, '.json');
    } catch {
      const stale = cache.get(path);
      if (stale) send(res, 200, stale, '.json', { 'X-Cache': 'stale' });
      else send(res, 502, 'origin unreachable');
    }
  }

  const server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (path.startsWith('/manifests/')) return manifest(path, res);

    const [, first, ...rest] = path.split('/');
    const file = REMOTES.has(first)
      ? join(root, first, 'dist', ...rest)
      : join(root, 'host', 'dist', path.endsWith('/') ? `${path}index.html` : path);
    if (!file.startsWith(root)) return send(res, 403, 'forbidden');
    try {
      send(res, 200, await readFile(file), extname(file));
    } catch {
      send(res, 404, 'not found');
    }
  });

  return {
    state,
    url: `http://localhost:${port}`,
    listen: () => new Promise((resolve) => server.listen(port, resolve)),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function send(res, status, body, ext, headers = {}) {
  res.writeHead(status, {
    'Content-Type': types[ext] ?? 'text/plain',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cdn = createCdn({
    port: Number(process.env.PORT ?? 5080),
    origin: process.env.REGISTRY_URL ?? 'http://localhost:4000',
  });
  await cdn.listen();
  console.log(`example CDN on ${cdn.url}`);
}
