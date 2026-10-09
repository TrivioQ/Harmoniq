import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { BundleValidation, validateBundle } from '@harmoniq/core/dist/validation/bundle';

/** True for loopback, private, link-local (incl. cloud metadata), CGNAT and unspecified. */
export function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  const v6 = address.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}

function failed(error: string): BundleValidation {
  return {
    urlReachable: false,
    integrityMatch: null,
    corsAllowed: null,
    contentType: null,
    warnings: [],
    errors: [error],
  };
}

/**
 * The registry fetches URLs supplied by API callers (bundles, webhooks), so targets must
 * be public: HTTPS (HTTP only outside production) and every resolved address public.
 * Returns an error message, or null when the URL is allowed.
 */
export async function checkPublicUrl(
  url: string,
  opts: { allowHttp: boolean }
): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'Invalid URL';
  }
  if (parsed.protocol !== 'https:' && !(opts.allowHttp && parsed.protocol === 'http:')) {
    return 'URL must use https';
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  } catch {
    return `Cannot resolve host ${host}`;
  }
  if (addresses.some(isPrivateAddress)) {
    return 'URL resolves to a private or internal address';
  }
  return null;
}

/** Server-side bundle validation. Redirects are never followed (see validateBundle). */
export async function validateBundleSafely(
  url: string,
  integrity: string,
  opts: { allowHttp: boolean }
): Promise<BundleValidation> {
  const blocked = await checkPublicUrl(url, opts);
  return blocked ? failed(blocked) : validateBundle(url, integrity);
}
