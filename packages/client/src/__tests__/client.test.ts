import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EVENTS, HarmoniqClient, Manifest } from '../index';

const manifest = (version: string, extra: Partial<Manifest> = {}): Manifest => ({
  schemaVersion: 2,
  workspaceSlug: 'acme',
  hostApp: { slug: 'portal', name: 'Portal' },
  environment: 'production',
  variant: 'stable',
  cohortId: 'stable',
  generatedAt: '2026-10-09T00:00:00.000Z',
  etag: `sha256-${version}`,
  modules: [
    {
      name: 'checkout',
      url: `https://cdn.example.com/checkout/${version}.js`,
      integrity: `sha384-${version}`,
      version,
    },
  ],
  ...extra,
});

/** A scripted registry: each call returns the next response; records request headers. */
function fakeRegistry(responses: Array<Manifest | number | Error>) {
  const calls: Array<Record<string, string>> = [];
  const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
    calls.push((init?.headers ?? {}) as Record<string, string>);
    const next = responses.length > 1 ? responses.shift()! : responses[0];
    if (next instanceof Error) throw next;
    if (typeof next === 'number') return new Response(null, { status: next });
    return new Response(JSON.stringify(next), { status: 200, headers: { ETag: `"${next.etag}"` } });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

const options = (fetchImpl: typeof fetch, pollIntervalMs?: number) => ({
  registryUrl: 'http://registry.test',
  workspaceSlug: 'acme',
  hostApp: 'portal',
  environment: 'production',
  fetch: fetchImpl,
  pollIntervalMs,
  persist: false as const,
});

describe('HarmoniqClient', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('indexes the schemaVersion 2 manifest by module name', async () => {
    const { fetchImpl } = fakeRegistry([manifest('1.0.0')]);
    const client = new HarmoniqClient(options(fetchImpl));
    await client.init();
    expect(client.getModuleEntry('checkout')).toEqual({
      url: 'https://cdn.example.com/checkout/1.0.0.js',
      integrity: 'sha384-1.0.0',
      version: '1.0.0',
    });
    expect(client.getModuleEntry('missing')).toBeNull();
  });

  it('shares one load and one poll loop across repeated init() calls', async () => {
    const { fetchImpl } = fakeRegistry([manifest('1.0.0'), 304]);
    const client = new HarmoniqClient(options(fetchImpl, 1000));
    await Promise.all([client.init(), client.init(), client.init()]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchImpl).toHaveBeenCalledTimes(4); // 1 initial + 3 polls, not 3 loops

    client.destroy();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('revalidates with the ETag and only emits when the manifest changes', async () => {
    const { fetchImpl, calls } = fakeRegistry([manifest('1.0.0'), 304, manifest('1.1.0')]);
    const client = new HarmoniqClient(options(fetchImpl, 1000));
    const updates: string[] = [];
    client.on(EVENTS.manifestUpdate, (m) => updates.push(m.modules[0].version));

    await client.init();
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls[1]['If-None-Match']).toBe('"sha256-1.0.0"');
    expect(updates).toEqual(['1.0.0', '1.1.0']);
    client.destroy();
  });

  it('keeps the last manifest, reports errors and backs off when the registry fails', async () => {
    const { fetchImpl } = fakeRegistry([manifest('1.0.0'), 500, 500, 500]);
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // no jitter
    const client = new HarmoniqClient(options(fetchImpl, 1000));
    const errors: Error[] = [];
    client.on(EVENTS.error, (e) => errors.push(e));

    await client.init();
    await vi.advanceTimersByTimeAsync(1000); // poll 1 fails → next in 2s
    expect(errors).toHaveLength(1);
    expect(client.getModuleUrl('checkout')).toContain('1.0.0'); // stale beats broken

    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // then 4s
    client.destroy();
  });

  it('rejects init when the first load fails, and allows retrying', async () => {
    const { fetchImpl } = fakeRegistry([new Error('offline'), manifest('1.0.0')]);
    const client = new HarmoniqClient(options(fetchImpl));
    await expect(client.init()).rejects.toThrow('offline');
    expect(client.getError()?.message).toContain('offline');
    await client.init();
    expect(client.getError()).toBeNull();
    expect(client.getManifest()).not.toBeNull();
  });

  it('emits variantAssigned on the first assignment and on changes only', async () => {
    const canary = { variant: 'canary' as const, cohortId: 'c1' };
    const { fetchImpl } = fakeRegistry([
      manifest('1.0.0', canary),
      manifest('1.0.1', canary),
      manifest('1.0.2'),
    ]);
    const client = new HarmoniqClient(options(fetchImpl, 1000));
    const assignments: string[] = [];
    client.on(EVENTS.variantAssigned, (a) => assignments.push(`${a.variant}:${a.cohortId}`));

    await client.init();
    await vi.advanceTimersByTimeAsync(2000);
    expect(assignments).toEqual(['canary:c1', 'stable:stable']);
    client.destroy();
  });

  it('never sends credentials', async () => {
    const { fetchImpl, calls } = fakeRegistry([manifest('1.0.0')]);
    await new HarmoniqClient(options(fetchImpl)).init();
    expect(Object.keys(calls[0]).map((h) => h.toLowerCase())).not.toContain('authorization');
  });

  it('rejects unsupported manifest formats', async () => {
    const legacy = { modules: { checkout: { url: 'x' } } } as unknown as Manifest;
    const { fetchImpl } = fakeRegistry([legacy]);
    await expect(new HarmoniqClient(options(fetchImpl)).init()).rejects.toThrow('unsupported');
  });

  it('escapes attributes in script tags', async () => {
    const evil = manifest('1.0.0');
    evil.modules[0].url = 'https://cdn.example.com/x.js"><script>alert(1)</script>';
    const { fetchImpl } = fakeRegistry([evil]);
    const client = new HarmoniqClient(options(fetchImpl));
    await client.init();
    const tag = client.getScriptTag('checkout')!;
    expect(tag).not.toContain('<script>alert');
    expect(tag).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('unsubscribes with the function returned by on()', async () => {
    const { fetchImpl } = fakeRegistry([manifest('1.0.0')]);
    const client = new HarmoniqClient(options(fetchImpl));
    const listener = vi.fn();
    const off = client.on(EVENTS.manifestUpdate, listener);
    off();
    await client.init();
    expect(listener).not.toHaveBeenCalled();
  });

  describe('resilience (M2.2)', () => {
    const CDN = 'https://cdn.test/manifests/acme/portal/production.json';
    const REGISTRY = 'http://registry.test/api/manifest/acme/portal/production';

    /** Routes by URL: each entry is the response for that source (Error = network failure). */
    function routed(routes: Record<string, Manifest | number | Error>) {
      const calls: string[] = [];
      const fetchImpl = vi.fn(async (url: string) => {
        calls.push(url);
        const r = routes[url];
        if (r instanceof Error) throw r;
        if (typeof r === 'number') return new Response(null, { status: r });
        return new Response(JSON.stringify(r), { status: 200 });
      }) as unknown as typeof fetch;
      return { fetchImpl, calls, routes };
    }

    const memoryStore = () => {
      const data = new Map<string, string>();
      return {
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => void data.set(k, v),
        data,
      };
    };

    it('reads the CDN copy first', async () => {
      const { fetchImpl, calls } = routed({
        [CDN]: manifest('1.0.0'),
        [REGISTRY]: manifest('9.9.9'),
      });
      const client = new HarmoniqClient({ ...options(fetchImpl), cdnBaseUrl: 'https://cdn.test/' });
      await client.init();
      expect(calls).toEqual([CDN]);
      expect(client.getModuleEntry('checkout')?.version).toBe('1.0.0');
      expect(client.getSource()).toBe('network');
    });

    it('falls back to the registry when the CDN fails', async () => {
      const { fetchImpl, calls } = routed({ [CDN]: 503, [REGISTRY]: manifest('1.0.0') });
      const client = new HarmoniqClient({ ...options(fetchImpl), cdnBaseUrl: 'https://cdn.test' });
      await client.init();
      expect(calls).toEqual([CDN, REGISTRY]);
      expect(client.getModuleEntry('checkout')?.version).toBe('1.0.0');
    });

    it('boots from the persisted manifest when every source is down, then recovers', async () => {
      const store = memoryStore();
      // A previous page load saved the manifest.
      const first = routed({ [REGISTRY]: manifest('1.0.0') });
      await new HarmoniqClient({ ...options(first.fetchImpl), persist: store }).init();

      const offline = routed({ [REGISTRY]: new Error('offline') });
      const client = new HarmoniqClient({ ...options(offline.fetchImpl, 1000), persist: store });
      const stale = vi.fn();
      client.on(EVENTS.manifestStale, stale);
      await client.init();
      expect(client.getSource()).toBe('persisted');
      expect(client.getModuleEntry('checkout')?.version).toBe('1.0.0');
      expect(stale).toHaveBeenCalledWith({ source: 'persisted', generatedAt: expect.any(String) });

      offline.routes[REGISTRY] = manifest('1.1.0'); // the registry comes back
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      await vi.advanceTimersByTimeAsync(2000);
      expect(client.getSource()).toBe('network');
      expect(client.getModuleEntry('checkout')?.version).toBe('1.1.0');
      client.destroy();
    });

    it('uses the bundled fallback when nothing is reachable or persisted', async () => {
      const { fetchImpl } = routed({ [REGISTRY]: new Error('offline') });
      const client = new HarmoniqClient({
        ...options(fetchImpl),
        fallbackManifest: manifest('0.9.0'),
      });
      await client.init();
      expect(client.getSource()).toBe('fallback');
      expect(client.getModuleEntry('checkout')?.version).toBe('0.9.0');
    });

    it('ignores a persisted manifest for another environment', async () => {
      const store = memoryStore();
      store.setItem(
        'harmoniq:manifest:acme:portal:production',
        JSON.stringify(manifest('1.0.0', { environment: 'staging' }))
      );
      const { fetchImpl } = routed({ [REGISTRY]: new Error('offline') });
      await expect(
        new HarmoniqClient({ ...options(fetchImpl), persist: store }).init()
      ).rejects.toThrow();
    });
  });

  describe('canary assignment (M3.1)', () => {
    const CDN = 'https://cdn.test/manifests/acme/portal/production.json';
    const REGISTRY = 'http://registry.test/api/manifest/acme/portal/production';

    /** Records [url, headers] per request; the registry answers with a canary variant. */
    function recording() {
      const calls: Array<[string, Record<string, string>]> = [];
      const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
        calls.push([url, (init?.headers ?? {}) as Record<string, string>]);
        const body = url.startsWith('http://registry.test')
          ? manifest('2.0.0', { variant: 'canary', cohortId: 'c0ffee' })
          : manifest('1.0.0');
        return new Response(JSON.stringify(body), { status: 200 });
      }) as unknown as typeof fetch;
      return { fetchImpl, calls };
    }

    it('asks the registry first and sends the user id only there', async () => {
      const { fetchImpl, calls } = recording();
      const client = new HarmoniqClient({
        ...options(fetchImpl),
        cdnBaseUrl: 'https://cdn.test',
        userId: 'user-42',
      });
      const assigned = vi.fn();
      client.on(EVENTS.variantAssigned, assigned);
      await client.init();
      expect(calls).toEqual([[REGISTRY, { 'X-Harmoniq-User-Id': 'user-42' }]]);
      expect(client.getVariant()).toBe('canary');
      expect(client.getCohortId()).toBe('c0ffee');
      expect(assigned).toHaveBeenCalledWith({ variant: 'canary', cohortId: 'c0ffee' });
    });

    it('falls back to the CDN (stable) without the header when the registry is down', async () => {
      const calls: Array<[string, Record<string, string>]> = [];
      const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
        calls.push([url, (init?.headers ?? {}) as Record<string, string>]);
        if (url === REGISTRY) throw new TypeError('Failed to fetch');
        return new Response(JSON.stringify(manifest('1.0.0')), { status: 200 });
      }) as unknown as typeof fetch;
      const client = new HarmoniqClient({
        ...options(fetchImpl),
        cdnBaseUrl: 'https://cdn.test',
        userId: 'user-42',
      });
      await client.init();
      expect(calls[1]).toEqual([CDN, {}]);
      expect(client.getVariant()).toBe('stable');
    });

    it('keeps an anonymous id across visits when anonymousCanary is on', async () => {
      const data = new Map<string, string>();
      const store = {
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => void data.set(k, v),
      };
      const ids: string[] = [];
      for (let visit = 0; visit < 2; visit++) {
        const { fetchImpl, calls } = recording();
        const client = new HarmoniqClient({
          ...options(fetchImpl),
          persist: store,
          anonymousCanary: true,
        });
        await client.init();
        ids.push(calls[0][1]['X-Harmoniq-User-Id']);
      }
      expect(ids[0]).toMatch(/.{8,}/);
      expect(ids[1]).toBe(ids[0]);
    });

    it('re-fetches with the new user after setUserId()', async () => {
      const { fetchImpl, calls } = recording();
      const client = new HarmoniqClient({ ...options(fetchImpl), cdnBaseUrl: 'https://cdn.test' });
      await client.init();
      expect(calls.map(([url]) => url)).toEqual([CDN]);

      await client.setUserId('user-7');
      expect(calls[1]).toEqual([REGISTRY, { 'X-Harmoniq-User-Id': 'user-7' }]);
      expect(client.getVariant()).toBe('canary');
      await client.setUserId('user-7'); // unchanged: no request
      expect(calls).toHaveLength(2);
    });
  });

  describe('health reporting (M3.2)', () => {
    const HEALTH = 'http://registry.test/api/health/acme/portal/production';

    function recorder() {
      const reports: Array<{ events: Array<Record<string, unknown>>; client: string }> = [];
      const contentTypes: string[] = [];
      const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
        if (url === HEALTH) {
          reports.push(JSON.parse(String(init?.body)));
          contentTypes.push((init?.headers as Record<string, string>)['Content-Type']);
          return new Response(null, { status: 202 });
        }
        return new Response(JSON.stringify(manifest('1.0.0')), { status: 200 });
      }) as unknown as typeof fetch;
      return { fetchImpl, reports, contentTypes };
    }

    it('is off by default', async () => {
      const { fetchImpl, reports } = recorder();
      const client = new HarmoniqClient(options(fetchImpl));
      await client.init();
      client.reportModuleLoad('checkout', { success: true, loadMs: 10 });
      client.flushHealth();
      expect(reports).toEqual([]);
    });

    it('batches reports with the manifest version and flushes on a timer', async () => {
      const { fetchImpl, reports, contentTypes } = recorder();
      const client = new HarmoniqClient({ ...options(fetchImpl), reportHealth: true });
      await client.init();
      client.reportModuleLoad('checkout', { success: true, loadMs: 142.4 });
      client.reportModuleError('checkout', new TypeError('boom'));
      client.reportModuleLoad('not-in-manifest', { success: true });
      expect(reports).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(reports).toHaveLength(1);
      expect(contentTypes[0]).toBe('text/plain;charset=UTF-8');
      expect(reports[0].client).toMatch(/^harmoniq-js\//);
      expect(reports[0].events).toEqual([
        { module: 'checkout', version: '1.0.0', success: true, loadMs: 142 },
        { module: 'checkout', version: '1.0.0', success: false, error: 'TypeError: boom' },
      ]);
    });

    it('sends a full batch of 20 at once', async () => {
      const { fetchImpl, reports } = recorder();
      const client = new HarmoniqClient({ ...options(fetchImpl), reportHealth: true });
      await client.init();
      for (let i = 0; i < 20; i++) client.reportModuleLoad('checkout', { success: true });
      expect(reports).toHaveLength(1);
      expect(reports[0].events).toHaveLength(20);
    });

    it('samples, and never reports overridden modules', async () => {
      const { fetchImpl, reports } = recorder();
      const client = new HarmoniqClient({
        ...options(fetchImpl),
        reportHealth: { sampleRate: 0 },
      });
      await client.init();
      client.reportModuleLoad('checkout', { success: true });
      client.flushHealth();
      expect(reports).toHaveLength(0);

      const local = new HarmoniqClient({
        ...options(fetchImpl),
        reportHealth: true,
        allowOverrides: true,
        overrides: { checkout: 'http://localhost:5001/remoteEntry.js' },
      });
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      await local.init();
      local.reportModuleLoad('checkout', { success: true });
      local.flushHealth();
      expect(reports).toHaveLength(0);
    });

    it('flushes what is queued on destroy()', async () => {
      const { fetchImpl, reports } = recorder();
      const client = new HarmoniqClient({ ...options(fetchImpl), reportHealth: true });
      await client.init();
      client.reportModuleLoad('checkout', { success: true });
      client.destroy();
      expect(reports).toHaveLength(1);
    });
  });

  describe('developer overrides and preview environments (M2.6)', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('ignores overrides unless allowed', async () => {
      vi.stubGlobal('location', {
        search: '?harmoniq-override=checkout@http://localhost:5001/remoteEntry.js',
      });
      const { fetchImpl } = fakeRegistry([manifest('1.0.0')]);
      const client = new HarmoniqClient(options(fetchImpl));
      await client.init();
      expect(client.getModuleEntry('checkout')?.version).toBe('1.0.0');
    });

    it('applies query-string overrides (including scoped names) and announces them', async () => {
      vi.stubGlobal('location', {
        search:
          '?harmoniq-override=checkout@http://localhost:5001/remoteEntry.js,@acme/nav@http://localhost:5002/x.js',
      });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { fetchImpl } = fakeRegistry([manifest('1.0.0')]);
      const client = new HarmoniqClient({ ...options(fetchImpl), allowOverrides: true });
      const active = vi.fn();
      client.on(EVENTS.overrideActive, active);
      await client.init();

      expect(client.getModuleEntry('checkout')).toEqual({
        url: 'http://localhost:5001/remoteEntry.js',
        integrity: '',
        version: 'override',
      });
      expect(client.getModuleEntry('@acme/nav')?.url).toBe('http://localhost:5002/x.js');
      expect(client.getScriptTag('checkout')).not.toContain('integrity');
      expect(active).toHaveBeenCalledWith({
        checkout: 'http://localhost:5001/remoteEntry.js',
        '@acme/nav': 'http://localhost:5002/x.js',
      });
      expect(warn).toHaveBeenCalled();
    });

    it('rejects non-http override URLs', async () => {
      const { fetchImpl } = fakeRegistry([manifest('1.0.0')]);
      const client = new HarmoniqClient({
        ...options(fetchImpl),
        allowOverrides: true,
        overrides: { checkout: 'javascript:alert(1)' },
      });
      await client.init();
      expect(client.getOverrides()).toEqual({});
      expect(client.getModuleEntry('checkout')?.version).toBe('1.0.0');
    });

    it('selects the environment from the query string for preview links', async () => {
      vi.stubGlobal('location', { search: '?harmoniq-env=pr-123' });
      const { fetchImpl } = fakeRegistry([manifest('1.0.0', { environment: 'pr-123' })]);
      const client = new HarmoniqClient({
        ...options(fetchImpl),
        environmentFromQuery: 'harmoniq-env',
      });
      await client.init();
      expect(client.getEnvironment()).toBe('pr-123');
      expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
        'http://registry.test/api/manifest/acme/portal/pr-123'
      );
    });
  });
});
