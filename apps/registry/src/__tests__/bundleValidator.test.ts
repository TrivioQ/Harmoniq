import { describe, it, expect } from 'vitest';
import { checkPublicUrl, isPrivateAddress } from '../services/bundleValidator';

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
});
