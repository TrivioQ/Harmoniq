'use server';

import { RegistryError, registryFetch } from '@/lib/registry';

// INST-01..04: every step proves the one-time setup token to the registry.

export type SetupState =
  { status: 'idle' } | { status: 'success'; email: string } | { status: 'error'; message: string };

export interface Check {
  ok: boolean;
  latencyMs: number;
  error?: string;
  adapter?: string;
}

type StepResult<T> = { ok: true; data: T } | { ok: false; message: string };

async function step<T>(path: string, body: object): Promise<StepResult<T>> {
  try {
    return { ok: true, data: await registryFetch<T>(path, { body }) };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof RegistryError ? err.message : 'The registry did not answer',
    };
  }
}

/** Step 2: database and cache. */
export async function checkConnectivity(setupToken: string) {
  return step<{ database: Check; cache: Check }>('/api/admin/setup/check', { setupToken });
}

/** Step 3: the default storage adapter (write, read back, delete). */
export async function checkStorage(setupToken: string) {
  return step<Check>('/api/admin/setup/storage', { setupToken });
}

/** Step 4: how people will sign in. */
export async function signInMethods() {
  try {
    const { providers } = await registryFetch<{
      providers: Array<{ id: string; displayName: string }>;
    }>('/api/auth/providers');
    return providers;
  } catch {
    return [];
  }
}

/** Creates the first instance admin and consumes the token. */
export async function initializeInstance(input: {
  setupToken: string;
  email: string;
  name?: string;
}): Promise<SetupState> {
  try {
    await registryFetch('/api/admin/setup', { body: input });
    return { status: 'success', email: input.email };
  } catch (err) {
    return {
      status: 'error',
      message: err instanceof RegistryError ? err.message : 'Failed to initialize instance',
    };
  }
}
