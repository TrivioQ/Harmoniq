// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { ForbiddenError } from '@harmoniq/core/dist/errors/AppError';
import type { Domains } from './domains';
import type { InstanceSettings } from './instanceSettings';

/**
 * TLC-08: whether a signed-in user may create an organization or a standalone workspace.
 * Instance admins always may. With `verified_domains`, the email's domain must be listed
 * in the setting or verified by some workspace or organization (DOM-01).
 */
export async function assertMayCreateTenant(
  deps: { settings: InstanceSettings; domains: Domains },
  user: { email: string; isInstanceAdmin: boolean },
  what: 'organization' | 'workspace'
) {
  const { creation, allowedDomains } = deps.settings.tenancy();
  if (user.isInstanceAdmin || creation === 'anyone') return;
  if (creation === 'instance_admins') {
    throw new ForbiddenError(`Only instance admins can create a ${what} on this instance`);
  }
  const domain = user.email.split('@')[1]?.toLowerCase() ?? '';
  if (allowedDomains.includes(domain) || (await deps.domains.verifiedOwnerOf(domain))) return;
  throw new ForbiddenError(
    `Creating a ${what} on this instance needs an email address on an approved domain`
  );
}
