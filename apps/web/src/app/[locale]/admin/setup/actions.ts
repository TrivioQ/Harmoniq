'use server';

import { RegistryError, registryFetch } from '@/lib/registry';

export type SetupState =
  { status: 'idle' } | { status: 'success'; email: string } | { status: 'error'; message: string };

export async function initializeInstance(_prev: SetupState, form: FormData): Promise<SetupState> {
  const email = String(form.get('email') ?? '').trim();
  try {
    await registryFetch('/api/admin/setup', {
      body: {
        setupToken: String(form.get('setupToken') ?? ''),
        email,
        name: String(form.get('name') ?? '').trim() || undefined,
      },
    });
    return { status: 'success', email };
  } catch (err) {
    return {
      status: 'error',
      message: err instanceof RegistryError ? err.message : 'Failed to initialize instance',
    };
  }
}
