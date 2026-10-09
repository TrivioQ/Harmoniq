import { FastifyPluginAsync } from 'fastify';
import { extname } from 'path';
import { LocalStorageAdapter } from '../adapters/storage/LocalStorageAdapter';
import { PUBLISHED_CACHE_CONTROL } from '../services/manifestPublisher';

const TYPES: Record<string, string> = {
  '.json': 'application/json',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
};

/**
 * Serves objects from local instance storage (STORAGE_ADAPTER=local) — published
 * manifests and import maps in development. With S3 or a CDN this route is unused.
 */
const staticRoutes: FastifyPluginAsync = async (fastify) => {
  const storage = fastify.container.instanceStorage?.storage;
  if (!(storage instanceof LocalStorageAdapter)) return;

  fastify.get<{ Params: { '*': string } }>('/static/*', async (request, reply) => {
    const key = request.params['*'];
    let body: Buffer;
    try {
      body = await storage.read(key); // rejects traversal outside the storage root
    } catch {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
    }
    return reply
      .header('Cache-Control', PUBLISHED_CACHE_CONTROL)
      .type(TYPES[extname(key)] ?? 'application/octet-stream')
      .send(body);
  });
};

export default staticRoutes;
