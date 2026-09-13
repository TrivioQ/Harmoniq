import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { HarmoniqClient } from '../index';
import type { HarmoniqClientOptions } from '../index';

const HarmoniqContext = createContext<HarmoniqClient | null>(null);

export interface HarmoniqProviderProps {
  options: HarmoniqClientOptions;
  children: ReactNode;
}

export const HarmoniqProvider: React.FC<HarmoniqProviderProps> = ({ options, children }) => {
  const [client, setClient] = useState<HarmoniqClient | null>(null);

  useEffect(() => {
    const newClient = new HarmoniqClient(options);
    // Automatically init the manifest loading
    newClient.init().catch(console.error);
    setClient(newClient);
  }, [options.registryUrl, options.workspaceSlug, options.hostApp, options.environment]);

  if (!client) {
    return null; // Or some fallback UI during init
  }

  return React.createElement(HarmoniqContext.Provider, { value: client }, children);
};

export const useHarmoniqClient = (): HarmoniqClient => {
  const context = useContext(HarmoniqContext);
  if (!context) {
    throw new Error('useHarmoniqClient must be used within a HarmoniqProvider');
  }
  return context;
};

export interface UseRemoteModuleResult {
  url: string | null;
  integrity: string | null;
  loading: boolean;
  error: Error | null;
}

export const useRemoteModule = (moduleName: string): UseRemoteModuleResult => {
  const client = useHarmoniqClient();
  const [state, setState] = useState<UseRemoteModuleResult>({
    url: null,
    integrity: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    let mounted = true;

    const load = async () => {
      try {
        await client.init();
        const entry = client.getModuleEntry(moduleName);
        if (mounted) {
          if (entry) {
            setState({
              url: entry.url,
              integrity: entry.integrity || null,
              loading: false,
              error: null,
            });
            client.reportModuleLoad(moduleName, { success: true, variant: client.getVariant() });
          } else {
            const err = new Error(`Module ${moduleName} not found in manifest`);
            setState({ url: null, integrity: null, loading: false, error: err });
            client.reportModuleError(moduleName, {
              error: err.message,
              variant: client.getVariant(),
            });
          }
        }
      } catch (err: unknown) {
        if (mounted) {
          const error = err instanceof Error ? err : new Error(String(err));
          setState({ url: null, integrity: null, loading: false, error });
          client.reportModuleError(moduleName, {
            error: error.message,
            variant: client.getVariant(),
          });
        }
      }
    };

    load();

    const handleUpdate = () => {
      if (mounted) load();
    };

    client.on('manifestUpdated', handleUpdate);

    return () => {
      mounted = false;
      client.off('manifestUpdated', handleUpdate);
    };
  }, [client, moduleName]);

  return state;
};
