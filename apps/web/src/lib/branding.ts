// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { cache } from 'react';
import { registryFetch } from './registry';

export interface Branding {
  name: string;
  logoUrl?: string;
  supportUrl?: string;
  accentColor?: string;
}

/** INST-22 */
export interface Announcement {
  message: string;
  level: 'info' | 'warning' | 'maintenance';
  startsAt?: string;
  endsAt?: string;
}

/** INST-37: running (`active`) or announced. */
export interface Maintenance {
  active: boolean;
  from: string | null;
  until: string | null;
  message: string | null;
}

export interface InstanceInfo {
  branding: Branding;
  announcement: Announcement | null;
  maintenance: Maintenance | null;
}

/** `GET /api/instance`, once per request; defaults if the registry is unreachable. */
export const getInstance = cache(async (): Promise<InstanceInfo> => {
  try {
    const info = await registryFetch<Partial<InstanceInfo>>('/api/instance');
    return {
      branding: info.branding ?? { name: 'Harmoniq' },
      announcement: info.announcement ?? null,
      maintenance: info.maintenance ?? null,
    };
  } catch {
    return { branding: { name: 'Harmoniq' }, announcement: null, maintenance: null };
  }
});

/** INST-14: the instance's name and look. */
export const getBranding = async (): Promise<Branding> => (await getInstance()).branding;
