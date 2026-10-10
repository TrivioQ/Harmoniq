// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

/**
 * VAL-01/03: checks a remote bundle before it is deployed. Runtime-agnostic (fetch +
 * WebCrypto), so the registry (dry-run deploys) and the CLI (`harmoniq validate`) share it.
 */
export interface BundleValidation {
  urlReachable: boolean;
  /** null when the bundle could not be downloaded. */
  integrityMatch: boolean | null;
  /** Whether the response allows cross-origin loading (needed for SRI-checked scripts). */
  corsAllowed: boolean | null;
  contentType: string | null;
  warnings: string[];
  errors: string[];
}

export interface ValidateBundleOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

const ALGORITHMS = { sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512' } as const;

function toBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < view.length; i++) binary += String.fromCharCode(view[i]);
  return btoa(binary);
}

/** Computes an SRI string, e.g. `sha384-…`, for the given content. */
export async function computeIntegrity(
  content: ArrayBuffer,
  algorithm: keyof typeof ALGORITHMS = 'sha384'
): Promise<string> {
  const digest = await crypto.subtle.digest(ALGORITHMS[algorithm], content);
  return `${algorithm}-${toBase64(digest)}`;
}

export async function validateBundle(
  url: string,
  integrity: string,
  { fetchImpl = fetch, timeoutMs = 5000, maxBytes = 20 * 1024 * 1024 }: ValidateBundleOptions = {}
): Promise<BundleValidation> {
  const result: BundleValidation = {
    urlReachable: false,
    integrityMatch: null,
    corsAllowed: null,
    contentType: null,
    warnings: [],
    errors: [],
  };

  const match = /^(sha256|sha384|sha512)-(.+)$/.exec(integrity);
  if (!match) {
    result.errors.push('integrity must be an SRI hash such as sha384-…');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    // Redirects are not followed: a redirect target is unvalidated (and, server-side,
    // could point at internal addresses).
    response = await fetchImpl(url, { signal: controller.signal, redirect: 'manual' });
  } catch (err) {
    clearTimeout(timer);
    result.errors.push(
      controller.signal.aborted
        ? `Timed out after ${timeoutMs}ms`
        : `Unreachable: ${(err as Error).message}`
    );
    return result;
  }

  try {
    if (response.status >= 300 && response.status < 400) {
      result.errors.push(`URL redirects (${response.status}); deploy the final URL instead`);
      return result;
    }
    if (!response.ok) {
      result.errors.push(`URL returned HTTP ${response.status}`);
      return result;
    }
    result.urlReachable = true;

    result.contentType = response.headers.get('content-type');
    if (result.contentType && !/javascript|ecmascript/i.test(result.contentType)) {
      result.warnings.push(
        `Unexpected content-type "${result.contentType}"; browsers may refuse to execute it`
      );
    }
    const acao = response.headers.get('access-control-allow-origin');
    result.corsAllowed = !!acao;
    if (!acao) {
      result.warnings.push(
        'No Access-Control-Allow-Origin header; cross-origin hosts cannot load it with SRI'
      );
    }

    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > maxBytes) {
      result.errors.push(`Bundle is larger than ${maxBytes} bytes`);
      return result;
    }
    const body = await response.arrayBuffer();
    if (body.byteLength > maxBytes) {
      result.errors.push(`Bundle is larger than ${maxBytes} bytes`);
      return result;
    }

    if (match) {
      const actual = await computeIntegrity(body, match[1] as keyof typeof ALGORITHMS);
      result.integrityMatch = actual === integrity;
      if (!result.integrityMatch) {
        result.errors.push(`Integrity mismatch: bundle hashes to ${actual}`);
      }
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

export const isValidBundle = (v: BundleValidation) => v.errors.length === 0;
