import { ref, onMounted, onUnmounted, inject, App } from 'vue';
import { HarmoniqClient } from '../index';
import type { HarmoniqClientOptions } from '../index';

export const HARMONIQ_CLIENT_KEY = Symbol('HarmoniqClient');

export const createHarmoniq = (options: HarmoniqClientOptions) => {
  const client = new HarmoniqClient(options);
  // Auto-init manifest loading
  client.init().catch(console.error);

  return {
    install(app: App) {
      app.provide(HARMONIQ_CLIENT_KEY, client);
    },
    client,
  };
};

export const useHarmoniqClient = (): HarmoniqClient => {
  const client = inject<HarmoniqClient>(HARMONIQ_CLIENT_KEY);
  if (!client) {
    throw new Error(
      'useHarmoniqClient must be used within a Vue component that has the Harmoniq plugin installed'
    );
  }
  return client;
};

export interface UseRemoteModuleResult {
  url: string | null;
  integrity: string | null;
  loading: boolean;
  error: Error | null;
}

export const useHarmoniq = (moduleName: string) => {
  const client = useHarmoniqClient();
  const url = ref<string | null>(null);
  const integrity = ref<string | null>(null);
  const loading = ref<boolean>(true);
  const error = ref<Error | null>(null);

  const load = async () => {
    try {
      await client.init();
      const entry = client.getModuleEntry(moduleName);
      if (entry) {
        url.value = entry.url;
        integrity.value = entry.integrity || null;
        loading.value = false;
        error.value = null;
        client.reportModuleLoad(moduleName, { success: true, variant: client.getVariant() });
      } else {
        const err = new Error(`Module ${moduleName} not found in manifest`);
        url.value = null;
        integrity.value = null;
        loading.value = false;
        error.value = err;
        client.reportModuleError(moduleName, { error: err.message, variant: client.getVariant() });
      }
    } catch (err: unknown) {
      const errorObj = err instanceof Error ? err : new Error(String(err));
      url.value = null;
      integrity.value = null;
      loading.value = false;
      error.value = errorObj;
      client.reportModuleError(moduleName, {
        error: errorObj.message,
        variant: client.getVariant(),
      });
    }
  };

  const handleUpdate = () => {
    load();
  };

  onMounted(() => {
    load();
    client.on('manifestUpdated', handleUpdate);
  });

  onUnmounted(() => {
    client.off('manifestUpdated', handleUpdate);
  });

  return { url, integrity, loading, error };
};
