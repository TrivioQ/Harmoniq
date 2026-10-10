// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { checkPublicUrl, isPrivateAddress } from '../services/bundleValidator';
import { createSafeFetch, guardedLookup } from '../services/outbound';

describe('SSRF guard', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.20.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    'fd00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    // Hex notation, as `new URL()` normalizes IPv4-mapped literals (the original bypass).
    '::ffff:7f00:1',
    '::ffff:a9fe:a9fe',
    // Other IPv6 forms that embed an IPv4 address.
    '::7f00:1',
    '64:ff9b::a9fe:a9fe',
    '2002:7f00:1::',
    '2001::1',
    // Reserved, documentation, benchmarking, multicast and broadcast ranges.
    '198.18.0.1',
    '192.0.0.1',
    '192.0.2.1',
    '224.0.0.1',
    '255.255.255.255',
    '2001:db8::1',
    'not-an-ip',
  ])('treats %s as private', (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each(['8.8.8.8', '172.32.0.1', '2606:4700::1111'])('treats %s as public', (ip) =>
    expect(isPrivateAddress(ip)).toBe(false)
  );

  it('rejects http in production, internal hosts and bad URLs', async () => {
    expect(await checkPublicUrl('http://8.8.8.8/x.js', { allowHttp: false })).toContain('https');
    expect(await checkPublicUrl('https://localhost/x.js', { allowHttp: true })).toContain(
      'private'
    );
    expect(await checkPublicUrl('https://[::1]/x.js', { allowHttp: true })).toContain('private');
    expect(await checkPublicUrl('not a url', { allowHttp: true })).toBe('Invalid URL');
    expect(await checkPublicUrl('https://8.8.8.8/x.js', { allowHttp: false })).toBeNull();
  });

  it.each([
    'http://[::ffff:169.254.169.254]/latest/meta-data/',
    'http://[::ffff:127.0.0.1]:4000/health',
    'http://[64:ff9b::a9fe:a9fe]/',
    'http://198.18.0.1/',
  ])('refuses %s', async (url) => {
    expect(await checkPublicUrl(url, { allowHttp: true })).toContain('private');
  });

  it('re-checks addresses at connect time (DNS rebinding)', async () => {
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) =>
      guardedLookup('localhost', {}, (e) => resolve(e))
    );
    expect(err?.code).toBe('EHOSTBLOCKED');
  });

  it('the guarded fetch refuses internal targets before connecting', async () => {
    const safeFetch = createSafeFetch({ allowHttp: true });
    await expect(safeFetch('http://[::ffff:127.0.0.1]:1/')).rejects.toThrow(/Blocked/);
    await expect(safeFetch('http://localhost:1/')).rejects.toThrow(/Blocked/);
  });
});
