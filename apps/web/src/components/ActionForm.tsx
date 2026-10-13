// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

'use client';

import { ReactNode, useActionState } from 'react';
import type { ActionResult } from '@/lib/actionResult';
import { ReauthPrompt } from './ReauthPrompt';
import { useReadOnly } from './ReadOnly';

const buttonStyles = {
  primary: 'bg-primary text-primary-foreground hover:bg-primary/90',
  outline: 'border bg-background hover:bg-muted',
  danger: 'bg-red-600 text-white hover:bg-red-700',
};

/**
 * A form bound to a server action. Shows the action's result inline, can ask for
 * confirmation first, and renders one-time secrets (API keys, webhook secrets).
 */
export function ActionForm({
  action,
  children,
  submitLabel,
  pendingLabel,
  confirm,
  variant = 'primary',
  secretHint,
  className = 'space-y-3',
}: {
  action: (prev: ActionResult, form: FormData) => Promise<ActionResult>;
  children?: ReactNode;
  submitLabel: string;
  pendingLabel?: string;
  /** Shown in a browser confirm dialog before submitting. */
  confirm?: string;
  variant?: keyof typeof buttonStyles;
  /** Explains that `result.secret` is shown only once. */
  secretHint?: string;
  className?: string;
}) {
  const [state, formAction, pending] = useActionState(action, { status: 'idle' });
  // INST-20: no changes through support access.
  const readOnly = useReadOnly();

  return (
    <>
      <form
        action={formAction}
        className={className}
        onSubmit={(e) => {
          if (readOnly || (confirm && !window.confirm(confirm))) e.preventDefault();
        }}
      >
        {children}
        <button
          type="submit"
          disabled={pending || !!readOnly}
          title={readOnly ?? undefined}
          className={`inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${buttonStyles[variant]}`}
        >
          {pending ? (pendingLabel ?? submitLabel) : submitLabel}
        </button>
        {state.status === 'error' && !state.reauth && (
          <p role="alert" className="text-sm text-red-700">
            {state.message}
          </p>
        )}
        {state.status === 'success' && state.message && (
          <p role="status" className="text-sm text-green-700">
            {state.message}
          </p>
        )}
        {state.status === 'success' && state.secret && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
            {secretHint && <p className="mb-2 text-amber-900">{secretHint}</p>}
            <code className="block break-all font-mono text-xs select-all">{state.secret}</code>
          </div>
        )}
      </form>
      {state.status === 'error' && state.reauth && <ReauthPrompt />}
    </>
  );
}
