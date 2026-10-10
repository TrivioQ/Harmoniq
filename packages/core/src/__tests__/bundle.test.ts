import { describe, it, expect } from 'vitest';
import { computeIntegrity, isValidBundle, validateBundle } from '../validation/bundle';

const body = 'export const mount = () => {};';
const bytes = new TextEncoder().encode(body).buffer as ArrayBuffer;

const fakeFetch =
  (status: number, headers: Record<string, string> = {}, content = body) =>
  async () =>
    new Response(status >= 300 && status < 400 ? null : content, { status, headers });

describe('validateBundle', () => {
  it('accepts a reachable bundle with matching integrity and CORS', async () => {
    const integrity = await computeIntegrity(bytes);
    const result = await validateBundle('https://cdn/x.js', integrity, {
      fetchImpl: fakeFetch(200, {
        'content-type': 'application/javascript',
        'access-control-allow-origin': '*',
      }),
    });
    expect(result).toMatchObject({ urlReachable: true, integrityMatch: true, corsAllowed: true });
    expect(isValidBundle(result)).toBe(true);
  });

  it('reports an integrity mismatch with the actual hash', async () => {
    const result = await validateBundle('https://cdn/x.js', 'sha384-AAAA', {
      fetchImpl: fakeFetch(200, { 'content-type': 'text/javascript' }),
    });
    expect(result.integrityMatch).toBe(false);
    expect(result.errors[0]).toContain(await computeIntegrity(bytes));
    expect(result.warnings).toContainEqual(expect.stringContaining('Access-Control-Allow-Origin'));
  });

  it('does not follow redirects', async () => {
    const result = await validateBundle('https://cdn/x.js', 'sha384-AAAA', {
      fetchImpl: fakeFetch(302, { location: 'http://169.254.169.254/' }),
    });
    expect(result.urlReachable).toBe(false);
    expect(result.errors[0]).toContain('redirects');
  });

  it('reports HTTP errors and oversized bundles', async () => {
    expect(
      (await validateBundle('https://cdn/x.js', 'sha384-A', { fetchImpl: fakeFetch(404) }))
        .errors[0]
    ).toContain('404');
    const big = await validateBundle('https://cdn/x.js', 'sha384-A', {
      fetchImpl: fakeFetch(200),
      maxBytes: 4,
    });
    expect(big.errors[0]).toContain('larger');
  });

  it('rejects a declared size over the limit before reading the body', async () => {
    const result = await validateBundle('https://cdn/x.js', 'sha384-A', {
      fetchImpl: fakeFetch(200, { 'content-length': '999999' }),
      maxBytes: 1000,
    });
    expect(result.errors).toEqual(['Bundle is larger than 1000 bytes']);
    expect(result.urlReachable).toBe(true);
  });

  it('reports a malformed integrity, unreachable hosts and timeouts', async () => {
    const integrity = await computeIntegrity(bytes);
    const malformed = await validateBundle('https://cdn/x.js', 'md5-abc', {
      fetchImpl: fakeFetch(200),
    });
    expect(malformed.errors).toEqual(['integrity must be an SRI hash such as sha384-…']);
    expect(malformed.integrityMatch).toBeNull();

    const down = await validateBundle('https://cdn/x.js', integrity, {
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(down.errors).toEqual(['Unreachable: ECONNREFUSED']);

    const slow = await validateBundle('https://cdn/x.js', integrity, {
      timeoutMs: 10,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        ),
    });
    expect(slow.errors).toEqual(['Timed out after 10ms']);
  });
});
