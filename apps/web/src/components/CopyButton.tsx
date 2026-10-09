'use client';

import { useState } from 'react';

export function CopyButton({
  text,
  label,
  copiedLabel,
}: {
  text: string;
  label: string;
  copiedLabel: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="text-xs rounded border px-2 py-0.5 bg-background hover:bg-muted"
    >
      {copied ? copiedLabel : label}
    </button>
  );
}
