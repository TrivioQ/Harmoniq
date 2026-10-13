// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

export type ActionResult =
  | { status: 'idle' }
  | { status: 'success'; message?: string; secret?: string }
  | {
      status: 'error';
      message: string;
      /** INST-32: refused until the user re-authenticates (the form then asks for a code). */
      reauth?: boolean;
    };
