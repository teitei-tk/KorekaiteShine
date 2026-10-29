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
- 実runnerのWorker・Listenerプロセス、存在する認証ファイル候補、Docker・containerdソケットへ専用UIDからアクセスできず、補助グループ経由でも権限を持たないこと。
- 公式Actionから起動した実CLIが、PR側のMCP・TOML/JSONフック・接続先設定を採用しないこと。モデルへの要求はオフラインの受信器で拒否する。

無制限環境で同じ検査が違反を検出することを先に確認します。終了コード0だけでは合格とせず、全項目の成功結果が必要です。単なるファイルの不存在、検査の欠落、タイムアウトは合格にしません。親procの不可視化は、次節の条件をすべて満たす場合だけ隔離の証拠にします。sandbox内の結果出力は`writeSync`を使います。ローカル検証では、Nodeの非同期ログがsocket由来の標準出力へ現れないケースを確認しました。終了コードだけで通過させない検査を追加しています。

### 親プロセスの不可視化とアクセス拒否

親の環境・メモリは、同じPID名前空間でのアクセス拒否と、公式sandboxによる不可視化の両方を検査します。

1. rootの検査器自身を親としてPIDとPID名前空間を固定し、自分の`environ`・`mem`を開けることを負の対照で確認する。
2. 公式Actionで専用UIDへ切り替えた直後は、親と同じPID名前空間であることと、両ファイルへのアクセス拒否を必須にする。
3. sandbox内でもアクセス拒否を検査する。`ENOENT`は、取得した有効なPID名前空間が親と異なる場合だけ不可視化と判定する。同じ名前空間・名前空間不明・その他のエラー・読み取り成功は不可視化として認めない。
4. 親自身が子の完了を待って全体の成否を決定する。親終了後のファイル欠落でWorkflowを成功にできない。

判定の補正は検証fixtureだけに置きます。公式CLIのPID名前空間を無効化したり、ホストの`/proc`をsandboxへ追加公開したりしません。名前空間IDとエラー種別だけを記録し、環境・メモリの内容は読み出しません。

設定ディレクトリと`config.toml`はroot所有で保護します。公式CLIがPATH aliasを作る`.codex/tmp`と、起動時に読書き用に開く`installation_id`だけ専用UIDに所有させます。sandbox内では一時領域への書込みと、既存の設定・状態ファイルを書込み用に開く操作を拒否することも検査します。sudoの`env_reset`を有効にし、`env_keep`・`env_check`は空にします。検証fixtureには引数検証等が含まれますが、これを本番の資格情報除去機構に転用しません。

### 実runnerの検査対象

Worker・Listenerは`/proc`のプロセス名から特定し、同じPID名前空間と開始時刻を検査前後で照合します。認証ファイル候補はrunnerの実行ファイルから求めた配置先の`.credentials`・`.credentials_rsaparams`と、runner HOMEのGit・GitHub CLI・Codex・Dockerの既知の認証ファイルです。内容は読み出さず、専用UIDでのopenの成否だけを確認します。対象のパスや認証値をログへ出さず、対象件数と番号付き結果を記録します。

Unixソケットは接続だけを試し、要求を送りません。既知のDocker・containerdソケットに加え、rootだけが接続できる無害なlistenerを用意します。このlistenerはrootで接続できる負の対照も確認します。`ENOENT`・`ECONNREFUSED`・タイムアウトをUnixソケットのアクセス拒否として扱いません。存在しない認証ファイルやソケットは検証済みとは数えません。将来追加されるサービスや別構成のrunnerまで網羅した保証ではありません。

### PR起動設定のオフライン検査

公式の`projects.<調査ディレクトリ>.trust_level = "untrusted"`をroot所有の設定に置きます。[固定版の設定ローダー](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/config/src/loader/mod.rs)がプロジェクト層を無効化する境界を使い、独自の設定除去ラッパーは作りません。

`startup.ts`は外部インターフェイスのないnetwork namespace内だけで実行します。モデルもWIFも使わず、ローカルHTTP受信器がすべての要求へ400を返します。実`codex exec`がその受信器まで到達したことを必須にし、起動前に失敗しただけのケースを合格にしません。終了コードの非ゼロは、モデル要求を拒否するこの検査でだけ期待する動作です。

PR側にはMCP、TOMLのSessionStartフック、`.codex/hooks.json`のSessionStartフックを置き、それぞれ無害なマーカーを作らせます。資格情報なしの負の対照ではPRをtrustedとしてCLIを直接起動し、フックの信頼検査もその対照に限り迂回して、3つとも起動することを確認します。通常検証は公式Actionの`unprivileged-user`から実CLIを起動し、untrusted設定で3つとも起動しないことと、接続先が準備側のローカル受信器から変わらないことを確認します。公式Actionは保護モードでフックの信頼検査を迂回する引数を拒否するため、その制限も維持します。

