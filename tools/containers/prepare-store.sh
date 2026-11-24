#!/bin/sh
set -eu
store_root=$1
generation=$(mktemp -d "$store_root"/generation.XXXXXXXX)
trap 'rm -rf "$generation"' EXIT
pnpm install --registry="$2" --config.verify-store-integrity=true --frozen-lockfile --ignore-scripts --no-trust-lockfile --network-concurrency=2 \
  --store-dir="$generation/store" --config.cache-dir="$generation/cache" \
  --state-dir="$generation/state"
ln -s "$(basename "$generation")" "$generation/ready"
node -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$generation/ready" "$store_root/current"
trap - EXIT
