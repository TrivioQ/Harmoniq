import { describe, it, expect, vi, afterEach } from 'vitest';
import { ModuleFederation } from '@module-federation/runtime';
import { HarmoniqClient, Manifest } from '@harmoniq/client';
import { harmoniqPlugin, harmoniqRemotes } from '../index';

const manifest = (version: string, modules = ['checkout']): Manifest => ({
  schemaVersion: 2,
  workspaceSlug: 'acme',
  hostApp: { slug: 'portal', name: 'Portal' },
  environment: 'production',
  variant: 'stable',
  cohortId: 'stable',
  generatedAt: '2026-10-09T00:00:00.000Z',
  etag: `sha256-${version}`,
  modules: modules.map((name) => ({
    name,
    url: `https://cdn.example.com/${name}/${version}/remoteEntry.js`,
    integrity: `sha384-${name}${version}`,
    version,
  })),
});

/** A client whose registry answers with the given manifests in turn. */
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

/** Runs the real MF runtime's beforeRequest hook chain, as loadRemote() would. */
async function resolve(instance: ModuleFederation, id: string) {
  const args = await instance.remoteHandler.hooks.lifecycle.beforeRequest.emit({
    id,
    options: instance.options,
    origin: instance,
  });
  return args.options.remotes as Array<{ name: string; entry?: string; version?: string }>;
}