この検査が扱うのはCLIの起動段階です。モデル応答・モデルによるツール選択・実プロキシ接続の成功は検証しません。調査コマンドの書込み・通信制限は、先行する実CLI sandbox検査で別に確認します。

### 公式Action全体と実プロキシの配置

`lifecycle.ts`は、固定版の公式プロキシへ模擬文字列だけを標準入力のパイプで渡します。プロキシはrootとして最小環境で起動し、別のrootプロセスが返すローカルの固定応答へ接続します。独自プロキシ・認証処理・モデル推論は実装しません。`--github-oidc`は使用せず、模擬キーを使うAPI-keyモードの配置検証に限定します。

専用UIDから実プロキシの環境・メモリを開けず、設定・server-infoを書込み用に開けないことを、sandboxの外側と内側で確認します。server-infoはroot所有の専用HOME内で0444に固定し、内容はポートとPIDだけです。プロキシとローカル受信器のPID・開始時刻を記録し、終了処理で別プロセスへ取り違えないようにします。設定の内容・所有者・権限がAction実行後も維持されることも必須です。

検証Workflowは`openai/codex-action`本体を改変せず呼びます。`openai-api-key`入力を空にし、事前起動プロキシと保護済みの設定・server-infoを使う経路です。CLI・プロキシのnpm導入、HOME解決、server-info読込み、ユーザー切替、実CLI実行までを含みます。APIキー入力からAction自身がプロキシを起動する別経路は、採用予定のWIF構成では使わないため対象外です。

この段階の外部通信遮断は、専用UIDとrootに対するIPv4/IPv6のOUTPUT規則で行います。loopback以外を拒否し、runner UIDによる公式配布物の準備は維持します。PRコマンドの公式sandbox制限も維持します。GitHubの読み取り専用トークンは通常の取得・準備に限られ、プロキシ・ローカル受信器の環境へ渡しません。実OIDC要求資格情報やOpenAI資格情報は投入しません。

検証は`complete`と`reject`の2ケースです。前者は固定SSE応答で公式Actionが正常終了し、固定の最終メッセージを返すことを確認します。後者はローカル受信器が400を返し、要求到達後にActionが失敗した場合の後始末を確認します。CLIが400をどのエラー種別として処理したかまでは保証しません。どちらもプロキシからの要求と模擬Authorizationの一致が必須で、起動前の失敗は合格にしません。プロキシ準備から150秒以上かかった場合も不合格とし、Actionの3分timeoutを期待した失敗と混同しません。固定応答のusageは模擬値であり、実利用量や料金として扱いません。

固定版Actionはcompositeで、プロキシ終了用の独自post処理を持ちません。[公式プロキシの終了API](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/responses-api-proxy/README.md)に従い、呼出し側の`always()`ステップが`/shutdown`を呼び、実プロセスの停止とserver-infoの削除を確認します。HTTPエラーでActionが失敗した場合も同じ処理を行います。これは成功・失敗後の通常の後始末検査であり、runnerの強制停止やジョブ強制キャンセル後の実行保証ではありません。

Actionの入れ子の`setup-node`もActionsロックへ含めます。実行時にcheckoutしたローカルActionとして参照すると、ローカル検査からその依存を辿れずrunnerで停止したため、公式Actionを直接参照し、同じコミットをロックで固定しています。公式Actionのソースは変更していません。

## GitHub-hosted runnerでの実行

[手動Workflow](../../../.github/workflows/ai-review-isolation.yml)を使います。`workflow_dispatch`のみで、`contents: read`だけを持ちます。OIDC・投稿権限・Secrets入力はありません。現行AIレビューWorkflowの起動条件とWIF設定は変更しません。

検査用ユーザー作成・sudo設定・user namespace設定を変更するため、廃棄可能なGitHub-hosted runner専用です。開発用ホストや共有runnerでは`setup.sh`を実行しないでください。

