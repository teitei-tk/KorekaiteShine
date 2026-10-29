#!/usr/bin/env bash
# 廃棄可能なGitHub-hosted Linux runnerの共通準備。実WIF要求は行わない。
set -euo pipefail
pnpm install --frozen-lockfile --ignore-scripts
pnpm --dir tools/ai-review exec tsc --ignoreConfig --types node \
  isolation-probe.ts isolation/action-probe.ts isolation/probe-child.ts isolation/run.ts isolation/startup.ts isolation/lifecycle.ts isolation/wif.ts \
  --rewriteRelativeImportExtensions --module NodeNext --target ES2022 --skipLibCheck --outDir "$RUNNER_TEMP/isolation-compiled"
curl --fail --location --proto '=https' --tlsv1.2 \
  https://github.com/openai/codex/releases/download/rust-v0.164.0/codex-x86_64-unknown-linux-musl.tar.gz \
  -o "$RUNNER_TEMP/codex.tar.gz"
echo "90dd0b03b28afcb7fa733a4f73b413db2916a47347efd43fb669cc1c774ee8e4  $RUNNER_TEMP/codex.tar.gz" | sha256sum --check --status
tar -xzf "$RUNNER_TEMP/codex.tar.gz" -C "$RUNNER_TEMP"
sudo install -m 755 "$RUNNER_TEMP/codex-x86_64-unknown-linux-musl" /usr/local/bin/codex
curl --fail --location --proto '=https' --tlsv1.2 \
  https://github.com/openai/codex/releases/download/rust-v0.164.0/codex-responses-api-proxy-x86_64-unknown-linux-musl.tar.gz \
  -o "$RUNNER_TEMP/proxy.tar.gz"
echo "688d0d2b2944f47be81e9b9133786950e765d22ff6c709ba7627820eaae330c1  $RUNNER_TEMP/proxy.tar.gz" | sha256sum --check --status
tar -xzf "$RUNNER_TEMP/proxy.tar.gz" -C "$RUNNER_TEMP"
sudo install -m 755 "$RUNNER_TEMP/codex-responses-api-proxy-x86_64-unknown-linux-musl" /usr/local/bin/codex-responses-api-proxy
sudo ln -sf "$(command -v node)" /usr/local/bin/node
sudo apt-get update -qq
sudo apt-get install -y bubblewrap
# 公式Actionと同じuser namespace条件。PRコマンドの権限を緩める設定ではない。
if sysctl kernel.unprivileged_userns_clone >/dev/null 2>&1; then
  sudo sysctl -w kernel.unprivileged_userns_clone=1
fi
if sysctl kernel.apparmor_restrict_unprivileged_userns >/dev/null 2>&1; then
  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
fi
sudo bash tools/ai-review/isolation/setup.sh \
  "$GITHUB_WORKSPACE/.official-codex-action/dist/main.js" \
  "$RUNNER_TEMP/isolation-compiled" github
