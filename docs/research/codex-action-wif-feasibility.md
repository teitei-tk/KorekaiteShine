# ユーザーの既存実装を使う方式のAIレビューで現行WIFを維持できるか

2026年10月27日確認。対象は、ユーザーの既存実装のレビュー実装をKorekaiteShineへ取り入れる場合の認証方式である。調査文書だけを更新し、Workflow・認証設定・実装は変更していない。実アカウントへの認証要求やモデル呼び出しも行っていない。

## 結論

追加調査により、下記の接続可能性だけでは安全な導入を確定できないことが分かった。[資格情報非継承](codex-wif-credential-isolation.md)には公式の別UID方式を採用する方針となった。[探索とPRコード非実行の両立](codex-pr-execution-restrictions.md)は確認できなかったが、利用者は隔離した読み取り専用環境内の実行を許容し、厳密な非実行を要件から外した。隔離・接続の実検証は残る。以下はプロキシとActionの接続経路の調査結果として読む。

**公式のWIF対応プロキシを利用すれば、現行WIFを維持する構成は実装可能と判断する。ただし、実環境での動作は未検証である。** ユーザーの既存実装のAPIキー入力をWIFトークンへ差し替えるだけでは成立しない。プロキシをWIF専用モードで起動し、Codex Actionを接続する準備処理が必要になる。

公開済みのCodex `0.164.0`には、GitHub OIDCからOpenAI API Platformのサービスアカウント用トークンを取得・更新する機能がある。独自の認証プロキシやレビューエンジンを新作する必要はない。Action本体の改変を避けて接続する経路もソース上は確認できたが、公式ActionのWIF設定例として保証された組み合わせではない。[公開版のプロキシ説明][proxy-readme]、[Actionの入力・処理][action]

## 以前の失敗と今回確認した機能

| 経路                                        | 確認結果                                                                                                    |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| WIFトークンをActionの`openai-api-key`へ渡す | APIキー用の読み取り処理を通る。1,024バイトのバッファと厳しい文字制限が残っており、以前の問題を解消しない    |
| 公式プロキシの`--github-oidc`を使う         | GitHub OIDC取得、OpenAIへの交換、期限前更新をプロキシが担当する。Bearerは最大16KiBでJWTのピリオドも許可する |
| Actionの入力だけでWIFを設定する             | 確認したv1.12・v1.13およびmainには専用入力がない。別途起動処理が必要になる                                  |

根拠: [APIキー読み取り][key-reader]、[WIF認証][proxy-auth]、[GitHub OIDC取得][proxy-oidc]、[Action][action]。

[以前の運用記録](ai-code-review.md)はAction v1.13 / CLI 0.164.0でAPIキー経路に渡して失敗した記録である。同じCLI版にWIF専用経路が存在するため、前回の「ActionからSDKへ変更した」という判断だけを、CodexとWIFが両立しない根拠にはできない。今回の確認は、入力経路の違いを明らかにしたものであり、過去の実行を再現した結果ではない。

プロキシは`https://auth.openai.com/oauth/token`へ現行と同じ交換形式を送る。これはChatGPT管理のCodexアカウント認証とは別で、現在使っているAPI PlatformのWIF方式に対応する。[現行の交換処理](../../tools/ai-review/wif.ts)、[公開版の交換処理][proxy-auth]、[OpenAIのWIF公式資料][wif-doc]

## 流用できる構成と必要な接続処理

候補となる流れは次のとおり。実装済みの手順ではなく、ソースから確認した接続可能性である。

1. 現在のCI成功後の`workflow_run`、本人PR判定、main由来の信頼する実行コードを維持する。
2. 公式プロキシをWIFモードで起動する。Audience・Provider ID・Service Account IDと、GitHub runnerが提供するOIDC要求URLを指定する。標準入力には交換済みトークンではなく、GitHubのOIDC要求用資格情報をパイプで渡す。
3. プロキシのポートを記した設定と、Actionが読む実行ID別のserver-infoを用意する。Actionの`openai-api-key`は空にし、信頼する`codex-home`を指定する。
4. Actionは既存プロキシ経由でCodexを実行する。ユーザーの既存実装のプロンプト・出力Schema・検証・投稿処理を流用する。
5. 投稿ジョブにはOIDC権限を与えず、生成ジョブと分離する。

ActionはAPIキーが空ならプロキシ起動と設定生成をスキップする一方、プロンプトがあればserver-infoを読み、Codexを実行する。指定した`codex-home`も受け付ける。この分岐が、事前に起動した公式WIFプロキシを利用できると判断した根拠である。プロバイダー設定はコマンド引数で上書きせず、信頼する設定ファイルで用意する。[Actionの分岐][action]、[Codex homeの解決][action-main]、[実行処理][action-exec]