describe('harmoniqPlugin (Module Federation 2.0 runtime)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('points a statically configured remote at the deployed version', async () => {
    const client = clientWith(manifest('1.2.0'));
    const mf = new ModuleFederation({
      name: 'host',
      remotes: [{ name: 'checkout', entry: 'https://old.example.com/remoteEntry.js' }],
      plugins: [harmoniqPlugin(client)],
    });

    const remotes = await resolve(mf, 'checkout/CheckoutPage');
    expect(remotes).toEqual([
      expect.objectContaining({
        name: 'checkout',
        entry: 'https://cdn.example.com/checkout/1.2.0/remoteEntry.js',
      }),
    ]);
  });

  it('adds remotes that are only known to Harmoniq, and maps names', async () => {
    const client = clientWith(manifest('1.0.0', ['nav']));
    const mf = new ModuleFederation({
      name: 'host',
      remotes: [],
      plugins: [harmoniqPlugin(client, { remoteNames: { navigation: 'nav' } })],
    });
    const remotes = await resolve(mf, 'navigation/Header');
    expect(remotes).toEqual([
      expect.objectContaining({
        name: 'navigation',
        entry: 'https://cdn.example.com/nav/1.0.0/remoteEntry.js',
      }),
    ]);
  });

  it('leaves unknown remotes alone, or refuses them in strict mode', async () => {
    const lenient = new ModuleFederation({
      name: 'host',
      remotes: [{ name: 'legacy', entry: 'https://legacy.example.com/remoteEntry.js' }],
      plugins: [harmoniqPlugin(clientWith(manifest('1.0.0')))],
    });
    expect((await resolve(lenient, 'legacy/Widget'))[0].entry).toBe(
      'https://legacy.example.com/remoteEntry.js'
    );

    const strict = new ModuleFederation({
      name: 'host',
      remotes: [],
      plugins: [harmoniqPlugin(clientWith(manifest('1.0.0')), { strict: true })],
    });
    await expect(resolve(strict, 'legacy/Widget')).rejects.toThrow('not in the Harmoniq manifest');
  });

  it('hot-swaps remotes when a new version is deployed', async () => {
    const client = clientWith(manifest('1.0.0'), manifest('1.1.0'));
    const mf = new ModuleFederation({
      name: 'host',
      remotes: [],
      plugins: [harmoniqPlugin(client)],
    });
    await resolve(mf, 'checkout/Page');
    const register = vi.spyOn(mf, 'registerRemotes');

    // Simulate a poll picking up a deploy.
    await (client as unknown as { fetchManifest(): Promise<void> }).fetchManifest();
    // The runtime normalizes the array in place (adds shareScope/type), hence objectContaining.
    expect(register).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          name: 'checkout',
          entry: 'https://cdn.example.com/checkout/1.1.0/remoteEntry.js',
        }),
      ],
      { force: true }
    );
  });

  it('keeps the configured remote type when hot-swapping (ES module entries)', async () => {
    const client = clientWith(manifest('1.0.0'), manifest('1.1.0'));
    const mf = new ModuleFederation({
      name: 'host',
      remotes: [{ name: 'checkout', entry: 'harmoniq:checkout', type: 'module' }],
      plugins: [harmoniqPlugin(client)],
    });
    await resolve(mf, 'checkout/Page');
    const register = vi.spyOn(mf, 'registerRemotes');

    await (client as unknown as { fetchManifest(): Promise<void> }).fetchManifest();
    expect(register).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          name: 'checkout',
          type: 'module',
          entry: 'https://cdn.example.com/checkout/1.1.0/remoteEntry.js',
        }),
      ],
      { force: true }
    );
  });

  it('reports first loads and failures to the client (HLT-01)', async () => {
    const client = clientWith(manifest('1.0.0'));
    const report = vi.spyOn(client, 'reportModuleLoad');
    const mf = new ModuleFederation({
      name: 'host',
      remotes: [],
      plugins: [harmoniqPlugin(client)],
    });
    const after = (args: object) =>
      mf.remoteHandler.hooks.lifecycle.afterLoadRemote.emit({ origin: mf, ...args } as never);
    const remote = {
      name: 'checkout',
      entry: 'https://cdn.example.com/checkout/1.0.0/remoteEntry.js',
    };

    await resolve(mf, 'checkout/Page');
    await after({ id: 'checkout/Page', expose: './Page', remote });
    expect(report).toHaveBeenCalledWith('checkout', {
      success: true,
      loadMs: expect.any(Number),
    });

    // A cached second load is not a new data point; a failure always is.
    await resolve(mf, 'checkout/Page');
    await after({ id: 'checkout/Page', expose: './Page', remote });
    expect(report).toHaveBeenCalledTimes(1);

    const error = new Error('ScriptExternalLoadError');
    await resolve(mf, 'checkout/Cart');
    await after({ id: 'checkout/Cart', expose: './Cart', remote, error });
    expect(report).toHaveBeenLastCalledWith('checkout', {
      success: false,
      loadMs: expect.any(Number),
      error,
    });
  });

  it('refuses disabled remotes without reporting them as failed loads', async () => {
    const off = manifest('1.0.0');
    off.modules[0] = { ...off.modules[0], disabled: true, disabledReason: 'broken' };
    const urls: string[] = [];
    const client = new HarmoniqClient({
      registryUrl: 'http://registry.test',
      workspaceSlug: 'acme',
      hostApp: 'portal',
      environment: 'production',
      persist: false,
      reportHealth: true,
      fetch: (async (url: string) => {
        urls.push(url);
        return new Response(JSON.stringify(off), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const mf = new ModuleFederation({
      name: 'host',
      remotes: [],
      plugins: [harmoniqPlugin(client)],
    });
    await expect(resolve(mf, 'checkout/Page')).rejects.toThrow('disabled: broken');
    await mf.remoteHandler.hooks.lifecycle.afterLoadRemote.emit({
      id: 'checkout/Page',
      error: new Error('disabled'),
      origin: mf,
    } as never);
    client.flushHealth();
    expect(urls.filter((u) => u.includes('/api/health/'))).toEqual([]);
  });

  it('adds SRI and crossorigin to remote entry scripts it knows', async () => {
    const created: Array<Record<string, unknown>> = [];
    vi.stubGlobal('document', {
      createElement: () => {
        const el: Record<string, unknown> = { attrs: {} as Record<string, string> };
        el.setAttribute = (k: string, v: string) => ((el.attrs as Record<string, string>)[k] = v);
        created.push(el);
        return el;
      },
    });
    const client = clientWith(manifest('1.0.0'));
    const mf = new ModuleFederation({
      name: 'host',
      remotes: [],
      plugins: [harmoniqPlugin(client)],
    });
    await resolve(mf, 'checkout/Page');

    const hook = mf.loaderHook.lifecycle.createScript;
    const script = hook.emit({
      url: 'https://cdn.example.com/checkout/1.0.0/remoteEntry.js',
      attrs: { type: 'module', fetchpriority: 'high' },
    }) as unknown as Record<string, unknown>;
    expect(script).toMatchObject({
      integrity: 'sha384-checkout1.0.0',
      crossOrigin: 'anonymous',
      type: 'module',
      attrs: { type: 'module', fetchpriority: 'high' },
    });

    expect(hook.emit({ url: 'https://elsewhere.example.com/x.js' })).toBeUndefined();
  });

  it('lists remotes for init() from a loaded client', async () => {
    const client = clientWith(manifest('2.0.0', ['checkout', 'nav']));
    await client.init();
    expect(harmoniqRemotes(client, { remoteNames: { navigation: 'nav' } })).toEqual([
      { name: 'checkout', entry: 'https://cdn.example.com/checkout/2.0.0/remoteEntry.js' },
      { name: 'navigation', entry: 'https://cdn.example.com/nav/2.0.0/remoteEntry.js' },
    ]);
  });
});
