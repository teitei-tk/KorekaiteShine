FROM node:26.12.1-bookworm-slim@sha256:88e480776c6149ff1d098cd304f44bf18057fb5d284a3329b78162d29821e28c

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git procps python3 socat \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --ignore-scripts --registry=https://npm.flatt.tech/ pnpm@12.15.0 \
    && test "$(pnpm --version)" = 12.15.0 \
    && install -d -o node -g node /work /store /work/.local /registry

USER node
WORKDIR /work

COPY registry-proxy.mjs check-registry.mjs entrypoint.sh /opt/containers/
