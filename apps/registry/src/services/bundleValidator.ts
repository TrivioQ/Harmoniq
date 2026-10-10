// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { BundleValidation, validateBundle } from '@harmoniq/core/dist/validation/bundle';
import { checkPublicUrl, createSafeFetch } from './outbound';

// The SSRF guard lives in ./outbound; re-exported for existing callers.
export { checkPublicUrl, isPrivateAddress, isPublicAddress } from './outbound';

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

/** Server-side bundle validation. Redirects are never followed (see validateBundle). */
export async function validateBundleSafely(
  url: string,
  integrity: string,
  opts: { allowHttp: boolean }
): Promise<BundleValidation> {
  const blocked = await checkPublicUrl(url, opts);
  if (blocked) return failed(blocked);
  // The address is checked again on connect, so a host can't re-resolve to an internal one.
  return validateBundle(url, integrity, { fetchImpl: createSafeFetch(opts) });
}
