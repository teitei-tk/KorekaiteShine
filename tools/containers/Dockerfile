# workerdのLinux配布バイナリ用。Node.jsとpnpmは後段のAlpine版を使用する。
FROM node:26.12.1-bookworm-slim@sha256:88e480776c6149ff1d098cd304f44bf18057fb5d284a3329b78162d29821e28c AS workerd-libs
RUN set -eu; \
    libdir=$(dirname /lib/*-linux-gnu/ld-linux-*.so.*); \
    loader=$(basename "$libdir"/ld-linux-*.so.*); \
    mkdir -p "/runtime$libdir"; \
    for lib in "$loader" libc.so.6 libm.so.6 libdl.so.2 libpthread.so.0 librt.so.1 libresolv.so.2 libstdc++.so.6 libgcc_s.so.1 libatomic.so.1; do \
      cp -L "$libdir/$lib" "/runtime$libdir/$lib"; \
    done; \
    case "$(dpkg --print-architecture)" in \
      arm64) loaderdir=/lib ;; \
      amd64) loaderdir=/lib64 ;; \
      *) exit 1 ;; \
    esac; \
    mkdir -p "/runtime$loaderdir"; \
    ln -s "$libdir/$loader" "/runtime$loaderdir/$loader"

FROM node:26.12.1-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797

COPY --from=workerd-libs /runtime/ /

RUN apk add --no-cache bash ca-certificates coreutils git procps-ng python3 socat \
    && npm install --global --ignore-scripts --registry=https://npm.flatt.tech/ pnpm@12.15.0 \
    && ln -sf /usr/local/lib/node_modules/pnpm/node_modules/@pnpm/exe.linux-*-musl/pnpm /usr/local/bin/pnpm \
    && test "$(pnpm --version)" = 12.15.0 \
    && install -d -o node -g node /work /store /work/.local /registry

USER node
WORKDIR /work

COPY registry-proxy.mjs check-registry.mjs entrypoint.sh /opt/containers/
