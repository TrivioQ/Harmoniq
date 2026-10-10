#!/usr/bin/env bash
# Copyright The Harmoniq Authors
# SPDX-License-Identifier: Apache-2.0
#
# Harmoniq Deploy action: runs the CLI, sets the outputs (IaC-07) and writes the
# deployment card to the job summary (IaC-08). Exits with the CLI's code:
# 2 invalid, 3 auth, 4 frozen, 5 conflict, 6 waiting for approval.
set -uo pipefail

if [[ -n "$PROMOTE_FROM" ]]; then
  args=(promote --module "$MODULE" --from "$PROMOTE_FROM" --to "$ENVIRONMENT")
  title="Promote $MODULE: $PROMOTE_FROM → $ENVIRONMENT"
  done_status=promoted
else
  args=(deploy --module "$MODULE" --env "$ENVIRONMENT" --release "$VERSION" --url "$URL")
  [[ -n "$FILE" ]] && args+=(--file "$FILE")
  [[ -n "$INTEGRITY" ]] && args+=(--integrity "$INTEGRITY")
  [[ -n "$PREVIEW_TTL" ]] && args+=(--preview-ttl "$PREVIEW_TTL")
  title="Deploy $MODULE $VERSION → $ENVIRONMENT"
  done_status=deployed
  if [[ "$DRY_RUN" == "true" ]]; then
    args+=(--dry-run)
    title="Dry run: $MODULE $VERSION → $ENVIRONMENT"
    done_status=dry-run
  fi
fi
global=(--json)
[[ "$WAIT" == "true" ]] && global+=(--wait)

stderr_file="$(mktemp)"
# shellcheck disable=SC2086 # CLI is a command line, e.g. "npx --yes @harmoniq/cli@1".
result="$($CLI "${global[@]}" "${args[@]}" 2>"$stderr_file")"
code=$?
cat "$stderr_file" >&2
echo "$result"

field() { jq -r "$1 // empty" <<<"$result" 2>/dev/null; }
output() { echo "$1=$2" >> "$GITHUB_OUTPUT"; }

status="$done_status"
approval="Not required"
request_id=""
if [[ $code -eq 6 ]]; then
  status=pending-approval
  request_id="$(field .requestId)"
  approval="⏳ Waiting for $(field .requiredApprovers) approval(s) until $(field .expiresAt) — [review]($(field .approvalUrl))"
elif waited="$(grep -oE 'Waiting for approval of request [A-Za-z0-9_-]+' "$stderr_file")"; then
  request_id="${waited##* }"
  approval="✅ Approved (request \`$request_id\`)"
fi

if [[ $code -eq 0 || $code -eq 6 ]]; then
  output version-id "$(field .id)"
  output manifest-url "$(field .manifestUrl)"
  output deployed-at "$(field .deployedAt)"
  output manifest-etag "$(field .manifestEtag)"
  output preview-url "$(field .previewUrl)"
  output change-url "$(field .changeUrl)"
  output status "$status"
  output approval-request-id "$request_id"
fi

row() { [[ -n "$2" ]] && echo "| $1 | $2 |"; }
link() { [[ -n "$1" ]] && echo "[$2]($1)"; }
{
  echo "### $title"
  echo
  if [[ $code -ne 0 && $code -ne 6 ]]; then
    echo "❌ Failed (exit code $code)"
    echo
    echo '```'
    tail -n 20 "$stderr_file"
    echo '```'
  else
    echo "| | |"
    echo "|---|---|"
    row Module "\`$MODULE\`"
    version="$(field .version)"
    version="${version:-$VERSION}"
    row Version "${version:+\`$version\`}"
    row Environment "\`$ENVIRONMENT\`"
    row Status "$status"
    row Approval "$approval"
    row "Deployed at" "$(field .deployedAt)"
    row Manifest "$(link "$(field .manifestUrl)" "$(field .manifestUrl)")"
    row Diff "$(link "$(field .changeUrl)" 'View the change')"
    row Preview "$(link "$(field .previewUrl)" "$(field .previewUrl)")"
    row "Validation errors" "$(jq -r 'if .validation then (.validation.errors | length) else empty end' <<<"$result" 2>/dev/null)"
  fi
} >> "$GITHUB_STEP_SUMMARY"

rm -f "$stderr_file"
exit $code
