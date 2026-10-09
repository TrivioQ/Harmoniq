import { describe, it, expect, vi } from 'vitest';
import { HarmoniqClient, Manifest } from '../index';
import { harmoniqSentry } from '../sentry';
import { harmoniqDatadog } from '../datadog';

const manifest = (modules: Record<string, string>, extra: Partial<Manifest> = {}): Manifest => ({
  schemaVersion: 2,
  workspaceSlug: 'acme',
  hostApp: { slug: 'portal', name: 'Portal' },
  environment: 'production',
  variant: 'stable',
  cohortId: 'stable',
  generatedAt: '2026-10-09T00:00:00.000Z',
  etag: `sha256-${Object.values(modules).join('-')}`,
  modules: Object.entries(modules).map(([name, version]) => ({
    name,
    version,
    url: `https://cdn.example.com/${name}/${version}.js`,
    integrity: 'sha384-x',
  })),
  ...extra,
});

function clientWith(...manifests: Manifest[]) {
  const fetchImpl = vi.fn(async () => {
    const next = manifests.length > 1 ? manifests.shift()! : manifests[0];
    return new Response(JSON.stringify(next), { status: 200 });
  });
  return new HarmoniqClient({
    registryUrl: 'http://registry.test',
    workspaceSlug: 'acme',
    hostApp: 'portal',
    environment: 'production',
    fetch: fetchImpl as unknown as typeof fetch,
    persist: false,
  });
}
const poll = (client: HarmoniqClient) =>
  (client as unknown as { fetchManifest(): Promise<void> }).fetchManifest();

describe('telemetry tags (M3.3)', () => {
  it('describes variant, cohort and module versions with short dotted keys', async () => {
    const client = clientWith(
      manifest(
        { checkout: '2.0.0', ['a-very-long-module-name-for-tags']: '1.0.0' },
        { variant: 'canary', cohortId: 'c0ffee' }
      )
    );
    await client.init();
    const tags = client.getTelemetryTags();
    expect(tags).toMatchObject({
      'harmoniq.workspace': 'acme',
      'harmoniq.environment': 'production',
      'harmoniq.variant': 'canary',
      'harmoniq.cohort': 'c0ffee',
      'harmoniq.source': 'network',
      'mf.checkout': '2.0.0',
    });
    expect(Object.keys(tags).every((k) => k.length <= 32)).toBe(true);
  });

  it('keeps Sentry tags in sync and blanks modules that left the manifest', async () => {
    const client = clientWith(
      manifest({ checkout: '1.0.0', cart: '1.0.0' }),
      manifest({ checkout: '1.1.0' })
    );
    const sentry = { setTags: vi.fn(), setContext: vi.fn() };
    const stop = harmoniqSentry(client, sentry);
    await client.init();
    expect(sentry.setTags).toHaveBeenLastCalledWith(
      expect.objectContaining({ 'mf.checkout': '1.0.0', 'mf.cart': '1.0.0' })
    );
    await poll(client);
    expect(sentry.setTags).toHaveBeenLastCalledWith(
      expect.objectContaining({ 'mf.checkout': '1.1.0', 'mf.cart': '' })
    );
    expect(sentry.setContext).toHaveBeenLastCalledWith(
      'harmoniq',
      expect.objectContaining({ modules: { checkout: '1.1.0' } })
    );

    stop();
    const calls = sentry.setTags.mock.calls.length;
    await poll(client);
    expect(sentry.setTags).toHaveBeenCalledTimes(calls);
  });

  it('sets a Datadog RUM global context (v5 or v4 API)', async () => {
    const client = clientWith(manifest({ checkout: '1.0.0' }));
    const v5 = { setGlobalContextProperty: vi.fn() };
    harmoniqDatadog(client, v5);
    await client.init();
    expect(v5.setGlobalContextProperty).toHaveBeenLastCalledWith(
      'harmoniq',
      expect.objectContaining({ variant: 'stable', modules: { checkout: '1.0.0' } })
    );

    const v4 = { addRumGlobalContext: vi.fn() };
    harmoniqDatadog(client, v4);
    expect(v4.addRumGlobalContext).toHaveBeenCalledWith('harmoniq', expect.any(Object));
    expect(() => harmoniqDatadog(client, {})).toThrow(/Unsupported Datadog/);
  });
});
