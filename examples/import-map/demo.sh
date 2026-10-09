#!/usr/bin/env bash
# A plain HTML host loads a remote through Harmoniq's import map (with SRI); deploy,
# upgrade and roll back the remote without touching the host.
#
#   node serve.mjs &            # stands in for your CDN (http://localhost:5050)
#   ./demo.sh setup             # workspace + module, deploys 1.0.0, prints the host URL
#   ./demo.sh deploy 2.0.0      # reload the host: 2.0.0
#   ./demo.sh rollback          # reload the host: back to 1.0.0
#
# Needs a registry with HARMONIQ_DEV_LOGIN=1, the CLI built
# (pnpm --filter @harmoniq/cli build) and jq.
set -euo pipefail
cd "$(dirname "$0")"
REGISTRY="${REGISTRY_URL:-http://localhost:4000}"
CDN="${CDN_URL:-http://localhost:5050}"
STATE=.demo.env

cli() { node ../../packages/cli/dist/index.mjs --registry-url "$REGISTRY" --workspace "$WS" --api-key "$KEY" "$@"; }

case "${1:-}" in
  setup)
    WS="example-$(date +%s)"
    TOKEN=$(curl -sf -X POST "$REGISTRY/api/auth/dev/login" -H 'Content-Type: application/json' \
      -d "{\"email\":\"$WS@example.com\"}" | jq -r .accessToken)
    api() { curl -sf -X "$1" "$REGISTRY$2" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$3"; }
    api POST /api/workspaces "{\"name\":\"Import map example\",\"slug\":\"$WS\"}" >/dev/null
    api POST "/api/workspaces/$WS/modules" '{"hostApp":"default","name":"Greeting","slug":"greeting"}' >/dev/null
    api PATCH "/api/workspaces/$WS/modules/greeting" '{"specifier":"@example/greeting"}' >/dev/null
    KEY=$(api POST "/api/workspaces/$WS/api-keys" '{"name":"demo"}' | jq -r .key)
    printf 'WS=%s\nKEY=%s\n' "$WS" "$KEY" > "$STATE"
    "$0" deploy 1.0.0
    echo "Host: $CDN/host/?registry=$REGISTRY&workspace=$WS&env=production"
    ;;
  deploy)
    source "$STATE"
    cli deploy --module greeting --env production --release "$2" \
      --url "$CDN/remotes/greeting/$2/index.js" --file "remotes/greeting/$2/index.js"
    ;;
  rollback)
    source "$STATE"
    cli rollback --module greeting --env production
    ;;
  *)
    echo "usage: $0 setup | deploy <version> | rollback" >&2
    exit 2
    ;;
esac
