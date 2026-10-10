// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

/**
 * Content-Security-Policy for dashboard pages. Scripts need this request's nonce (Next.js
 * adds it to its own scripts when it sees the policy on the request); `strict-dynamic`
 * lets those scripts load the app's chunks. Images may come from anywhere over HTTPS
 * (instance branding logos). `form-action` is left out: sign-in forms post to the
 * registry, which redirects to SSO providers.
 */
export function contentSecurityPolicy(
  nonce: string,
  { isDev = false, https = true }: { isDev?: boolean; https?: boolean } = {}
): string {
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    // React's development build uses eval for stack reconstruction.
    'script-src': [
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      ...(isDev ? ["'unsafe-eval'"] : []),
    ],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:', 'https:'],
    'font-src': ["'self'", 'data:'],
    // Hot reload in development.
    'connect-src': ["'self'", ...(isDev ? ['ws:'] : [])],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'frame-ancestors': ["'none'"],
  };
  const policy = Object.entries(directives).map(([name, values]) => `${name} ${values.join(' ')}`);
  // Only over HTTPS: a plain-HTTP install (Docker Compose on localhost) would break.
  if (https && !isDev) policy.push('upgrade-insecure-requests');
  return policy.join('; ');
}

export function createNonce(): string {
  return btoa(crypto.randomUUID());
}
