# GitHub ActionsによるAIコードレビューの導入案

2026年10月24日確認。開発者本人が実装方針とOpenAI側の設定を確認するための設計案です。設計は承認済みで、Workflowと検査コードを実装しました。実アカウントのOIDC取得・WIF交換は成功しました。SDK版のモデル呼び出し・投稿はmain反映後に検証します。[初期設定・確認手順](../runbooks/ai-review.md)を参照してください。

## 目的と確認済みの前提

本人のPR更新ごとにGPT-6 Lunaでレビューし、実害のある問題だけをコメントします。自動マージや必須の品質判定には使いません。長期OpenAI APIキーを保存せず、API PlatformのサービスアカウントにWIFで認証します。

本人以外が作成したPRではAIレビューを実行しないことを必須要件とします。GitHubのコントリビューション制限は期限付きのため、その有効・失効に依存しません。同一リポジトリのブランチからのPRや、書き込み権限を持つ他の利用者のPRも除外します。この制限はAIレビューに適用し、通常CIの実行条件は変更しません。

対象は公開リポジトリ`teitei-tk/KorekaiteShine`、デフォルトブランチは`main`です。現在は設計文書と検査環境のみで、既存の`Documentation checks`が型・テスト・文書・Actionsロックを検査します。アプリの依存は未導入です。

