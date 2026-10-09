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
});
