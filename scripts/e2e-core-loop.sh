#!/usr/bin/env bash
# M1 end-to-end check: drives the built `harmoniq` CLI against a running registry through
# deploy → manifest → promote → deploy → rollback → freeze, asserting each step.
#
# Requires: a registry with HARMONIQ_DEV_LOGIN=1 (default http://localhost:4000), the CLI
# built (pnpm --filter @harmoniq/cli build), curl and jq.
#
#   REGISTRY_URL=http://localhost:4000 scripts/e2e-core-loop.sh
set -euo pipefail

REGISTRY_URL="${REGISTRY_URL:-http://localhost:4000}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="node $ROOT/packages/cli/dist/index.mjs --registry-url $REGISTRY_URL"
WS="e2e-$(date +%s)"
export HARMONIQ_CONFIG_DIR="$(mktemp -d)"
trap 'rm -rf "$HARMONIQ_CONFIG_DIR"' EXIT

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; exit 1; }
expect_eq() { [[ "$1" == "$2" ]] && pass "$3" || fail "$3 (expected '$2', got '$1')"; }
api() { # method path [body]
  curl -sf -X "$1" "$REGISTRY_URL$2" -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' ${3:+-d "$3"}
}
active_version() { # env
  curl -sf "$REGISTRY_URL/api/manifest/$WS/default/$1" | jq -r '.modules[] | select(.name=="checkout") | .version'
}

echo "Setup ($WS)"
TOKEN=$(curl -sf -X POST "$REGISTRY_URL/api/auth/dev/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"e2e-$WS@example.com\"}" | jq -r .accessToken)
api POST /api/workspaces "{\"name\":\"E2E\",\"slug\":\"$WS\"}" >/dev/null
api POST "/api/workspaces/$WS/modules" '{"hostApp":"default","name":"Checkout","slug":"checkout"}' >/dev/null
KEY=$(api POST "/api/workspaces/$WS/api-keys" '{"name":"e2e","scopes":["deploy:write"]}' | jq -r .key)
pass "workspace, module and deploy key created"

echo "CLI"
$CLI --api-key "$KEY" --workspace "$WS" login >/dev/null
pass "login saved a profile"
expect_eq "$($CLI --json whoami | jq -r .workspace)" "$WS" "whoami uses the saved profile"

deploy() { # env version
  $CLI deploy --module checkout --env "$1" --release "$2" \
    --url "https://cdn.example.com/checkout/$2/remoteEntry.js" --integrity "sha384-v${2//./}"
}
deploy staging 1.0.0 >/dev/null
expect_eq "$(active_version staging)" "1.0.0" "deploy to staging"
expect_eq "$(active_version production)" "" "production untouched"

$CLI promote --module checkout --from staging --to production >/dev/null
expect_eq "$(active_version production)" "1.0.0" "promote staging → production"

deploy production 2.0.0 >/dev/null
expect_eq "$(active_version production)" "2.0.0" "deploy 2.0.0 to production"

$CLI rollback --module checkout --env production >/dev/null
expect_eq "$(active_version production)" "1.0.0" "rollback to previous"

ETAG=$(curl -sfI "$REGISTRY_URL/api/manifest/$WS/default/production" | awk 'tolower($1)=="etag:" {print $2}' | tr -d '\r')
STATUS=$(curl -s -o /dev/null -w '%{http_code}' -H "If-None-Match: $ETAG" "$REGISTRY_URL/api/manifest/$WS/default/production")
expect_eq "$STATUS" "304" "manifest revalidates with its ETag"

SNAPS=$(api GET "/api/manifest/$WS/default/production/snapshots")
expect_eq "$(jq '.snapshots | length' <<<"$SNAPS")" "3" "three production snapshots"
FROM=$(jq -r '.snapshots[1].id' <<<"$SNAPS")
CHANGED=$(api GET "/api/manifest/$WS/default/production/diff?from=$FROM" | jq -r '.changed[0].to.version')
expect_eq "$CHANGED" "1.0.0" "diff shows the rollback"

echo "Freeze"
OWNER_FREEZE="/api/workspaces/$WS/host-apps/default/environments/production/freeze"
api PUT "$OWNER_FREEZE" '{"reason":"e2e freeze"}' >/dev/null
set +e
deploy production 3.0.0 >/dev/null 2>&1
CODE=$?
set -e
expect_eq "$CODE" "4" "deploy to a frozen environment exits 4"
api DELETE "$OWNER_FREEZE" >/dev/null
deploy production 3.0.0 >/dev/null
expect_eq "$(active_version production)" "3.0.0" "deploy works after unfreeze"

echo "All core-loop checks passed."
