# 公式ActionとCLIの隔離受け入れ検査

[移行計画](../../../docs/superpowers/plans/2026-10-28-codex-review-migration.md)の第一段階です。本番レビュー用の起動ラッパーではありません。実資格情報・モデル通信・GitHubへの投稿を使いません。

## 検査範囲

固定版Action v1.13の`dist/main.js run-codex-exec`を改変せず実行し、`unprivileged-user`によるUID切替と環境非継承を観測します。Actionが起動する`codex`だけを検査用fixtureへ差し替え、その内側で公式CLI 0.164.0の`codex sandbox --permission-profile :read-only`を実行します。モデルによるコマンド選択に依存せず禁止操作を試すための構成です。

- 模擬OIDC・GitHub・OpenAI資格情報と`CODEX_HOME`が、空文字も含め専用ユーザーへ渡らないこと。
- 模擬資格情報ファイル、親プロセスの環境・メモリを読めず、sudoへ昇格できないこと。
- PR調査用ディレクトリの無害なTypeScript由来スクリプトを、子shellから実行できること。
- 調査対象、信頼する設定、`/tmp`、CLI用一時領域へ書き込めないこと。
- 稼働中のloopback listenerへ接続できないこと。検査前後に外側から接続できることも確認する。
- PR側の`danger-full-access`設定で、明示した読み取り専用プロファイルを上書きできないこと。

無制限環境で同じ検査が違反を検出することを先に確認します。終了コード0だけでは合格とせず、全項目の成功結果が必要です。単なるファイルの不存在、検査の欠落、タイムアウトは合格にしません。親procの不可視化は、次節の条件をすべて満たす場合だけ隔離の証拠にします。sandbox内の結果出力は`writeSync`を使います。ローカル検証では、Nodeの非同期ログがsocket由来の標準出力へ現れないケースを確認しました。終了コードだけで通過させない検査を追加しています。

### 親プロセスの不可視化とアクセス拒否

親の環境・メモリは、同じPID名前空間でのアクセス拒否と、公式sandboxによる不可視化の両方を検査します。

1. rootの検査器自身を親としてPIDとPID名前空間を固定し、自分の`environ`・`mem`を開けることを負の対照で確認する。
2. 公式Actionで専用UIDへ切り替えた直後は、親と同じPID名前空間であることと、両ファイルへのアクセス拒否を必須にする。
3. sandbox内でもアクセス拒否を検査する。`ENOENT`は、取得した有効なPID名前空間が親と異なる場合だけ不可視化と判定する。同じ名前空間・名前空間不明・その他のエラー・読み取り成功は不可視化として認めない。
4. 親自身が子の完了を待って全体の成否を決定する。親終了後のファイル欠落でWorkflowを成功にできない。

判定の補正は検証fixtureだけに置きます。公式CLIのPID名前空間を無効化したり、ホストの`/proc`をsandboxへ追加公開したりしません。名前空間IDとエラー種別だけを記録し、環境・メモリの内容は読み出しません。

設定ディレクトリと`config.toml`はroot所有で保護し、公式CLIがPATH aliasを作る`.codex/tmp`だけ専用UIDに所有させます。sandbox内ではこの一時領域も書込み不可です。sudoの`env_reset`を有効にし、`env_keep`・`env_check`は空にします。検証fixtureには引数検証等が含まれますが、これを本番の資格情報除去機構に転用しません。

## GitHub-hosted runnerでの実行

[手動Workflow](../../../.github/workflows/ai-review-isolation.yml)を使います。`workflow_dispatch`のみで、`contents: read`だけを持ちます。OIDC・投稿権限・Secrets入力はありません。現行AIレビューWorkflowの起動条件とWIF設定は変更しません。

検査用ユーザー作成・sudo設定・user namespace設定を変更するため、廃棄可能なGitHub-hosted runner専用です。開発用ホストや共有runnerでは`setup.sh`を実行しないでください。