APIキーを空にする場合、通常の起動時にActionが行うserver-infoの所有者・権限設定もスキップされる。準備側でその保護を担う必要がある。プロキシとCodexの権限分離、`drop-sudo`と読み取り専用プロファイルは維持する。[Action][action]

## 現行WIFを維持するための条件

**ユーザーの既存実装のWorkflow全体をコピーせず、KorekaiteShineの認証境界を残すことが前提になる。** 現行はリポジトリ名・ID・所有者ID・main・Workflowパス・`workflow_run`を事前照合する。ユーザーの既存実装は`pull_request`起点で、PR headのGoコードを生成ジョブで実行する。このままOIDC権限を足すと、クレーム条件も、資格情報を扱うコードの信頼境界も変わる。[現行WIF](../../tools/ai-review/wif.ts)、[現行Workflow](../../.github/workflows/ai-review.yml)、ユーザーの既存実装 Workflow（参照元内の`.github/workflows/codex-review.yml`）

移植先で現在のWorkflowパス・イベント・refを維持すれば、既存マッピングを使い続ける余地がある。ただし、今回OpenAI側の実設定は取得しておらず、再利用できると確定したわけではない。公式プロキシは現行のリポジトリ固有クレーム照合を代行しないため、事前検査とOpenAI側の限定マッピングを維持する必要がある。[WIF公式資料][wif-doc]、[プロキシ実装][proxy-oidc]

資格情報はプロキシ内に保持する。CodexやPR由来のコードを起動する前に、OIDC要求用トークンと要求URLを子プロセスの環境から除去する。プロキシは親のrunner環境を変更しない。Actionに`id-token: write`を付けただけでは、この分離が自動的に成立するとはいえない。Bearerを引数・設定・`GITHUB_OUTPUT`・`GITHUB_ENV`へ残さないことも公式の呼び出し側要件である。[公式プロキシの呼び出し側要件][proxy-readme]

期限更新は公式プロキシに任せられる。現行は各生成処理前に交換し、残存240秒以上を検査する。プロキシは期限前に新しいGitHub JWTを取得して再交換し、更新失敗時は期限切れトークンを使わず502で停止する。401の場合も同じResponses POSTを自動再送せず、その資格情報を破棄する。ただしCodex側の再試行まで含めた動作は未検証である。[現行の実行制御](../../tools/ai-review/orchestrate.ts)、[現行の期限検査](../../tools/ai-review/policy.ts)、[プロキシの期限制御][proxy-auth]

## 根拠の版と未検証事項

- KorekaiteShine: `2599e5c8e41c77ec16116462b91d0aeea3e2ee9c`。
- ユーザーの既存実装: `ac9a1b999e47d4ebbd7bee0cb6f9c1d90112d512`。Actionはv1.12相当の`86365089eb2b84e0a8fb0717b304f8bdcb13b20e`へ固定。
- Codex公開版: `rust-v0.164.0`、コミット`6aaac694803004a63c6f393d153c96d22521a6b9`。GitHub Releasesでは2026年10月23日公開。今回のWIF機能はこのタグのソースで確認した。[リリース](https://github.com/openai/codex/releases/tag/rust-v0.164.0)
- Action公開タグ: v1.13、`bdf19a4a223ec2549a3e2274a0cf61556bc07675`。mainの`c05cfd74ad95c626cdf05c6685e62becc3bf7813`も確認したが、接続判断の根拠は公開タグに固定した。

今後、実装を許可された段階で必要な確認は、固定版の配布バイナリでのWIF起動、既存マッピングでの交換、Actionへの接続、長時間実行時の更新、子プロセスへの資格情報非継承、実PRの投稿までの動作である。今回は公開ソース・公式資料の確認にとどめ、バイナリの実行や実API検証は行っていない。

この調査は認証の実現可能性を扱う。大規模レビューの完走・品質・実行ごとの$1上限は、WIF対応によって保証されない。[ADR 0005](../adr/0005-partitioned-ai-review.md)や既存要件の変更・採用決定も行っていない。

[proxy-readme]: https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/responses-api-proxy/README.md#github-actions-oidc-openai-api
[proxy-auth]: https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/responses-api-proxy/src/auth.rs
[proxy-oidc]: https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/responses-api-proxy/src/github_oidc.rs
[key-reader]: https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/responses-api-proxy/src/read_api_key.rs
[action]: https://github.com/openai/codex-action/blob/bdf19a4a223ec2549a3e2274a0cf61556bc07675/action.yml
[action-main]: https://github.com/openai/codex-action/blob/bdf19a4a223ec2549a3e2274a0cf61556bc07675/src/main.ts
[action-exec]: https://github.com/openai/codex-action/blob/bdf19a4a223ec2549a3e2274a0cf61556bc07675/src/runCodexExec.ts
[wif-doc]: https://developers.openai.com/api/docs/guides/workload-identity-federation/github-actions
