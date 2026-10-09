import React, {
  ReactNode,
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react';
import { EVENTS, HarmoniqClient } from '../index';
import type { HarmoniqClientOptions, Manifest, ModuleEntry } from '../index';

const HarmoniqContext = createContext<HarmoniqClient | null>(null);

export interface HarmoniqProviderProps {
  /** Options for a client the provider creates (and destroys on unmount). */
  options?: HarmoniqClientOptions;
  /** Or an existing client, e.g. one shared with non-React code. */
  client?: HarmoniqClient;
  /** Rendered until the first manifest has loaded. Children render immediately without it. */
  fallback?: ReactNode;
  children: ReactNode;
}

/**
 * ADP-02. Creates the client during the first render (so SSR renders children, never
 * `null`) and starts loading only in the browser. Option changes after mount are ignored.
 */
export function HarmoniqProvider({
  options,
  client: provided,
  fallback,
  children,
}: HarmoniqProviderProps) {
  const [client] = useState(() => {
    if (provided) return provided;
    if (!options) throw new Error('HarmoniqProvider needs `options` or `client`');
    return new HarmoniqClient(options);
  });

  useEffect(() => {
    client.init().catch(() => undefined); // surfaced through useHarmoniqError / useRemoteModule
    return () => {
      if (!provided) client.destroy();
    };
  }, [client, provided]);

  const manifest = useStore(client, () => client.getManifest());
  const content = fallback !== undefined && !manifest ? fallback : children;
  return React.createElement(HarmoniqContext.Provider, { value: client }, content);
}

export function useHarmoniqClient(): HarmoniqClient {
  const client = useContext(HarmoniqContext);
  if (!client) throw new Error('useHarmoniqClient must be used within a HarmoniqProvider');
  return client;
}

/** Re-renders on manifest updates and fetch errors. Server snapshot reads the same state. */
function useStore<T>(client: HarmoniqClient, read: () => T): T {
  return useSyncExternalStore(
    (onChange) => {
      const offUpdate = client.on(EVENTS.manifestUpdate, onChange);
      const offError = client.on(EVENTS.error, onChange);
      return () => {
        offUpdate();
        offError();
      };
    },
    read,
    read
  );
}

export function useManifest(): Manifest | null {
  const client = useHarmoniqClient();
  return useStore(client, () => client.getManifest());
}

export function useHarmoniqError(): Error | null {
  const client = useHarmoniqClient();
  return useStore(client, () => client.getError());
}

export interface UseRemoteModuleResult {
  url: string | null;
  integrity: string | null;
  version: string | null;
  loading: boolean;
  error: Error | null;
  /** Kill switch: render a fallback instead of the module. */
  disabled: boolean;
  disabledReason: string | null;
}

/** The current entry for one module; updates when a new manifest arrives (hot swap). */
export function useRemoteModule(moduleName: string): UseRemoteModuleResult {
  const manifest = useManifest();
  const fetchError = useHarmoniqError();
  const client = useHarmoniqClient();

  const none = { url: null, integrity: null, version: null, disabled: false, disabledReason: null };
  const entry: ModuleEntry | null = manifest ? client.getModuleEntry(moduleName) : null;
  if (entry) return { ...none, ...entry, loading: false, error: null };
  const killed = manifest ? client.isModuleDisabled(moduleName) : null;
  if (killed) {
    return { ...none, disabled: true, disabledReason: killed.reason, loading: false, error: null };
  }
  if (manifest) {
    return {
      ...none,
      loading: false,
      error: new Error(`Module "${moduleName}" is not in the manifest`),
    };
  }
  return { ...none, loading: !fetchError, error: fetchError };
}
