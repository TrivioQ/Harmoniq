#!/usr/bin/env bash
# Copyright The Harmoniq Authors
# SPDX-License-Identifier: Apache-2.0
#
# Tests run.sh (outputs, job summary, exit codes) against a stub CLI.
#   bash actions/deploy/test.sh
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

cat >"$tmp/cli" <<'EOF'
#!/usr/bin/env bash
case "$FAKE" in
  deployed) echo '{"id":"v1","version":"1.2.3","deployedAt":"2026-10-10T09:00:00.000Z","manifestEtag":"sha256-x","manifestUrl":"https://reg/api/manifest/acme/portal/production","changeUrl":"https://app/w/acme/environments/portal/production#snapshot-s1"}' ;;
  pending) echo '{"status":"pending_approval","requestId":"req1","requiredApprovers":2,"expiresAt":"2026-10-11T09:00:00.000Z","approvalUrl":"https://app/w/acme/approvals"}'; exit 6 ;;
  approved) echo 'Waiting for approval of request req9…' >&2; echo '{"id":"v2","version":"1.2.3","deployedAt":"2026-10-10T10:00:00.000Z","manifestUrl":"https://reg/m","changeUrl":"https://app/c"}' ;;
  frozen) echo 'production is frozen: release weekend' >&2; exit 4 ;;
esac
EOF
chmod +x "$tmp/cli"

failures=0
run() {
  : >"$tmp/out"
  : >"$tmp/summary"
  env FAKE="$1" CLI="$tmp/cli" GITHUB_OUTPUT="$tmp/out" GITHUB_STEP_SUMMARY="$tmp/summary" \
    PROMOTE_FROM= MODULE=checkout ENVIRONMENT=production VERSION=1.2.3 URL=https://cdn/x.js \
    FILE= INTEGRITY= PREVIEW_TTL= DRY_RUN=false WAIT=false \
    bash "$here/run.sh" >/dev/null 2>&1
  echo $?
}
expect() { # description, file, pattern
  if ! grep -qF -- "$3" "$tmp/$2"; then
    echo "✗ $1: $2 lacks: $3"
    failures=$((failures + 1))
  fi
}
expect_code() {
  if [[ "$2" != "$3" ]]; then
    echo "✗ $1: exit code $2, expected $3"
    failures=$((failures + 1))
  fi
}

expect_code deployed "$(run deployed)" 0
expect deployed out 'manifest-url=https://reg/api/manifest/acme/portal/production'
expect deployed out 'deployed-at=2026-10-10T09:00:00.000Z'
expect deployed out 'version-id=v1'
expect deployed out 'status=deployed'
expect deployed summary '| Approval | Not required |'
expect deployed summary '[View the change](https://app/w/acme/environments/portal/production#snapshot-s1)'

expect_code pending "$(run pending)" 6
expect pending out 'status=pending-approval'
expect pending out 'approval-request-id=req1'
expect pending summary 'Waiting for 2 approval(s)'
expect pending summary '[review](https://app/w/acme/approvals)'
expect pending summary '| Version | `1.2.3` |'

expect_code approved "$(run approved)" 0
expect approved out 'approval-request-id=req9'
expect approved summary 'Approved (request `req9`)'

expect_code frozen "$(run frozen)" 4
expect frozen summary 'Failed (exit code 4)'
expect frozen summary 'production is frozen'
if grep -q . "$tmp/out"; then
  echo "✗ frozen: no outputs expected"
  failures=$((failures + 1))
fi

if [[ $failures -gt 0 ]]; then
  echo "$failures failure(s)"
  exit 1
fi
echo "Deploy action: all checks passed"
