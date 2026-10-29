# 公式Codex ActionとWIFの資格情報非継承

2026年10月27日調査。対象はCodex Action v1.13とCodexのWIF対応プロキシ0.164.0を同じGitHub Actionsジョブで使う場合である。公開ソースだけを確認し、実資格情報の取得、実API呼び出し、Workflow・実装・認証設定の変更は行っていない。

## 結論

調査後の判断: 利用者は公式`unprivileged-user`を使う構成を選択した。[設計案](../superpowers/specs/2026-10-27-existing-review-wif-design.md)へ反映済みである。以下の別UID方式は採用方針となったが、実runnerでの隔離が未検証である点は変わらない。

**`drop-sudo`と呼び出し側の`env`を空にする設定だけでは、OIDC要求用資格情報の非継承は成立しない。** GitHub runnerが各shellステップの起動直前にOIDC要求URL・トークンを設定し直し、Actionは実行時の環境をコピーする。公式WIFプロキシの要求する「Codex起動前の除去」を、この設定では満たせない。[runnerの注入処理][runner-script]、[Actionの実行処理][action-exec]、[プロキシの呼び出し側要件][proxy]

公式の`unprivileged-user`とOSのsudo設定を使えば、独自ラッパーを作らず、別UIDへの移行時に資格情報を渡さない構成を組める。これは公式ソースからの条件付き判断であり、対象runnerの環境変数・プロセス・ファイルの隔離は未検証である。`drop-sudo`を維持したままの成立とは区別する。

| 確認対象                                                | 判定           | 根拠・限界                                                         |
| ------------------------------------------------------- | -------------- | ------------------------------------------------------------------ |
| 公式プロキシによるOIDC交換・更新                        | 公式機能で可能 | 認証交換を自作する必要はない                                       |
| `uses`ステップのOIDC環境変数を空にして`drop-sudo`で起動 | 不成立         | 内部shellステップにrunnerが再注入する                              |
| `drop-sudo`によるsudo・Linux capability削減             | 公式機能で可能 | OIDC環境変数を除去する機能とは別                                   |
| Action自身が設定する`GITHUB_TOKEN`のステップ限定        | 確認済み       | write-access確認ステップだけ。呼び出し側の広い設定は別途除去が必要 |
| `unprivileged-user`による別UID実行                      | 公式機能で可能 | ユーザー作成・アクセス権の設定は呼び出し側の責任                   |
| 別UID方式での資格情報・親プロセスを含む隔離             | 未確定         | sudo設定・実runnerのプロセスアクセス・ファイル権限を未検証         |

根拠: [Actionの入力と各ステップ][action]、[Actionの実行処理][action-exec]、[公式の非特権ユーザー例][example]、[プロキシ][proxy]。

## 環境変数が入る経路

GitHub runnerの`CompositeActionHandler`は、呼び出し側の環境と内部ステップの環境を構成する。その後`ScriptHandler`は、ジョブの接続情報に`GenerateIdTokenUrl`があれば、shellを起動する直前に`ACTIONS_ID_TOKEN_REQUEST_URL`と`ACTIONS_ID_TOKEN_REQUEST_TOKEN`を`Environment`へ代入する。既に空文字が入っているかを判定する処理はない。[composite環境の構成][runner-composite]、[shell起動直前の注入][runner-script]

したがって、Actionを呼ぶ`uses`ステップの`env`に両変数を空文字で指定しても、Action内部の`Run codex exec`というshellステップに入る時点で値が復活する。前の準備ステップで`unset`しても、その後の別ステップを生成するrunner自体の接続情報は変わらない。これは公開ソースからの判定であり、GitHub上で実トークンを使って再現した結果ではない。

Actionの`Run codex exec`は`NODE_OPTIONS`を調整してNodeを起動するが、OIDCの2変数は除去しない。`runCodexExec`は`const env = { ...process.env }`で環境を複製し、そのまま子プロセスの`spawn`へ渡す。Linuxの`drop-sudo`経路は`sudo -n -E`を用い、最後の`env -u`も`SUDO_*`だけが対象である。環境内のOIDC資格情報を必ず除去するAction入力は、確認したv1.13にはない。[Actionのshellステップ][action]、[環境と権限の実装][action-exec]

