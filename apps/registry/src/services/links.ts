// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import type { Config } from '../config';

const enc = encodeURIComponent;

/**
 * IaC-07/08: where a CI summary links after a change: the public manifest and, in the
 * dashboard, the environment history at the snapshot the change produced (with its diff).
 */
export function changeLinks(
  config: Pick<Config, 'publicUrl' | 'webOrigin'>,
  target: { workspace: string; hostApp: string; environment: string; snapshotId?: string }
) {
  const path = `${enc(target.workspace)}/${enc(target.hostApp)}/${enc(target.environment)}`;
  return {
    hostApp: target.hostApp,
    manifestUrl: `${config.publicUrl}/api/manifest/${path}`,
    ...(target.snapshotId && {
      changeUrl: `${config.webOrigin}/w/${enc(target.workspace)}/environments/${enc(target.hostApp)}/${enc(target.environment)}#snapshot-${target.snapshotId}`,
    }),
  };
}

/** APR-04: the dashboard's queue where a pending change is approved. */
export const approvalsUrl = (config: Pick<Config, 'webOrigin'>, workspace: string) =>
  `${config.webOrigin}/w/${enc(workspace)}/approvals`;
