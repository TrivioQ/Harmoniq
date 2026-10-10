// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { authedClient } from './context';
import type { Context } from './context';
import { CliError, EXIT } from './errors';
import { emit, enc } from './output';

interface Pending {
  status: 'pending_approval';
  requestId: string;
  requiredApprovers: number;
  expiresAt: string;
}

interface RequestState {
  status: string;
  result?: { statusCode: number; body: unknown } | null;
}

const pollMs = () => Number(process.env.HARMONIQ_APPROVAL_POLL_MS ?? 10_000);

export function isPending(result: unknown): result is Pending {
  return (result as Pending | null)?.status === 'pending_approval';
}

/**
 * APR-04: the registry answered 202, the change waits for approval. Without `--wait`
 * prints the request and exits 6; with it, polls until the request is decided and
 * returns the executed call's response (or fails if rejected, expired or failed).
 */
export async function awaitApproval<T>(
  ctx: Context,
  workspace: string,
  pending: Pending
): Promise<T | null> {
  const path = `/api/workspaces/${enc(workspace)}/approvals/${enc(pending.requestId)}`;
  if (!ctx.wait) {
    emit(
      ctx,
      pending,
      `Waiting for approval: request ${pending.requestId} needs ${pending.requiredApprovers} approval(s) by ${pending.expiresAt}. Approve it in the dashboard; rerun with --wait to block until it is decided.`
    );
    process.exitCode = EXIT.pending;
    return null;
  }
  console.error(`Waiting for approval of request ${pending.requestId}…`);
  for (;;) {
    const state = await authedClient(ctx).get<RequestState>(path);
    if (state.status === 'executed') return state.result!.body as T;
    if (state.status !== 'pending_approval' && state.status !== 'executing') {
      const reason =
        state.status === 'failed'
          ? `the approved change failed: ${JSON.stringify(state.result?.body)}`
          : `the request was ${state.status}`;
      throw new CliError(`Not applied: ${reason}`, EXIT.conflict, state);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs()));
  }
}

/** The response of a call that may have become a pending approval request. */
export async function settleApproval<T>(
  ctx: Context,
  workspace: string,
  result: T
): Promise<T | null> {
  return isPending(result) ? awaitApproval<T>(ctx, workspace, result) : result;
}
