// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  LockedError,
  NotFoundError,
  PlanRequiredError,
  StorageUnavailableError,
  UnauthorizedError,
  ValidationError,
} from '../errors/AppError';
import { IdentityError } from '../ports/IdentityProvider';
import { toFederationManifest, toImportMap } from '../manifest/formats';
import type { Manifest } from '../schemas/ManifestSchema';

describe('AppError family', () => {
  it.each([
    [new NotFoundError('x'), 'NOT_FOUND', 404],
    [new ValidationError('x'), 'VALIDATION_ERROR', 422],
    [new UnauthorizedError(), 'UNAUTHORIZED', 401],
    [new ForbiddenError(), 'FORBIDDEN', 403],
    [new ConflictError('x'), 'CONFLICT', 409],
    [new LockedError('x'), 'LOCKED', 423],
    [new BadRequestError('x'), 'BAD_REQUEST', 400],
    [new StorageUnavailableError('x'), 'STORAGE_UNAVAILABLE', 503],
    [new PlanRequiredError('x'), 'PLAN_REQUIRED', 402],
  ])('%s maps to its code and status', (err, code, status) => {
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code, statusCode: status, name: err.constructor.name });
  });

  it('keeps metadata, defaults messages and status', () => {
    expect(new UnauthorizedError().message).toBe('Unauthorized');
    expect(new ForbiddenError().message).toBe('Forbidden');
    expect(new LockedError('frozen', { until: 'later' }).metadata).toEqual({ until: 'later' });
    expect(new AppError('BOOM', 'boom').statusCode).toBe(500);
  });

  it('IdentityError carries a safe code', () => {
    const err = new IdentityError('email_not_verified', 'Verify your email first');
    expect(err).toMatchObject({ name: 'IdentityError', code: 'email_not_verified' });
    expect(err).toBeInstanceOf(Error);
  });
});

describe('manifest formats', () => {
  const modules = [
    { name: 'checkout', url: 'https://cdn/checkout.js', integrity: 'sha384-a', version: '1' },
    { name: 'cart', specifier: '@acme/cart', url: 'https://cdn/cart.js', version: '1' },
    { name: 'off', url: 'https://cdn/off.js', version: '1', disabled: true },
  ] as Manifest['modules'];

  it('builds an import map with integrity, leaving disabled modules out', () => {
    expect(toImportMap({ modules })).toEqual({
      imports: { checkout: 'https://cdn/checkout.js', '@acme/cart': 'https://cdn/cart.js' },
      integrity: { 'https://cdn/checkout.js': 'sha384-a' },
    });
  });

  it('builds a Native Federation manifest by module name', () => {
    expect(toFederationManifest({ modules })).toEqual({
      checkout: 'https://cdn/checkout.js',
      cart: 'https://cdn/cart.js',
    });
  });
});
