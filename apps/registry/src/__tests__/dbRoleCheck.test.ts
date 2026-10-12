// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { appRoleAcceptsPlaceholder } from '../services/dbRoleCheck';

// MT-11: production refuses to start when the app role has the placeholder password.
describe('Database role check (MT-11)', () => {
  const real = process.env.DATABASE_URL!;
  const withPassword = (password: string) => {
    const url = new URL(real);
    url.password = password;
    return url.toString();
  };

  it('flags a DATABASE_URL that uses the placeholder password', async () => {
    expect(await appRoleAcceptsPlaceholder(withPassword('password'))).toBe(true);
  });

  it('detects a role that accepts the placeholder even when the URL has another one', async () => {
    // The development database (docker/init.sql) uses the placeholder on purpose.
    const accepts = await appRoleAcceptsPlaceholder(withPassword('something-else'));
    expect(accepts).toBe(true);
  });

  it('is false when the placeholder is refused or the database is unreachable', async () => {
    const url = new URL(real);
    url.password = 'something-else';
    url.port = '1'; // nothing listens there
    expect(await appRoleAcceptsPlaceholder(url.toString())).toBe(false);
    expect(await appRoleAcceptsPlaceholder('not a url')).toBe(false);
  });
});
