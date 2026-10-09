import type { Manifest, Module } from '../schemas/ManifestSchema';

export interface ModuleChange {
  name: string;
  from: Module;
  to: Module;
  /** Which of version/url/integrity differ. */
  fields: Array<'version' | 'url' | 'integrity'>;
}

export interface ManifestDiff {
  added: Module[];
  removed: Module[];
  changed: ModuleChange[];
}

const COMPARED = ['version', 'url', 'integrity'] as const;

/** DIFF-01: what changed between two manifests, keyed by module name. */
export function diffManifests(
  from: Pick<Manifest, 'modules'>,
  to: Pick<Manifest, 'modules'>
): ManifestDiff {
  const before = new Map(from.modules.map((m) => [m.name, m]));
  const after = new Map(to.modules.map((m) => [m.name, m]));

  const added = to.modules.filter((m) => !before.has(m.name));
  const removed = from.modules.filter((m) => !after.has(m.name));
  const changed: ModuleChange[] = [];
  for (const [name, next] of after) {
    const prev = before.get(name);
    if (!prev) continue;
    const fields = COMPARED.filter((f) => prev[f] !== next[f]);
    if (fields.length) changed.push({ name, from: prev, to: next, fields });
  }
  return { added, removed, changed };
}

export function isEmptyDiff(diff: ManifestDiff): boolean {
  return !diff.added.length && !diff.removed.length && !diff.changed.length;
}
