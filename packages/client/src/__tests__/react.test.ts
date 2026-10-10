// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { HarmoniqClient, Manifest } from '../index';
import { HarmoniqProvider, useRemoteModule } from '../react';

const manifest: Manifest = {
  schemaVersion: 2,
  workspaceSlug: 'acme',
  hostApp: { slug: 'portal', name: 'Portal' },
  environment: 'production',
  variant: 'stable',
  cohortId: 'stable',
  generatedAt: '2026-10-09T00:00:00.000Z',
  etag: 'sha256-1',
  modules: [
    { name: 'checkout', url: 'https://cdn/checkout.js', integrity: 'sha384-a', version: '1.0.0' },
  ],
};

const options = {
  registryUrl: 'http://registry.test',
  workspaceSlug: 'acme',
  hostApp: 'portal',
  environment: 'production',
};

function Checkout() {
  const mod = useRemoteModule('checkout');
  return React.createElement(
    'span',
    null,
    mod.loading
      ? 'loading'
      : mod.disabled
        ? `disabled:${mod.disabledReason}`
        : mod.error
          ? `error:${mod.error.message}`
          : `${mod.version}@${mod.url}`
  );
}

const render = (props: Partial<React.ComponentProps<typeof HarmoniqProvider>>) =>
  renderToString(
    React.createElement(
      HarmoniqProvider,
      { options, ...props } as React.ComponentProps<typeof HarmoniqProvider>,
      React.createElement(Checkout)
    )
  );

describe('React adapter', () => {
  it('renders children during SSR instead of nothing', () => {
    expect(render({})).toContain('loading');
  });

  it('renders the fallback until the first manifest loads', () => {
    expect(render({ fallback: React.createElement('i', null, 'boot') })).toContain('boot');
  });

  it('renders module entries from an already-loaded client', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(manifest), { status: 200 }));
    const client = new HarmoniqClient({ ...options, fetch: fetchImpl as unknown as typeof fetch });
    await client.init();
    expect(render({ client, options: undefined })).toContain('1.0.0@https://cdn/checkout.js');
  });

  it('reports modules missing from the manifest', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ...manifest, modules: [] }), { status: 200 })
    );
    const client = new HarmoniqClient({ ...options, fetch: fetchImpl as unknown as typeof fetch });
    await client.init();
    expect(render({ client, options: undefined })).toContain('is not in the manifest');
  });

  it('exposes the kill switch instead of an error', async () => {
    const off = {
      ...manifest,
      modules: [{ ...manifest.modules[0], disabled: true, disabledReason: 'broken checkout' }],
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(off), { status: 200 }));
    const client = new HarmoniqClient({ ...options, fetch: fetchImpl as unknown as typeof fetch });
    await client.init();
    expect(render({ client, options: undefined })).toContain('disabled:broken checkout');
  });
});
