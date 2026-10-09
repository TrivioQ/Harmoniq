import { describe, it, expect } from 'vitest';
import { diffManifests, isEmptyDiff } from '../manifest/diff';

const mod = (name: string, version: string, url = `https://cdn/${name}/${version}.js`) => ({
  name,
  version,
  url,
  integrity: `sha384-${name}${version}`,
});

describe('diffManifests', () => {
  it('reports added, removed and changed modules', () => {
    const diff = diffManifests(
      { modules: [mod('checkout', '1.0.0'), mod('search', '2.0.0')] },
      { modules: [mod('checkout', '1.1.0'), mod('header', '1.0.0')] }
    );
    expect(diff.added.map((m) => m.name)).toEqual(['header']);
    expect(diff.removed.map((m) => m.name)).toEqual(['search']);
    expect(diff.changed).toEqual([
      expect.objectContaining({ name: 'checkout', fields: ['version', 'url', 'integrity'] }),
    ]);
  });

  it('is empty for identical manifests', () => {
    const m = { modules: [mod('checkout', '1.0.0')] };
    expect(isEmptyDiff(diffManifests(m, m))).toBe(true);
  });
});
