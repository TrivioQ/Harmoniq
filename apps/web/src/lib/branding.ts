import { cache } from 'react';
import { registryFetch } from './registry';

export interface Branding {
  name: string;
  logoUrl?: string;
  supportUrl?: string;
  accentColor?: string;
}

/** INST-14: the instance's name and look (once per request; defaults if unreachable). */
export const getBranding = cache(async (): Promise<Branding> => {
  try {
    return (await registryFetch<{ branding: Branding }>('/api/instance')).branding;
  } catch {
    return { name: 'Harmoniq' };
  }
});
