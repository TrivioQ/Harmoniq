#!/usr/bin/env bash
# Enforces the .agents/AGENTS.md rule: a change touching anything other than docs,
# Markdown or lock files must also update a feature doc in docs/features/.
#
#   scripts/changelog-check.sh [base-ref]   (default: origin/main)
set -euo pipefail

BASE="${1:-origin/main}"
changed="$(git diff --name-only "${BASE}...HEAD")"

code_changes="$(grep -vE '^docs/|\.md$|(^|/)pnpm-lock\.yaml$' <<<"$changed" || true)"
feature_doc_changes="$(grep -E '^docs/features/.+\.md$' <<<"$changed" || true)"

if [[ -n "$code_changes" && -z "$feature_doc_changes" ]]; then
  echo "changelog:check failed: code changed but no docs/features/*.md was updated." >&2
  echo "Add a dated entry to the relevant feature doc's Change History." >&2
  echo "Changed files outside docs:" >&2
  sed 's/^/  /' <<<"$code_changes" >&2
  exit 1
fi

echo "changelog:check passed"
