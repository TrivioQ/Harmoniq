// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'dns';
import { lookup as dnsLookupAsync } from 'dns/promises';
import { Agent as HttpAgent } from 'http';
import { Agent as HttpsAgent } from 'https';
import { isIP } from 'net';
import ipaddr from 'ipaddr.js';
import { Agent, fetch as undiciFetch } from 'undici';

// Outbound requests to URLs chosen by API callers (webhooks, bundles, workspace OIDC
// issuers, workspace bucket endpoints) must only reach the public internet. Two layers:
// `checkPublicUrl` refuses bad URLs up front with a readable error, and the guarded DNS
// lookup re-checks every address at connect time, so a hostname that re-resolves to an
// internal address after the check (DNS rebinding) is still refused.

/**
 * True only for ordinary public unicast addresses. Everything else is refused:
 * loopback, private, link-local (cloud metadata), CGNAT, multicast, broadcast, reserved
 * and documentation ranges, and IPv6 forms that embed an IPv4 address (IPv4-mapped,
 * IPv4-compatible, NAT64, 6to4, Teredo), whatever notation they are written in.
 */
export function isPublicAddress(address: string): boolean {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.parse(address.replace(/^\[|\]$/g, '').replace(/%.*$/, ''));
  } catch {
    return false;
  }
  if (parsed.kind() === 'ipv6') {
    const v6 = parsed as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) return isPublicAddress(v6.toIPv4Address().toString());
    // Deprecated IPv4-compatible addresses (::a.b.c.d) are routed as the embedded IPv4.
    if (v6.parts.slice(0, 6).every((p) => p === 0)) return false;
  }
  return parsed.range() === 'unicast';
}

export const isPrivateAddress = (address: string) => !isPublicAddress(address);

const BLOCKED = 'URL resolves to a private or internal address';

/**
 * Checks a caller-supplied URL: HTTPS (HTTP only when allowed) and every address the
 * host resolves to public. Returns an error message, or null when the URL is allowed.
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
    addresses = isIP(host)
      ? [host]
      : (await dnsLookupAsync(host, { all: true })).map((a) => a.address);
  } catch {
    return `Cannot resolve host ${host}`;
  }
  if (!addresses.length || addresses.some(isPrivateAddress)) return BLOCKED;
  return null;
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number
) => void;

/**
 * A drop-in for `dns.lookup` (as used by `net.connect`, `https.Agent` and undici) that
 * fails when any resolved address is not public.
 */
export function guardedLookup(hostname: string, options: LookupOptions, callback: LookupCallback) {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, options.all ? [] : '', undefined);
    const list = addresses as LookupAddress[];
    if (!list.length || list.some((a) => isPrivateAddress(a.address))) {
      const blocked: NodeJS.ErrnoException = new Error(`${BLOCKED} (${hostname})`);
      blocked.code = 'EHOSTBLOCKED';
      return callback(blocked, options.all ? [] : '', undefined);
    }
    if (options.all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
}

let guardedAgent: Agent | undefined;

/**
 * `fetch` for caller-supplied URLs: the URL is checked first, then every connection the
 * request opens resolves through `guardedLookup`. Redirects are never followed, since a
 * redirect target was never checked. With `allowPrivate`, this is plain undici fetch
 * (development, or an instance that opted in for internal IdPs).
 */
export function createSafeFetch(opts: {
  allowHttp: boolean;
  allowPrivate?: boolean;
}): typeof fetch {
  if (opts.allowPrivate) {
    return ((input: string | URL, init?: RequestInit) =>
      undiciFetch(input, { ...(init as object), redirect: 'manual' })) as unknown as typeof fetch;
  }
  guardedAgent ??= new Agent({ connect: { lookup: guardedLookup } });
  const dispatcher = guardedAgent;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const blocked = await checkPublicUrl(url, { allowHttp: opts.allowHttp });
    if (blocked) throw new Error(`Blocked: ${blocked}`);
    return undiciFetch(url, { ...(init as object), redirect: 'manual', dispatcher });
  }) as unknown as typeof fetch;
}

let httpsAgent: HttpsAgent | undefined;

/** A Node `https.Agent` whose connections resolve through `guardedLookup`. */
export function guardedHttpsAgent(): HttpsAgent {
  return (httpsAgent ??= new HttpsAgent({ keepAlive: true, lookup: guardedLookup as never }));
}

let httpAgent: HttpAgent | undefined;

/** A Node `http.Agent` whose connections resolve through `guardedLookup`. */
export function guardedHttpAgent(): HttpAgent {
  return (httpAgent ??= new HttpAgent({ keepAlive: true, lookup: guardedLookup as never }));
}
