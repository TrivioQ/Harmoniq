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
    expect(client.getError()?.message).toBe('offline');
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
});
