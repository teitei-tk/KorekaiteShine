#!/bin/sh
set -eu
cp -R /input/. /work/
export HOME=/tmp/home
mkdir -p "$HOME"
printf '%s\n' 'registry=http://registry-proxy:3128/' > "$HOME/.npmrc"
test "$(pnpm config get registry)" = http://registry-proxy:3128/
if [ "$1" = deps ]; then
  node /opt/containers/check-registry.mjs
  exec sh /opt/containers/prepare-store.sh /store http://registry-proxy:3128/
fi
git init -q
git add -- .
git -c user.name=container -c user.email=container@localhost commit -qm snapshot
cp -R /store/current/. /tmp/dependencies
pnpm install --offline --frozen-lockfile --ignore-scripts \
  --store-dir=/tmp/dependencies/store --config.cache-dir=/tmp/dependencies/cache \
  --state-dir=/tmp/dependencies/state
if [ "${KOREKAITE_CONTAINER_DEV:-}" = 1 ]; then
  socat "TCP4-LISTEN:63286,bind=$(hostname -i),fork,reuseaddr" TCP4:127.0.0.1:63286 &
fi
exec "$@"
