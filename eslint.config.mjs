// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ['**/dist/**', '**/build/**', '**/.next/**', '**/out/**', '**/node_modules/**'],
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    // MT-09: registry routes act for one tenant. The system client bypasses Row-Level
    // Security, so routes use `withTenant` / `withOrg`. Files whose purpose spans tenants
    // (instance admin, sign-in, token-authenticated SCIM, public manifests) disable this
    // rule at the top with the reason; any other use is marked on its line.
    files: ['apps/registry/src/routes/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "Identifier[name='systemDb']",
          message:
            'MT-09: routes use withTenant / withOrg (RLS). The system client is for tenant resolution, creating tenants and system tables; mark such a use with an eslint-disable comment giving the reason.',
        },
      ],
    },
  }
);
