// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import {
  dependencyMatrix,
  findDependencyConflicts,
  removedExposes,
  HOST_SOURCE,
} from '../manifest/dependencies';

describe('dependency gate (M3.7)', () => {
  const cart = { name: 'cart', dependencies: { react: '^18.2.0', lodash: '4.x' } };
  const host = { name: HOST_SOURCE, dependencies: { react: '>=18.0.0 <19' } };

  it('accepts compatible ranges', () => {
    const checkout = { name: 'checkout', dependencies: { react: '^18.3.0', lodash: '^4.17.0' } };
    expect(findDependencyConflicts(checkout, [cart, host])).toEqual([]);
  });

  it('reports ranges with no common version, per pair', () => {
    const checkout = { name: 'checkout', dependencies: { react: '^19.0.0' } };
    expect(findDependencyConflicts(checkout, [cart, host])).toEqual([
      {
        package: 'react',
        between: [
          { source: 'checkout', range: '^19.0.0' },
          { source: 'cart', range: '^18.2.0' },
        ],
        reason: 'no_common_version',
      },
      {
        package: 'react',
        between: [
          { source: 'checkout', range: '^19.0.0' },
          { source: HOST_SOURCE, range: '>=18.0.0 <19' },
        ],
        reason: 'no_common_version',
      },
    ]);
  });

  it('flags invalid ranges and ignores itself and conflicts it is not part of', () => {
    expect(
      findDependencyConflicts({ name: 'checkout', dependencies: { react: 'banana' } }, [cart])
    ).toMatchObject([{ reason: 'invalid_range' }]);
    const old = { name: 'legacy', dependencies: { react: '^16.0.0' } };
    expect(
      findDependencyConflicts({ name: 'checkout', dependencies: { vue: '^3' } }, [cart, old])
    ).toEqual([]);
    expect(findDependencyConflicts(cart, [cart])).toEqual([]);
  });

  it('builds a matrix with each conflict once', () => {
    const legacy = { name: 'legacy', dependencies: { react: '^16.0.0' } };
    const matrix = dependencyMatrix([cart, legacy, host]);
    expect(matrix.packages).toEqual(['lodash', 'react']);
    const pairs = matrix.conflicts.map((c) =>
      c.between
        .map((b) => b.source)
        .sort()
        .join(' + ')
    );
    expect(pairs.sort()).toEqual([`${HOST_SOURCE} + legacy`, 'cart + legacy']);
  });

  it('finds removed exposes', () => {
    expect(removedExposes({ './A': 'a', './B': 'b' }, { './A': 'a' })).toEqual(['./B']);
    expect(removedExposes(null, { './A': 'a' })).toEqual([]);
  });
});
