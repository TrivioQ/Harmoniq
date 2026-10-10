import Fastify from 'fastify';

/**
 * A minimal S3-compatible server (path-style `/<bucket>/<key>`): PUT, HEAD, GET, DELETE.
 * Signatures aren't checked. `fail` makes every request answer 403, like revoked keys.
 */
export async function mockS3() {
  const objects = new Map<string, Buffer>();
  const state = { fail: false, requests: [] as string[] };
  const server = Fastify();
  server.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) =>
    done(null, body)
  );
  server.addHook('onRequest', async (request, reply) => {
    state.requests.push(`${request.method} ${request.url.split('?')[0]}`);
    if (state.fail) {
      return reply
        .code(403)
        .type('application/xml')
        .send('<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>');
    }
  });
  const key = (url: string) => decodeURIComponent(url.split('?')[0]);
  server.put('/*', async (request, reply) => {
    objects.set(key(request.url), (request.body as Buffer) ?? Buffer.alloc(0));
    return reply.header('ETag', '"etag"').send();
  });
  server.head('/*', async (request, reply) =>
    reply.code(objects.has(key(request.url)) ? 200 : 404).send()
  );
  server.get('/*', async (request, reply) => {
    const body = objects.get(key(request.url));
    return body ? reply.send(body) : reply.code(404).send();
  });
  server.delete('/*', async (request, reply) => {
    objects.delete(key(request.url));
    return reply.code(204).send();
  });
  await server.listen({ port: 0, host: '127.0.0.1' });
  const { port } = server.server.address() as { port: number };
  return {
    endpoint: `http://127.0.0.1:${port}`,
    objects,
    state,
    close: () => server.close(),
  };
}

export type MockS3 = Awaited<ReturnType<typeof mockS3>>;
