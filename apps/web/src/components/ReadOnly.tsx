// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

'use client';

import { ReactNode, createContext, useContext } from 'react';

/**
 * INST-20: pages read through support access are read-only. Inside this provider every
 * `ActionForm` is disabled, with `reason` as its tooltip (the registry refuses the change
 * anyway: `403 SUPPORT_READ_ONLY`).
 */
const ReadOnlyContext = createContext<string | null>(null);

export function ReadOnly({ reason, children }: { reason: string | null; children: ReactNode }) {
  return <ReadOnlyContext.Provider value={reason}>{children}</ReadOnlyContext.Provider>;
}

export const useReadOnly = () => useContext(ReadOnlyContext);
