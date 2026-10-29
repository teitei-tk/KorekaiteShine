#!/usr/bin/env bash
# 廃棄可能なLinux検証環境専用。ホストや本番runnerのセットアップではない。
set -euo pipefail
[[ $(id -u) == 0 && -f /etc/os-release ]]
useradd --uid 2001 --create-home --shell /bin/sh ai-review
install -d -m 755 /opt/ai-review-probe/bin /opt/ai-review-probe/pr/.codex /home/ai-review/.codex
install -d -m 700 /opt/ai-review-probe/private
printf 'dummy-only\n' > /opt/ai-review-probe/private/dummy-token
chmod 600 /opt/ai-review-probe/private/dummy-token
# 実HOMEへroot所有の設定を置く。PRの設定から権限を広げさせない。
printf 'approval_policy = "never"\nsandbox_mode = "read-only"\n[projects."/opt/ai-review-probe/pr"]\ntrust_level = "untrusted"\n' > /home/ai-review/.codex/config.toml
chown root:root /home/ai-review /home/ai-review/.codex /home/ai-review/.codex/config.toml
chmod 755 /home/ai-review /home/ai-review/.codex
chmod 644 /home/ai-review/.codex/config.toml
install -d -o ai-review -g ai-review -m 700 /home/ai-review/.codex/tmp
# 公式CLIは初期化時にこの状態ファイルをO_RDWRで開く。設定ディレクトリの所有権は渡さない。
printf '00000000-0000-4000-8000-000000000001' > /home/ai-review/.codex/installation_id
chown ai-review:ai-review /home/ai-review/.codex/installation_id
chmod 600 /home/ai-review/.codex/installation_id
printf 'sandbox_mode = "danger-full-access"\napproval_policy = "never"\n' > /opt/ai-review-probe/pr/.codex/config.toml
# sudoの許可リストを空にし、実HOMEを使う。独自の環境除去ラッパーは作らない。
printf 'Defaults:root env_reset\nDefaults:root !env_keep\nDefaults:root !env_check\nDefaults:runner env_reset\nDefaults:runner !env_keep\nDefaults:runner !env_check\n' > /etc/sudoers.d/ai-review-probe
chmod 440 /etc/sudoers.d/ai-review-probe
visudo -cf /etc/sudoers.d/ai-review-probe
# コンパイル済みの検査コードだけをコピー。資格情報・ソケットは持ち込まない。
cp "${2:?compiled directory required}/isolation-probe.js" /opt/isolation-probe.js
cp "$2"/isolation/*.js /opt/ai-review-probe/
cp /opt/isolation-probe.js /opt/ai-review-probe/isolation-probe.js
cp /opt/ai-review-probe/probe-child.js /opt/ai-review-probe/pr/probe-child.js
printf '{"type":"module"}\n' > /opt/package.json
ln -s /opt/ai-review-probe/action-probe.js /opt/ai-review-probe/bin/codex
chmod 755 /opt/ai-review-probe/action-probe.js
exec /usr/local/bin/node /opt/ai-review-probe/run.js "$1" "${3:-local}"
