#!/usr/bin/env bash

set -e

# Generates Go and Python client SDKs from the OpenAPI spec
# Requires openapi-generator-cli to be installed globally or available via npx

echo "Generating SDKs from OpenAPI spec..."

SPEC_URL="http://localhost:3002/api-docs/json"
OUTPUT_DIR="packages/sdks"

mkdir -p $OUTPUT_DIR

# 1. Download spec
echo "Downloading OpenAPI spec from $SPEC_URL..."
curl -s $SPEC_URL > $OUTPUT_DIR/openapi.json

# 2. Generate Go Client
echo "Generating Go Client..."
npx @openapitools/openapi-generator-cli generate \
  -i $OUTPUT_DIR/openapi.json \
  -g go \
  -o $OUTPUT_DIR/go \
  --package-name harmoniq \
  --additional-properties=packageName=harmoniq,isGoSubmodule=true

# 3. Generate Python Client
echo "Generating Python Client..."
npx @openapitools/openapi-generator-cli generate \
  -i $OUTPUT_DIR/openapi.json \
  -g python \
  -o $OUTPUT_DIR/python \
  --package-name harmoniq \
  --additional-properties=packageName=harmoniq,projectName=harmoniq-client

echo "SDK Generation complete! Output in $OUTPUT_DIR"