2026年10月29日の[初回実行](https://github.com/teitei-tk/KorekaiteShine/actions/runs/40813167423)は、`parent-environ`・`parent-mem`の2項目で失敗しました。[診断実行](https://github.com/teitei-tk/KorekaiteShine/actions/runs/40813934123)では、Action境界が親と同じ名前空間で両方`EACCES`、sandbox内が別の名前空間で両方`ENOENT`になることを確認しました。親の読み取りに成功したのではなく、検査が公式sandboxの不可視化を考慮していなかったことが原因です。

固定した[公式CLIの実装](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/linux-sandbox/src/bwrap.rs)は`--unshare-pid`と`--proc /proc`を使用します。[procマウントのフォールバック](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/linux-sandbox/src/linux_run_main.rs)もあるため、アクセス拒否と不可視化を分けて確認します。

同日の[修正版の実行](https://github.com/teitei-tk/KorekaiteShine/actions/runs/40814310020)は成功しました。実行コードは`3c33c24b223b55f28d589dcb6759397b852e6d2c`です。負の対照、Action境界の5項目、sandbox内の11項目を通過し、親procは外側で`EACCES`、別名前空間の内側で`ENOENT`を確認しました。UID・環境・ファイル・書込み・sudo・通信の隔離条件と公式CLIの起動設定は維持しています。

## ローカルLinuxでの再現

2026年10月28日、macOS上のDocker Linux/aarch64で、Node 26.12.1・公式Actionの固定コミット・Codex 0.164.0を用いて成功しました。Dockerの既定seccompではuser namespaceを作れなかったため、資格情報・ホストソケットを持たない一時コンテナに限り`--security-opt seccomp=unconfined`を指定しました。これはGitHub-hosted runnerでの実証ではありません。

リポジトリの既存TypeScriptコンパイラで、検査コードを一時ディレクトリへ出力します。

```sh
pnpm --dir tools/ai-review exec tsc --ignoreConfig --types node \
  isolation-probe.ts isolation/action-probe.ts isolation/probe-child.ts isolation/run.ts \
  --module NodeNext --target ES2022 --skipLibCheck --outDir /tmp/ai-review-isolation-compiled
```

Node 26.12.1、sudo、bubblewrap、`/usr/local/bin/codex`、`/usr/local/bin/node`を持つ廃棄可能なLinux環境を用意します。Actionの固定コミットは`bdf19a4a223ec2549a3e2274a0cf61556bc07675`です。CLI配布物のSHA-256はaarch64版が`29a507a2a3fd8f6cd94b96b762d281d299d15d7902dee6132d314b78cf9108eb`、x86_64版がWorkflow記載の値です。検査コードと公式配布物だけを読み取り専用で持ち込みます。

環境内でrootとして、次を実行します。

```sh
bash /fixture/setup.sh /official-action/dist/main.js /compiled
```

`/fixture`はこのディレクトリ、`/compiled`はコンパイル出力です。通常の単体テストは`pnpm --dir tools/ai-review test isolation-probe.test.ts`です。無制限時にネットワーク到達を検出するテストがlocalhostへlistenするため、listenを禁止するエージェントsandboxでは外側で実行します。

## 次の段階へ進む条件

現状は初期fixtureをローカルLinuxとGitHub-hosted runnerで検証した段階です。対象は検査器の親プロセス、模擬資格情報、固定ディレクトリ、検査用listenerです。実runnerのその他のプロセス・ファイル・サービスソケット、MCP・フック等のPR設定全体、公式Action全体からの実`codex exec`、実プロキシのメモリ、既存WIF交換・更新、実モデル・実投稿は未検証です。このfixtureの成功を、それらの安全性や新レビュー方式の実装完了として扱いません。

設計の受け入れ順に従い、実runnerでの境界検証を完了してからWIF接続へ進みます。後段の履歴・投稿の置換は、その接続検証が成立してから実装します。
