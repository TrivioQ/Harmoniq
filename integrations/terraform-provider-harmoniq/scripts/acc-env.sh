#!/usr/bin/env bash
# Copyright The Harmoniq Authors
# SPDX-License-Identifier: Apache-2.0
#
# Prints the environment for the acceptance tests against a development registry
# (HARMONIQ_DEV_LOGIN=1): signs in, creates an organization and an org key with the
# admin scope. With HARMONIQ_SETUP_TOKEN (the registry's first-boot token) it also
# completes the setup, signs in as that first instance admin and creates an instance key
# and a workspace for the instance administration tests.
#
#   eval "$(scripts/acc-env.sh http://localhost:4000)"
#   TF_ACC=1 go test ./... -run TestAcc -v
set -euo pipefail
registry="${1:-http://localhost:4000}"
org="tfacc-$RANDOM$RANDOM"

json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s)[process.argv[1]];if(!v){console.error(s);process.exit(1)}console.log(v)})' "$1"; }

token=$(curl -sf -XPOST "$registry/api/auth/dev/login" -H 'content-type: application/json' \
  -d "{\"email\":\"$org@example.com\"}" | json accessToken)
curl -sf -XPOST "$registry/api/orgs" -H "authorization: Bearer $token" -H 'content-type: application/json' \
  -d "{\"name\":\"Terraform acceptance\",\"slug\":\"$org\"}" >/dev/null
key=$(curl -sf -XPOST "$registry/api/orgs/$org/keys" -H "authorization: Bearer $token" \
  -H 'content-type: application/json' -d '{"name":"terraform","scopes":["admin"]}' | json key)

echo "export HARMONIQ_REGISTRY_URL=$registry"
echo "export HARMONIQ_API_KEY=$key"
echo "export HARMONIQ_TEST_ORG=$org"

if [ -n "${HARMONIQ_SETUP_TOKEN:-}" ]; then
  admin="tfacc-admin@example.com"
  # Already set up (a second run): the admin exists; sign in all the same.
  curl -s -XPOST "$registry/api/admin/setup" -H 'content-type: application/json' \
    -d "{\"setupToken\":\"$HARMONIQ_SETUP_TOKEN\",\"email\":\"$admin\"}" >/dev/null
  admin_token=$(curl -sf -XPOST "$registry/api/auth/dev/login" -H 'content-type: application/json' \
    -d "{\"email\":\"$admin\"}" | json accessToken)
  # Fails when another admin completed the setup: the instance tests are then skipped.
  if ! instance_key=$(curl -sf -XPOST "$registry/api/admin/api-keys" -H "authorization: Bearer $admin_token" \
    -H 'content-type: application/json' -d '{"name":"terraform","scopes":["instance:admin"]}' | json key 2>/dev/null); then
    echo "acc-env: no instance key ($admin is not an instance admin)" >&2
    exit 0
  fi
  workspace="$org-plan"
  curl -sf -XPOST "$registry/api/workspaces" -H "authorization: Bearer $token" -H 'content-type: application/json' \
    -d "{\"name\":\"Terraform plan\",\"slug\":\"$workspace\"}" >/dev/null
  echo "export HARMONIQ_INSTANCE_API_KEY=$instance_key"
  echo "export HARMONIQ_TEST_WORKSPACE=$workspace"
fi
