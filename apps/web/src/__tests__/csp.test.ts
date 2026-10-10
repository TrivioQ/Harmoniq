// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { contentSecurityPolicy, createNonce } from '../lib/csp';

describe('contentSecurityPolicy', () => {
  it('allows only nonce scripts, no framing, no plugins', () => {
    const csp = contentSecurityPolicy('abc123');
    expect(csp).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain('upgrade-insecure-requests');
    expect(csp).not.toContain('unsafe-eval');
    // SSO sign-in redirects through other origins.
    expect(csp).not.toContain('form-action');
  });

  it('relaxes eval and websockets only in development', () => {
    const csp = contentSecurityPolicy('n', { isDev: true });
    expect(csp).toContain("'unsafe-eval'");
    expect(csp).toContain("connect-src 'self' ws:");
    expect(csp).not.toContain('upgrade-insecure-requests');
  });

  it('upgrades insecure requests only when served over HTTPS', () => {
    expect(contentSecurityPolicy('n', { https: false })).not.toContain('upgrade-insecure-requests');
  });

  it('creates a fresh nonce per request', () => {
    expect(createNonce()).not.toBe(createNonce());
  });
});
