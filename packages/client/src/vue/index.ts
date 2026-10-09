import { App, inject, onScopeDispose, readonly, ref } from 'vue';
import { EVENTS, HarmoniqClient } from '../index';
import type { HarmoniqClientOptions } from '../index';

export const HARMONIQ_CLIENT_KEY = Symbol('HarmoniqClient');

/** ADP-04. Vue plugin; loading starts only in the browser. */
export function createHarmoniq(options: HarmoniqClientOptions) {
  const client = new HarmoniqClient(options);
  return {
    client,
    install(app: App) {
      app.provide(HARMONIQ_CLIENT_KEY, client);
      if (typeof window !== 'undefined') client.init().catch(() => undefined);
    },
  };
}

export function useHarmoniqClient(): HarmoniqClient {
  const client = inject<HarmoniqClient>(HARMONIQ_CLIENT_KEY);
  if (!client) {
    throw new Error('useHarmoniqClient must be used in an app with the Harmoniq plugin installed');
  }
  return client;
}

/** Reactive entry for one module; updates on every new manifest and on fetch errors. */
export function useHarmoniq(moduleName: string) {
  const client = useHarmoniqClient();
  const url = ref<string | null>(null);
  const integrity = ref<string | null>(null);
  const version = ref<string | null>(null);
  const loading = ref(true);
  const error = ref<Error | null>(null);
  const disabled = ref(false);
  const disabledReason = ref<string | null>(null);

  const sync = () => {
    const manifest = client.getManifest();
    const entry = client.getModuleEntry(moduleName);
    const killed = client.isModuleDisabled(moduleName);
    url.value = entry?.url ?? null;
    integrity.value = entry?.integrity ?? null;
    version.value = entry?.version ?? null;
    disabled.value = !!killed;
    disabledReason.value = killed?.reason ?? null;
    loading.value = !manifest && !client.getError();
    error.value = manifest
      ? entry || killed
        ? null
        : new Error(`Module "${moduleName}" is not in the manifest`)
      : client.getError();
  };

  sync();
  const offUpdate = client.on(EVENTS.manifestUpdate, sync);
  const offError = client.on(EVENTS.error, sync);
  onScopeDispose(() => {
    offUpdate();
    offError();
  });

  return {
    url: readonly(url),
    integrity: readonly(integrity),
    disabled: readonly(disabled),
    disabledReason: readonly(disabledReason),
    version: readonly(version),
    loading: readonly(loading),
    error: readonly(error),
  };
}
