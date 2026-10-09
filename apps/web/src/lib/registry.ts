import { cookies } from 'next/headers';
import type { MeResponse } from '@harmoniq/core/dist/schemas/AuthSchemas';
import { getRegistryUrl } from './env';
import { ACCESS_COOKIE } from './session';

// Server-only: the dashboard reads and writes data exclusively through the registry API,
// which owns authorization, audit and tenant isolation.

export class RegistryError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'RegistryError';
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Bearer token; omit for unauthenticated endpoints (sign-in, setup). */
  token?: string;
}

export async function registryFetch<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

  const res = await fetch(`${getRegistryUrl()}${path}`, {
    method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    cache: 'no-store',
  });

  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new RegistryError(
      res.status,
      data?.error?.code ?? 'UNKNOWN',
      data?.error?.message ?? `Registry request failed (${res.status})`
    );
  }
  return data as T;
}

/** Calls the registry as the signed-in user (session cookie → bearer token). */
export async function authedFetch<T>(path: string, opts: Omit<RequestOptions, 'token'> = {}) {
  const token = (await cookies()).get(ACCESS_COOKIE)?.value;
  if (!token) throw new RegistryError(401, 'UNAUTHORIZED', 'Not signed in');
  return registryFetch<T>(path, { ...opts, token });
}

/** The signed-in user and their workspaces, or null when there is no valid session. */
export async function getMe(): Promise<MeResponse | null> {
  try {
    return await authedFetch<MeResponse>('/api/me');
  } catch (err) {
    if (err instanceof RegistryError && err.status === 401) return null;
    throw err;
  }
}