Codexのシェル環境設定で子コマンドだけからトークンを除去しても、Codex本体に渡った資格情報の非継承にはならない。必要なのは、Codex本体を起動する境界での除去である。この判断はプロキシの呼び出し側要件と上記のプロセス構造からの推論である。[プロキシの要件][proxy]

## GitHub APIトークンと保存先

Actionの`GITHUB_TOKEN: ${{ github.token }}`は`Check repository write access`ステップだけに明示され、`Run codex exec`には同じ設定がない。Action自身のこの代入が全ステップの環境設定になるわけではない。[Action][action]、[runnerの内部ステップ環境][runner-composite]

ただし、利用者のWorkflowがジョブ全体やAction呼び出し全体へ`GITHUB_TOKEN`・`GH_TOKEN`を設定した場合は別である。`runCodexExec`は環境を全コピーするため、公式Actionが自動でそれらを消すとは扱えない。checkoutの保存資格情報も別経路なので、環境変数だけを確認して非継承完了とはしない。公式READMEの例は`persist-credentials: false`を指定している。[実行処理][action-exec]、[公式README][action-readme]

公式プロキシはGitHub要求トークンを標準入力の実パイプで受け取り、交換後のトークンをローカルHTTP APIへ返さない。Bearerを引数、Codex設定、server-info、GitHubの出力・環境ファイルに置かないことを要求する。プロキシのOIDCモードは一時バッファを消去するが、HTTP/JSON処理中の全トークンが単一のロック済みメモリ領域にとどまる保証はしない。[プロキシREADME][proxy]

## 権限削減と親プロセス

`drop-sudo`はLinuxで同じrunner UIDのまま、主グループを非特権グループへ変更し、補助グループ・capabilityを落とし、`no_new_privs`を設定する。root所有のサービスソケットへの書込みも制限する。これは有効な権限削減だが、既に子環境へ入ったトークンの除去にはならず、runnerと別UIDにする機能でもない。[入力の説明][action]、[実行処理][action-exec]、[sudo削減の実装][drop-sudo]

プロキシは特権側で保護して起動する前提である。非特権Codexからプロキシのメモリを保護することと、runnerやActionの親プロセスが保持する資格情報を保護することは別の確認事項になる。公式プロキシも親runnerの環境は変更できないと明記している。[プロキシREADME][proxy]

今回、親プロセスのメモリ・`/proc`・ファイル記述子に実runnerで到達できるかは検証していない。同一UIDなら必ず読める、あるいは`drop-sudo`なら絶対読めない、のどちらも断定しない。読み取り専用サンドボックスだけを資格情報隔離の根拠にしないという公式Actionの注意を維持する。[安全方式の説明][action-readme]

## `unprivileged-user`の候補と残る確認

公式Actionは`sudo -u <codex-user> -- <codex> ...`で別ユーザーのCodexを起動する。この経路には`-E`がなく、Linuxの`drop-sudo`用`setpriv`処理も通らない。したがって両者は同じ保護の別名ではない。[実行処理][action-exec]

公式例は非特権アカウントの作成と、checkoutへのアクセス権設定を含む。ただし例の共有グループと再帰的な書込み権限を、資格情報隔離に必要な最小権限とみなしてそのまま採用することはできない。専用ユーザーのsudo権限・補助グループ・サービスソケット・runner側の認証ファイルへのアクセスを確認する必要がある。[公式例][example]

Actionは`codex-home`を省略した場合、非特権ユーザーの`HOME/.codex`を解決する機能を持つ。一方、明示した`codex-home`は実行側へ環境変数で渡すため、sudoでその変数を保持できるかという接続上の確認も残る。WIF用の設定とserver-infoを事前作成する場合は、ActionのAPIキー用設定生成を通らないため、作成側が所有者・アクセス権を成立させる必要がある。[home解決][action-main]、[実行処理][action-exec]、[ActionのAPIキー分岐][action]

公式sudoの`env_reset`は、対象ユーザー用の最小環境を作り、`env_keep`と`env_check`で許した変数を追加する。`env_delete`は主に`env_reset`が無効な場合の拒否リストなので、`env_reset`と`env_delete`を設定しただけで常に除去されるとは扱わない。許可リストのワイルドカード、PAM、環境ファイルからの追加も確認する必要がある。[sudo公式マニュアル][sudoers]

ソースから導ける最小構成の条件は次のとおりである。実装手順や検証済み設定として提示するものではない。