2026年10月29日の[初回実行](https://github.com/teitei-tk/KorekaiteShine/actions/runs/40813167423)は、`parent-environ`・`parent-mem`の2項目で失敗しました。[診断実行](https://github.com/teitei-tk/KorekaiteShine/actions/runs/40813934123)では、Action境界が親と同じ名前空間で両方`EACCES`、sandbox内が別の名前空間で両方`ENOENT`になることを確認しました。親の読み取りに成功したのではなく、検査が公式sandboxの不可視化を考慮していなかったことが原因です。

固定した[公式CLIの実装](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/linux-sandbox/src/bwrap.rs)は`--unshare-pid`と`--proc /proc`を使用します。[procマウントのフォールバック](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/linux-sandbox/src/linux_run_main.rs)もあるため、アクセス拒否と不可視化を分けて確認します。

同日の[修正版の実行](https://github.com/teitei-tk/KorekaiteShine/actions/runs/40814310020)は成功しました。実行コードは`3c33c24b223b55f28d589dcb6759397b852e6d2c`です。負の対照、Action境界の5項目、sandbox内の11項目を通過し、親procは外側で`EACCES`、別名前空間の内側で`ENOENT`を確認しました。UID・環境・ファイル・書込み・sudo・通信の隔離条件と公式CLIの起動設定は維持しています。

[追加の事前検証](https://github.com/teitei-tk/KorekaiteShine/actions/runs/40819244385)も同日に成功しました。実行コードは`7e03c7ac2e3e4a9bc180a67470d6216a8b51de53`です。実runnerプロセス2件、認証ファイル候補2件、実サービスソケット2件を検出し、模擬対象を含むアクセス拒否・書込み拒否を確認しました。オフライン起動では負の対照の3マーカーを検出し、公式Action経由のuntrusted起動では3つとも作られず、準備側のローカル受信器への到達を確認しました。実資格情報の投入・WIF交換・モデルAPI・投稿は行っていません。

PR #42のマージ後、[mainでの再実行](https://github.com/teitei-tk/KorekaiteShine/actions/runs/40820000247)も成功しました。対象は`166533bca098e330a5611287cd3a007b59861d05`です。

[公式Action全体と実プロキシの検証](https://github.com/teitei-tk/KorekaiteShine/actions/runs/40822090945)は、`051d0b61680add79a817d3c937b84c4ac1b065fd`で2ケースとも成功しました。`complete`では固定メッセージで正常終了し、`reject`ではActionの失敗を観測したうえで検証全体が成功しています。どちらも実プロキシのメモリ・配置の隔離、設定の不変、公式終了APIによる停止を確認しました。`reject`のログにあるActionの終了コード1は、この負のケースの観測結果であり、検証ジョブ全体は成功です。実WIF・有料モデル・投稿は使用していません。

## ローカルLinuxでの再現

2026年10月28日、macOS上のDocker Linux/aarch64で、Node 26.12.1・公式Actionの固定コミット・Codex 0.164.0を用いて成功しました。Dockerの既定seccompではuser namespaceを作れなかったため、資格情報・ホストソケットを持たない一時コンテナに限り`--security-opt seccomp=unconfined`を指定しました。これはGitHub-hosted runnerでの実証ではありません。

リポジトリの既存TypeScriptコンパイラで、検査コードを一時ディレクトリへ出力します。

```sh
pnpm --dir tools/ai-review exec tsc --ignoreConfig --types node \
  isolation-probe.ts isolation/action-probe.ts isolation/probe-child.ts isolation/run.ts isolation/startup.ts isolation/lifecycle.ts \
  --module NodeNext --target ES2022 --skipLibCheck --outDir /tmp/ai-review-isolation-compiled
```

Node 26.12.1、sudo、bubblewrap、`/usr/local/bin/codex`、`/usr/local/bin/node`を持つ廃棄可能なLinux環境を用意します。Actionの固定コミットは`bdf19a4a223ec2549a3e2274a0cf61556bc07675`です。CLI配布物のSHA-256はaarch64版が`29a507a2a3fd8f6cd94b96b762d281d299d15d7902dee6132d314b78cf9108eb`、x86_64版がWorkflow記載の値です。検査コードと公式配布物だけを読み取り専用で持ち込みます。

環境内でrootとして、次を実行します。

```sh
bash /fixture/setup.sh /official-action/dist/main.js /compiled
```

`/fixture`はこのディレクトリ、`/compiled`はコンパイル出力です。通常の単体テストは`pnpm --dir tools/ai-review test isolation-probe.test.ts`です。無制限時にネットワーク到達を検出するテストがlocalhostへlistenするため、listenを禁止するエージェントsandboxでは外側で実行します。

## 次の段階へ進む条件

対象は検査器の親プロセス、模擬資格情報、固定ディレクトリ、実runnerの上記対象、PR設定、公式ActionのAPI-key入力を空にする経路と実プロキシの配置・通常の後始末です。既存WIF交換・期限更新と更新失敗、実モデル・Schema出力・実利用量、実投稿は未検証です。このfixtureの成功を、それらの安全性や新レビュー方式の実装完了として扱いません。

設計の受け入れ順に従い、実runnerでの境界検証を完了してからWIF接続へ進みます。後段の履歴・投稿の置換は、その接続検証が成立してから実装します。
