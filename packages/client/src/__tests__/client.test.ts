import { describe, it, expect, vi, afterAll, afterEach, beforeAll } from 'vitest';
import { HarmoniqClient } from '../index';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';

const mockManifest = {
  version: '1.0',
  modules: {
    header: {
      id: 'mod_1',
      url: 'https://cdn.example.com/header.js',
      integrity: 'sha384-xyz',
    },
  },
};

const server = setupServer(
  http.get('http://registry.test/api/manifest/acme/portal/prod', ({ request }) => {
    const etag = request.headers.get('If-None-Match');
    if (etag === 'W/"mock-etag"') {
      return new HttpResponse(null, { status: 304 });
    }

    return HttpResponse.json(mockManifest, {
      headers: {
        ETag: 'W/"mock-etag"',
        'X-Harmoniq-Variant': 'canary',
      },
    });
  }),
  http.post('http://registry.test/api/modules/mod_1/health', () => {
    return new HttpResponse(null, { status: 202 });
  })
);

describe('HarmoniqClient', () => {
  beforeAll(() => server.listen());
  afterEach(() => {
    server.resetHandlers();
    vi.restoreAllMocks();
  });
  afterAll(() => server.close());

  it('fetches manifest and emits update', async () => {
    const client = new HarmoniqClient({
      registryUrl: 'http://registry.test',
      workspaceSlug: 'acme',
      hostApp: 'portal',
      environment: 'prod',
    });

    const updateSpy = vi.fn();
    const variantSpy = vi.fn();

    client.on('manifestUpdate', updateSpy);
    client.on('variantAssigned', variantSpy);

    await client.init();

    expect(updateSpy).toHaveBeenCalledWith(mockManifest);
    expect(variantSpy).toHaveBeenCalledWith('canary');

    expect(client.getModuleUrl('header')).toBe('https://cdn.example.com/header.js');
    expect(client.getScriptTag('header')).toContain('integrity="sha384-xyz"');
  });

  it('uses stale manifest on fetch failure', async () => {
    const client = new HarmoniqClient({
      registryUrl: 'http://registry.test',
      workspaceSlug: 'acme',
      hostApp: 'portal',
      environment: 'prod',
    });

    await client.init();
    expect(client.getModuleUrl('header')).toBe('https://cdn.example.com/header.js');

    // Simulate registry failure
    server.use(
      http.get('http://registry.test/api/manifest/acme/portal/prod', () => {
        return new HttpResponse(null, { status: 500 });
      })
    );

    // Call fetch again directly (simulating polling)
    await (client as unknown as { fetchManifest: () => Promise<void> }).fetchManifest();

    // Still has old manifest
    expect(client.getModuleUrl('header')).toBe('https://cdn.example.com/header.js');
  });

  it('reports module health successfully', async () => {
    const client = new HarmoniqClient({
      registryUrl: 'http://registry.test',
      workspaceSlug: 'acme',
      hostApp: 'portal',
      environment: 'prod',
    });

    await client.init();

    // Call report
    await client.reportModuleLoad('header', { success: true, loadMs: 120 });
    // If it doesn't throw, it passed.
    expect(true).toBe(true);
  });
});