1. 専用の非特権ユーザーを作り、sudo・特権グループ・特権サービスソケットへのアクセスを与えない。
2. 公式Actionの`unprivileged-user`を使う。sudoの`env_reset`を有効にし、OIDCの2変数とGitHub APIトークンが`env_keep`・`env_check`で許可されず、PAM・環境ファイルでも復活しない設定にする。`env_delete`は補助であり、この許可リスト検査の代わりにしない。
3. 専用ユーザーの実`HOME/.codex`へ信頼する設定を事前配置し、任意の`CODEX_HOME`の環境継承を接続条件にしない。設定・server-infoは信頼する準備側が保護し、PRから変更できないようにする。
4. runner側の認証ファイルを共有せず、調査対象と必要な出力先だけにアクセスを与える。公式例の広い共有グループ設定をそのまま最小権限と扱わない。
5. プロキシは専用ユーザーからメモリを読めない特権側で起動し、OIDC要求トークンは公式の実パイプで渡す。

これらは公式Action、sudo設定、Workflowの準備処理で構成する候補であり、独自の認証プロキシ・実行ラッパー・サンドボックスは必要条件に含めない。ただし、設定量が運用上許容できるかと、実runnerで境界が成立するかは確認が必要である。[Action][action-exec]、[home解決][action-main]、[sudo][sudoers]、[プロキシ][proxy]

別UID方式で前進する場合も、最初に実資格情報を使わない固定runner上の確認が必要になる。ダミーのOIDC変数がCodex相当の子プロセスに存在しないこと、信頼する設定だけが読めること、親runnerとプロキシに対する読み取り・昇格経路が閉じていることを確認する。今回はその実験も実施していない。現時点の結論は「公式機能で構成する候補はあるが、実環境の隔離は未検証」である。

## 調査の固定点と設計への影響

- Codex Action v1.13: `bdf19a4a223ec2549a3e2274a0cf61556bc07675`。
- Codex 0.164.0: `6aaac694803004a63c6f393d153c96d22521a6b9`。
- GitHub Actions runner: `80ca6ea6c936dc9532d0d86625f862585e800f75`。調査時の公開mainを固定したもの。実際のGitHub-hosted runner配布版との一致は未確認。
- sudo公式マニュアル: `265e10a74b32b1cdd18860e634016b2fd65ff04c`。調査時の公開main。対象runnerのsudo配布版・設定との一致は未確認。

この結果は、[導入調査](codex-action-wif-feasibility.md)の「公式プロキシがWIFを扱える」という判断を否定しない。一方、[設計案](../superpowers/specs/2026-10-27-existing-review-wif-design.md)の`drop-sudo`と資格情報非継承を同時に満たす接続方法は未解決である。採用方式を実装可能と確定する前に、この不成立と別UID候補の未検証範囲を反映する必要がある。既存ADRの変更や独自サンドボックスの採用は行わない。

[runner-script]: https://github.com/actions/runner/blob/80ca6ea6c936dc9532d0d86625f862585e800f75/src/Runner.Worker/Handlers/ScriptHandler.cs#L314-L319
[runner-composite]: https://github.com/actions/runner/blob/80ca6ea6c936dc9532d0d86625f862585e800f75/src/Runner.Worker/Handlers/CompositeActionHandler.cs#L253-L299
[action]: https://github.com/openai/codex-action/blob/bdf19a4a223ec2549a3e2274a0cf61556bc07675/action.yml
[action-exec]: https://github.com/openai/codex-action/blob/bdf19a4a223ec2549a3e2274a0cf61556bc07675/src/runCodexExec.ts
[action-main]: https://github.com/openai/codex-action/blob/bdf19a4a223ec2549a3e2274a0cf61556bc07675/src/main.ts
[action-readme]: https://github.com/openai/codex-action/blob/bdf19a4a223ec2549a3e2274a0cf61556bc07675/README.md
[drop-sudo]: https://github.com/openai/codex-action/blob/bdf19a4a223ec2549a3e2274a0cf61556bc07675/src/dropSudo.ts
[example]: https://github.com/openai/codex-action/blob/bdf19a4a223ec2549a3e2274a0cf61556bc07675/examples/unprivileged-user.yml
[proxy]: https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/responses-api-proxy/README.md
[sudoers]: https://github.com/sudo-project/sudo/blob/265e10a74b32b1cdd18860e634016b2fd65ff04c/docs/sudoers.man.in