[MVPの設計基準](../spec/mvp.md#設計基準)と[ADR 0001](../adr/0001-server-relayed-interviews.md)、[ADR 0004](../adr/0004-tanstack-start-with-void.md)に従います。音声はDO経由のサーバー中継です。ブラウザ直結用の短命トークンを現構成へ一律に要求しません。VoidをViteへ読み替えません。

## 実行基盤の選択

第一候補の`openai/codex-action` v1.13 / CLI 0.164.0は、[実行検証](https://github.com/teitei-tk/KorekaiteShine/actions/runs/40082397153)でWIF交換に成功したものの、内蔵プロキシの認証文字列1,024バイト制限で停止しました。モデル実行・投稿には到達していません。

代替案として公式[OpenAI Node SDK](https://github.com/openai/openai-node) 7.43.0からResponses APIを呼びます。既存のWIF交換で得た短命BearerをSDKの`apiKey`へ渡し、長期APIキーは保存しません。SDK組み込みの自動WIF更新は使わず、交換後240秒以上の残存時間を確認して一回のリクエストを行います。依存インストールと資料収集は交換前に完了させます。

[Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)を使い、既存Schemaを`text.format`へ指定します。モデルは`gpt-6-luna`、推論強度は`medium`、出力は推論を含む8,000トークン、リクエスト期限は150秒です。SDKの再試行を無効にし、`store: false`と空のツール一覧を明示します。入力は500KB、応答テキストは30KBを上限とし、未完了・拒否・不正JSONを成功扱いしません。使用量は数値だけをSummaryへ記録し、SDKログと外部エラー本文は出力しません。

SDKとロックファイルはmain側の信頼する版を使用します。PR側の依存をインストールせず、pnpmの供給網保護と`--ignore-scripts`を維持します。実アカウントのSDK呼び出しと投稿はmain反映後に検証します。PR-Agentは今回採用しません。

## レビューの流れと権限

既存CIが成功した後の`workflow_run`を起点にします。このイベントはデフォルトブランチのWorkflowを使います。PR内で変更されたWorkflow・設定・スクリプトを認証ジョブで実行しません。[GitHubのイベント仕様](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run)にある、未信頼コードやキャッシュからの権限侵害に注意した構成です。

1. 認証権限のない準備ジョブで、起点が対象CIのPR実行であることを確認します。GitHub APIから対象PRを再取得し、PR作成者のユーザーIDが本人の`1324680`（確認時のログイン名`teitei-tk`）、headが同一リポジトリ、baseが`main`、未クローズ・非Draftであることを検査します。forkとbotのPRも対象外です。作成者を確認できない場合は実行しません。
2. CIが検査したコミットと対象PRのheadを照合します。merge SHAとhead SHAを混同せず、対応を確定できない場合は中止します。古いCI完了から最新PRを誤ってレビューしません。
3. 生成ジョブだけに`id-token: write`を付与します。GitHubへの書き込み権限は付けません。main側の信頼する処理で、固定したbase/headの差分、関連コード、テスト、仕様、規約を資料として取得します。PR側の依存インストール、ビルド、テスト、フックは実行しません。
4. 信頼するプロンプト・Schemaを資料と分けます。資料内の命令はデータとして扱い、資料をプロンプトに添付します。APIへツールを提供せず、シェル実行・Web検索・複数エージェントの機能を持たせません。PRの`.codex`設定や`AGENTS.md`を自動的に実行設定へ取り込みません。
5. 生成結果をSchemaとコード位置で検証し、別ジョブでコメントを投稿します。投稿ジョブにはOIDC権限を付けず、PRコードも実行しません。投稿直前にもheadを照合し、古い結果を破棄します。

同じPRの古い実行はキャンセルし、同じheadの重複実行を抑制します。更新ごとに新しい集約コメントを投稿し、元の指摘と確認結果を保持します。モデル出力をシェルやGitHub API操作へ直接展開せず、メンションを無効化します。モデル失敗・対象外・資料不足を「問題なし」と表示しません。

2026年10月25日に[コメントと修正確認の要件](../spec/ai-review.md)を追加しました。過去の指摘を資料へ含め、各指摘の修正確認と根拠を出力させます。投稿前に指摘履歴も再照合し、元コメントへのリンクとともに確認結果を新規投稿します。既存形式の指摘も読み取り、履歴上限30件・形式不正・取得失敗では未完了として停止します。実PRでの動作はmain反映後に確認します。

本人判定はPRの作成者に対して行い、Workflowの実行者、再実行者、コミットの作者、`author_association`では代用しません。他人のPRを本人が再実行しても対象外です。準備ジョブで許可した場合だけ認証・生成ジョブへ進み、対象外ではOIDCトークン取得、OpenAI API呼び出し、レビューコメント投稿を行いません。

## 指摘の基準と費用管理

リポジトリ規約との整合、仕様・受け入れ条件との整合を別々に確認します。仕様がない場合は不明と明記し、通常CIの検出事項や好みの修正を繰り返しません。発生条件、影響、変更箇所、修正方針を裏付けられる指摘に絞り、未確認事項を確定した不具合と分離します。

レビュー重点は、認可・入力検証・CSRF・リクエスト間のデータ混在、失敗・キャンセル・二重実行・古い非同期結果、接続と購読の後片付け、公開API経由で再現する回帰テストです。面接ごとのDO、接続の引き継ぎ、終了後の再接続防止など、採用済み仕様に照らします。

Googleのレビュー観点と判断基準を主軸に、設計・動作・複雑さ・テスト・命名・コメント・文書を確認します。Matt Pocockからは規約と仕様の独立した確認、規約の根拠提示、設計上の兆候を不具合と即断しない扱いを補完しています。確認日と具体的な指示は[レビュー指示](../../tools/ai-review/prompt.md)に記載しています。変更全体を確認した上で重要な指摘を最大3件に絞り、軽微な改善案は投稿しません。複数エージェント・別レポート方式やTanStack内部のビルド規約はコピーしません。Voidの資料はインストール済みの版と一致するものを使います。現在は未導入のため、存在しない`node_modules/void/docs/`を読めたとは扱いません。

モデルは`gpt-6-luna`に固定し、初期の推論強度は`medium`を候補とします。[公式モデル仕様](https://developers.openai.com/api/docs/models/gpt-6-luna)でResponses APIと構造化出力の対応を確認済みです。対象プロジェクトからの利用可否は別途検証します。

最大指摘数は3件を初期案とします。入力分量・実行時間に上限を設け、超過時はレビュー未完了と報告します。自動再試行は初期には行いません。使用トークン、対象SHA、処理時間、成功・未完了を記録し、実料金と突き合わせます。タイムアウトや指摘数は料金の厳密な上限ではありません。月額予算と代表的なPRの規模は未確認です。

## OpenAI側の設定案

[公式のGitHub Actions向けWIF手順](https://developers.openai.com/api/docs/guides/workload-identity-federation/github-actions)に沿って、利用者が以下を設定します。Workflow名を実装時に変更する場合はマッピングも合わせます。

1. [API PlatformのWIF設定](https://platform.openai.com/settings/organization/security/workload-identity-provider)を開き、設定権限と利用可否を確認します。ChatGPT管理ワークスペース向けのCodex WIFとは別の経路です。
2. レビュー専用のプロジェクトまたは既存の適切なプロジェクトに、サービスアカウント`korekaite-ai-review`を作成します。モデル実行に必要な権限だけを付与します。
3. Provider名を`korekaite-github-actions`、Issuerを`https://token.actions.githubusercontent.com`、Audienceを`https://api.openai.com/v1`とします。GitHubのOIDC discoveryを使い、JWKSの手動アップロードは無効にします。
4. サービスアカウントへのマッピングに次の条件をすべて設定します。初回はAPIを呼ばず、許可したクレーム項目だけを表示して実値を照合します。値が違う場合は理由を調べ、安易にワイルドカードへ緩めません。

| Key                   | Value                                                                      |
| --------------------- | -------------------------------------------------------------------------- |
| `iss`                 | `https://token.actions.githubusercontent.com`                              |
| `aud`                 | `https://api.openai.com/v1`                                                |
| `repository`          | `teitei-tk/KorekaiteShine`                                                 |
| `repository_id`       | `1426899426`                                                               |
| `repository_owner_id` | `1324680`                                                                  |
| `ref`                 | `refs/heads/main`                                                          |
| `workflow_ref`        | `teitei-tk/KorekaiteShine/.github/workflows/ai-review.yml@refs/heads/main` |
| `event_name`          | `workflow_run`                                                             |

このrefはPRのheadではなく、信頼する後続Workflowのrefです。通常の`pull_request`で直接認証する構成へ変更した場合は使い回せません。`sub`も実値を確認します。環境やGitHubのsubject設定で形式が変わるため、未確認の値を固定しません。[GitHub OIDC仕様](https://docs.github.com/en/actions/reference/security/oidc)を参照してください。

マッピングのPermissionsは`api.model.request`を基本に、採用するクライアントが必要とする場合だけモデル参照権限を追加します。GitHubのRepository Variablesに次を保存します。Provider・サービスアカウントのIDは実際に作成された値を使います。

| Variable                      | 値                                 |
| ----------------------------- | ---------------------------------- |
| `OPENAI_WIF_AUDIENCE`         | `https://api.openai.com/v1`        |
| `OPENAI_IDENTITY_PROVIDER_ID` | 作成したProviderのID               |
| `OPENAI_SERVICE_ACCOUNT_ID`   | レビュー専用サービスアカウントのID |

トークンは取得直後にマスクし、ログ・成果物・ジョブ間出力に保存しません。生の認証エラー本文も出さず、HTTP状態と機密値を含まない分類を記録します。

## 導入の判定

実装後は、認証クレームの照合、小さなLuna呼び出し、実PRのレビューと投稿を順に確認します。既知バグ入りの変更と正常な変更で検出・誤検知・料金を比較します。fork、Draft、古いhead、失効、不正な出力、資料上限超過では、課金実行や誤った投稿を抑止できることを確認します。

作成者の制限は、本人のPRを許可し、他人の同一リポジトリPR・fork PR・bot PR・本人が再実行した他人のPR・作成者情報の取得失敗を拒否する検査で確認します。拒否時は認証・モデル呼び出し・投稿が一度も行われないことを検証します。コントリビューション制限の設定を判定条件に含めず、失効後も同じ拒否条件を維持します。

未確認なのは、対象アカウントのWIF設定権限、サービスアカウントの実効権限、Luna利用可否、Actionの短命トークン接続・期限、費用と精度です。これらを確認するまで運用開始済みとは扱いません。外部PRの受け入れ方針は未確認ですが、本案ではAIレビュー対象から除外できます。
