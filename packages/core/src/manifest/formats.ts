// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import type { Manifest } from '../schemas/ManifestSchema';

/**
 * IMP-01/02: a standards-compliant import map. Specifiers default to the module name;
 * the `integrity` section lets browsers verify each module (supported by modern browsers
 * and es-module-shims).
 */
export function toImportMap(manifest: Pick<Manifest, 'modules'>) {
  const imports: Record<string, string> = {};
  const integrity: Record<string, string> = {};
  // Disabled modules (kill switch) are left out, so imports of them fail fast.
  for (const m of manifest.modules.filter((mod) => !mod.disabled)) {
    imports[m.specifier ?? m.name] = m.url;
    if (m.integrity) integrity[m.url] = m.integrity;
  }
  return { imports, integrity };
}

/** Native Federation (`@angular-architects/native-federation`) manifest: name → remoteEntry URL. */
export function toFederationManifest(manifest: Pick<Manifest, 'modules'>): Record<string, string> {
  return Object.fromEntries(
    manifest.modules.filter((m) => !m.disabled).map((m) => [m.name, m.url])
  );
}
