# AIレビューの初期設定と確認

この手順は`teitei-tk/KorekaiteShine`の管理者本人向けです。2026年10月24日時点でWorkflowとローカル検査を実装しています。実アカウントでOIDCクレームの照合とWIF交換は成功しています。SDK版のLuna呼び出し、コメント投稿、精度・料金は未検証です。新規導入時はまず診断だけを実行し、その後に課金レビューを有効化します。

## 1. Workflowをmainへ反映する

[AIレビューWorkflow](../../.github/workflows/ai-review.yml)と[検査コード](../../tools/ai-review/package.json)を通常のPRでレビューしてmainへ反映します。`workflow_run`はデフォルトブランチのWorkflowを使うため、実装PRのブランチに置いただけでは起動しません。

通常の`Documentation checks`を成功させてください。AIレビューは必須チェックや自動マージ条件に設定しません。この手順自体はpush・マージが実施済みであることを意味しません。

## 2. GitHubでOIDCクレームだけ確認する

[Repository Variables](https://github.com/teitei-tk/KorekaiteShine/settings/variables/actions)を開き、次を登録します。Secretsではありません。

| Name                  | Value                       |
| --------------------- | --------------------------- |
| `OPENAI_WIF_AUDIENCE` | `https://api.openai.com/v1` |
| `AI_REVIEW_MODE`      | `claims`                    |

本人が同一リポジトリのブランチからmain向けの非Draft PRを作成または更新し、通常CIの完了を待ちます。Actionsの`AI review`を開き、Summaryの「OIDCクレーム（秘密値なし）」を確認します。このモードはGitHub OIDCの確認だけで、OpenAIへのトークン交換・モデル呼び出し・コメント投稿は行いません。

診断では`gate`と`generate`の成功に加え、`Diagnose claims or exchange a short-lived token`ステップが実行されたことを確認します。`publish`とモデル呼び出しのスキップは正常です。Workflow全体が成功していても、対象外判定で診断までスキップされた場合はOIDC確認済みとは扱いません。

次の条件と一致することを確認してください。`sub`も表示されますが、環境・GitHubのsubject設定によって異なるため、推測した値で設定しません。生トークンをコピーしたり、外部のJWT解析サイトへ貼り付けたりする必要はありません。

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

refがmainなのは、PRコードではなくmainにある後続Workflowで認証するためです。条件が合わない場合は実装と実値を確認し、ワイルドカードに変更して通さないでください。

## 3. OpenAIのProjectとサービスアカウントを用意する

[OpenAI Platform](https://platform.openai.com/)で対象Organizationを選びます。GitHubのアカウントとOpenAIのアカウントは別です。

1. 可能ならレビュー専用のProjectを作り、名前を`KorekaiteShine AI Review`にします。既存の適切なProjectを使っても構いません。
2. Projectのサービスアカウント管理から、`korekaite-ai-review`を作成します。後述のWIFマッピング画面から作成できる場合は、そこで作成しても構いません。
3. このProjectでモデル`gpt-6-luna`が利用可能か確認します。モデルの利用制限、請求設定、残高・利用枠も確認します。チャットの契約だけでAPIの利用枠があるとは判断しません。
4. サービスアカウントにはレビューに必要なモデル実行権限だけを付与します。管理APIやアプリ本番の権限は付けません。

サービスアカウント作成時にAPIキーが表示されても、このWorkflowには登録しません。WIFが利用できない場合も、長期キー方式に切り替えず設定可否を確認します。

## 4. OpenAIでIdentity Providerを作成する

[Organization Settings → Security → Workload Identity Provider](https://platform.openai.com/settings/organization/security/workload-identity-provider)を開きます。設定が表示されない、または作成権限がない場合は、そのOrganizationでWIFを管理できるか確認してください。ChatGPT管理ワークスペースのCodex federationとは別のAPI Platformの設定です。

新しいProviderに次を入力します。

| 項目                                     | 設定値                                        |
| ---------------------------------------- | --------------------------------------------- |
| Name                                     | `korekaite-github-actions`                    |
| Description                              | `KorekaiteShineの本人PRレビュー専用`          |
| OIDC Issuer URL                          | `https://token.actions.githubusercontent.com` |
| Audience                                 | `https://api.openai.com/v1`                   |
| Use uploaded JWKS for token verification | 無効                                          |
| Custom OIDC discovery                    | 無効。GitHubの標準discoveryを使用             |
| Attribute transformations                | 追加不要                                      |

保存後、ProviderのIDを控えます。これは秘密値ではありません。

## 5. サービスアカウントへのマッピングを設定する

作成したProviderの詳細からサービスアカウントマッピングを作成します。

1. Nameを`korekaite-ai-review-main`にします。
2. Projectに手順3のProject、Service accountに`korekaite-ai-review`を指定します。
3. 手順2の表のすべての条件を、そのままKey/Valueの条件として追加します。すべて一致した時だけ許可する設定です。数値IDは表の数字を文字列の値として入力します。
4. Permissionsは`api.model.request`を指定します。クライアントがモデル一覧・情報の参照を要求して権限不足になる場合だけ、`api.model.read`の必要性を確認して追加します。
5. マッピングを有効にして保存し、対象サービスアカウントのIDを控えます。

`repository_owner`だけの広い信頼条件や、すべてのPRのrefを許可するワイルドカードは使いません。他人のPRかどうかはWorkflowがPR作成者IDで検査し、上記条件は信頼するWorkflowを限定します。両方が必要です。

## 6. GitHubのVariablesへIDを登録して有効化する

[Repository Variables](https://github.com/teitei-tk/KorekaiteShine/settings/variables/actions)に追加します。

| Name                          | Value                                 |
| ----------------------------- | ------------------------------------- |
| `OPENAI_IDENTITY_PROVIDER_ID` | 手順4で作成したProviderのID           |
| `OPENAI_SERVICE_ACCOUNT_ID`   | 手順5で選択したサービスアカウントのID |

設定を確認後、`AI_REVIEW_MODE`を`claims`から`review`へ変更します。これ以降、対象PRの通常CI成功後に有料のモデル呼び出しが実行されます。モデルは`gpt-6-luna`、推論強度は`medium`です。

小さなPRを更新するか、そのPRの`Documentation checks`を再実行します。`AI review`で以下を順に確認してください。

- `gate`が本人のPRを許可する。
- `generate`でWIF交換が成功する。期限が240秒未満ならモデルを呼ばず失敗する。
- `Review using GPT-6 Luna`は最大36分、生成ジョブ全体は40分です。生成処理は認証・計数・統合を含め30分、SDK要求は各150秒で、自動再試行はしません。各要求前にWIF交換し、モデル子プロセスへOIDC・GitHubの認証環境変数を渡しません。依存はWIF交換前にインストールします。
- 出力検証が成功し、`publish`が集約コメントを作成する。
- コメントの対象SHAがレビューしたコミットと一致する。

同じhead/baseの投稿がある場合は、通常CIを再実行してもモデルを呼びません。再評価が必要なら、対象PRを新しいコミットで更新してください。権限・認証エラーや期限超過では、自動再試行や別モデル・長期キーへの切り替えは行いません。

## 費用・精度・防御の確認

### 登録値を表示せず確認する

ルートで`pnpm check:ai-settings`を実行すると、上記4変数の有無と形式を確認します。取得値・未知の変数名・GitHub CLIのエラー本文は表示しません。未設定・形式不正・期待値不一致・取得失敗では終了コード1になります。ネットワークが制限されたサンドボックスでは、最初からサンドボックス外で実行します。通常CIやLefthookには組み込まず、管理者が必要なときだけ実行します。

IDは画面で確認した`idp_`、`user-`形式を検査します。形式OKだけでは正しいProvider・サービスアカウントであることを保証しません。厳密に照合する場合は、確認対象の変数名に`EXPECTED_`を付けた環境変数へ期待値を安全に注入して実行します。例として`EXPECTED_OPENAI_SERVICE_ACCOUNT_ID`を使用できます。1Password等の環境注入、または利用者自身の非表示入力を使い、値をコマンド引数・チャット・ログへ貼り付けないでください。期待値を指定しない項目は「期待値未指定」と表示します。比較対象はRepository Variablesのみで、Environment・Organization Variablesは確認しません。

このコマンドは読み取り専用です。設定の変更、OIDC取得、OpenAI通信、実アカウントでの認証成功の確認は行いません。

### ローカルの結合テスト

`pnpm test`は偽のOIDC・WIF応答とモック通信で、短命トークンのSDKへの受け渡し、レビュー成果物の保存・再読込、投稿前検証とコメント本文を一連で検査します。未完了応答、成果物のSHA不一致、投稿直前のhead変更も確認します。通信・課金は発生せず、実アカウントの権限やGitHub Actionsのジョブ間転送を実証するものではありません。

実行後の状態確認には[Actions確認コマンド](agent-workflow.md#actionsの状態確認)を使えます。

### 実動作の評価

最初の数件は、既知のバグを入れた小さな変更と正常な変更を用意し、指摘の妥当性、見逃し、誤検知、処理時間、使用量を記録します。OpenAIの対象ProjectのUsageとCostsで請求実績を確認します。成功したSDKリクエストの使用量はActionsのSummaryと照合してください。料金を独自の固定単価で推定して成功扱いする実装にはしていません。

関連単位、境界、過去指摘を別の作業として確認します。1回の原文300KB・JSON400KB・プロンプト500KB、全体は生成処理30分・API費用$1です。必須作業・候補整理には固定の呼び出し回数上限を設けません。合計バイト数ではなく、各要求のトークン計数・最大出力費用・実測usageで費用を制御します。全ファイルをモデルへ送らず、静的な参照関係と信頼済みの規約・仕様パスから資料を選びます。索引自体は5,000ファイル・本文20MBが上限です。容量はUTF-8バイト数、費用は1ナノドル単位の整数で検査します。

必須資料の欠落、参照未解決、容量超過、後半のモデル失敗では部分結果を投稿しません。Actions Summaryの完了作業数、対象ID（`gate`・`history`・`collect`・`preflight`・`task-N`・`reconcile-N`・`artifact`）、理由コードを確認します。上限を引き上げる前に、関連単位の大きさ、動的参照、分割できない単一宣言を調べてください。詳細は[分割設計](../spec/ai-review-partitioning.md)を参照してください。

収集・事前検証で止まった場合も、準備ステップが概要に対象ID・固定理由コード・完了0件を記録し、`allowed=false`と非ゼロ終了で後続を止めます。生成器に到達する前の失敗も記録対象です。

理由コードは、対象確認失敗が`TARGET_FAILED`、履歴取得・検証失敗が`HISTORY_FAILED`、資料取得失敗が`COLLECTION_FAILED`、参照未解決が`UNRESOLVED_REFERENCE`、入力不正が`INPUT_INVALID`、容量・回数超過が`BUDGET_EXCEEDED`、認証失敗が`AUTH_FAILED`、モデル実行失敗が`MODEL_FAILED`、出力・根拠不正が`OUTPUT_INVALID`、確認未完了が`INCOMPLETE`、判定の矛盾が`CONFLICT`、比較相手の原文不足が`MISSING_EVIDENCE`、成果物不正が`ARTIFACT_INVALID`です。外部応答本文・トークン・プロンプトは表示しません。生成が途中で失敗した場合、結果と完了記録は削除します。

投稿ジョブだけの再実行では、生成ジョブ出力のArtifact名・試行番号を使い、モデルを再実行しません。Artifactには台帳・metadata・最終結果・生成記録を含め、生成run/attempt/SHA、入力・出力のハッシュ、完了範囲を照合します。保持期限1日を過ぎた場合は全体の再実行が必要で、同じhead/baseへの投稿済み内容と再生成結果が違えば未完了で停止します。

収集した資料をプロンプトへ直接添付し、[SDK呼び出し](../../tools/ai-review/review.ts)でツールを一切提供しません。ロック、生成物、依存、秘密値ファイル、symlink等は資料から除外します。追跡済みファイルに秘密値が書かれていないことは、別途リポジトリの管理責任として確認してください。削除だけの行は指摘位置に使えないため、必要に応じて未確認事項として表示します。モデルが資料外の知識や版を推測した指摘も採用前に確認します。

本人以外のPR、fork、bot、Draft、古いCI、投稿前にhead/baseが変わった場合を確認します。他人のPRを本人が再実行しても対象外です。通常CIの実行は制限しません。投稿前の照合とGitHubのコメント更新は原子的ではないため、直後のpushとの競合は完全には防げません。コメントに対象SHAを残して区別します。

## PRのチェック一覧

PRのチェック一覧には専用Workflowの`AI review / Review result`を表示する。`Documentation checks`の一部にはしない。main上の`AI review execution`がモデル実行と投稿を担当し、表示用Workflowは読み取りだけでその完了を待つ。PR #13の上限引き上げはマージしない。

表示側はbase SHAの信頼済みコードを使うため、監視コードを先にmainへ反映してからWorkflowを切り替える。`checks: write`は使わない。OIDCは生成ジョブ、PRコメントの書き込みは投稿ジョブだけに与える。AI実行名の`AI review / source run <CI実行ID> attempt <CI試行番号> / review`は照合に使うため、形式を変更する際は監視側も更新する。

開始時は実行中、投稿まで完了すると成功を表示する。予算不足でもPR通知を投稿できた場合はCIを正常終了し、概要に「予算不足・レビュー未完了・PR通知済み」とコメントリンクを記載する。失敗時は`対象: collect、理由: BUDGET_EXCEEDED`等をジョブ概要とエラー注釈で確認する。概要の「AIレビューの実行ログ」リンクから元の実行・試行を開ける。指摘がある場合も処理が完了すれば成功であり、スレッドのResolveは人間が行う。

通常CI・AI実行を15秒間隔で最大50分監視する。対象PR・head/base・今回のPRイベント以降に開始した起点CIとAIの最新試行を照合し、API一覧1,000件の上限やAPI接続障害でも成功にはしない。待機分のActions実行時間が必要になる。バックエンドのキャンセル・時間切れは表示ジョブの失敗とし、`CANCELLED`・`TIMED_OUT`で区別する。表示ジョブ自体のキャンセルはGitHubの`cancelled`になる。

結果はジョブ別の`ai-review-status-<run>-<attempt>-<job>` Artifactに保存し、保持期間は1日とする。通知側はファイル上限4KB、実行ID・試行番号・ジョブ・対象ID・固定理由コードを検証する。単一Artifactは展開先直下の`status.json`、複数ArtifactはArtifact名のサブディレクトリから読む。両形式の混在は不正として拒否する。取得や形式検証に失敗した結果から成功を推測しない。実行が失敗し詳細記録がない場合は`EXECUTION_FAILED`または`PUBLISH_FAILED`、正常終了でも投稿記録がなければ`REPORT_MISSING`となる。

準備段階で同じhead/baseの完了マーカーを本人PR上のBotコメントから確認した場合は、`ALREADY_COMPLETE`で成功を記録し、再収集・再生成・再投稿を省略する。対象外は`SKIPPED`として区別する。古いhead/baseのマーカーや人間のコメントだけでは投稿済みと判定しない。

表示が終了しない場合はActionsの`AI review`を確認する。元のAI実行を再試行した場合は、完了後に表示側のWorkflowも再実行する。表示側だけの再実行はモデルを呼ばず、最新試行と投稿記録を検証する。Artifactが1日の保持期間を過ぎていれば、記録を推測せず`REPORT_MISSING`で失敗する。必要ならAI実行も再試行し、投稿済み記録を作り直す。main向けでないPR・Draft・`claims`モードは表示ジョブをスキップする。

### 未完了理由の読み方

失敗時は対象ID・理由に加え、Actions概要のサブコードと不足情報分類を確認する。診断の分類と記録範囲は[未完了の安全な診断](../spec/ai-review.md#未完了の安全な診断)に従う。

- `TOKEN_LIMIT`・`OUTPUT_LIMIT`なら、出力予算と作業分割を確認する。
- `MISSING_CONTEXT`なら、モデルが申告した不足分類（実装・呼び出し元・契約・仕様・過去指摘の根拠）と対象作業の資料範囲を確認する。モデル申告なので、実際の資料選択と照合して判断する。
- `NO_REVIEWABLE_LINE`なら投稿可能な差分行、`UNRESOLVED_CONFLICT`なら候補と履歴確認の整合性を確認する。
- `INVALID_JSON`・`INVALID_RESULT`・根拠の不整合なら、出力Schemaと検証条件を確認する。`INVALID_DIAGNOSTIC`は診断自体が許可した形式ではなかったことを示す。
- `MODEL_UNSPECIFIED`・`UNCLASSIFIED`では、記録から原因を確定できない。同じ変更の再実行だけで解消すると推測しない。

資料IDと確認対象IDは台帳との照合用で、診断だけからファイルパスは復元しない。パスや本文が必要な調査は、対象リビジョンの信頼済み資料で別途行う。表示が8件までの場合は全件数を確認し、全範囲を表示したと解釈しない。旧Artifactにはサブコードがない場合がある。

## 停止と障害時の扱い

`AI_REVIEW_MODE`を削除するか`off`に変更すると、次の実行から認証・生成を停止します。進行中の実行はActions画面でキャンセルしてください。

| 状況                         | 確認すること                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------- |
| Workflowが起動しない         | mainへの反映、対象CI名、Variables、非Draftか、本人・同一リポジトリのPRか        |
| クレーム不一致               | SummaryとProvider条件、Workflowのファイル名・ref・イベント                      |
| WIF HTTP 400/401/403         | Provider/サービスアカウントID、マッピング、有効状態、Organizationの設定権限     |
| 残存時間が240秒未満          | トークン期限、交換の遅延。期限検査を外さない                                    |
| モデル実行の認証・権限エラー | ProjectのLuna利用可否、サービスアカウントの実効権限、短命Bearerとの互換性       |
| 生成が未完了になる           | 完了作業数、容量・回数予算、各150秒の期限、トークン残存時間、出力形式を確認する |
| 不正な出力・位置             | Schemaと資料の整合。未完了を問題なしと扱わない                                  |
| コメントがない               | 投稿前のSHA変更、重複判定、出力検証、GitHubのPR書き込み権限                     |

2026年10月24日の実行でWIF交換は成功しましたが、Codex Action内のプロキシは認証文字列1,024バイト制限で停止しました。そのため公式OpenAI SDK 7.43.0のResponses APIへ変更しました。SDK版の実アカウント検証はmain反映後に行います。PRのWorkflowを認証付きで直接実行してこの境界を迂回しないでください。

## 参照先とローカル検査

- [OpenAIのGitHub Actions向けWIF](https://developers.openai.com/api/docs/guides/workload-identity-federation/github-actions)
- [トークン交換と有効期限](https://developers.openai.com/api/reference/workload-identity-federation)
- [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)
- [公式OpenAI Node SDK](https://github.com/openai/openai-node)
- [レビュー指示](../../tools/ai-review/prompt.md)と[導入設計](../research/ai-code-review.md)

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
gh actions-lock --verify
```

`pnpm check`にはリポジトリ全体のoxlintとoxfmtによる検査も含まれます。整形を修正する場合は、ルートで`pnpm format`を実行してください。

GitHub Actionsでは`Documentation checks`の`Repository lint, format and AI review checks`ジョブで、全体のLint・整形確認とAIレビューツールの型検査・テストを確認できます。このジョブはPRとmainへのpushで動作し、WIFやOpenAIの認証情報を必要としません。

認証・モデル・投稿の実検証はGitHubとOpenAIの設定後に別途行います。ローカルのテストは外部APIを模擬し、実際のアカウントへの接続成功を意味しません。

## 指摘と修正確認の確認

新規指摘は「Files changed」の該当行のレビュースレッドへ投稿されます。修正確認は元スレッドへの返信で、対象コミットと根拠を表示します。修正済みは「☑️: 修正を確認しました」、未修正または判断不能は「修正が確認できません」です。Resolve・再オープンは人間が行い、AIは操作しません。旧集約コメントの指摘に限り、リンク付きの通常コメントで確認結果を追加します。詳細は[要件書](../spec/ai-review.md)を参照してください。

行コメント方式の実PRでの動作はmain反映後に確認します。指摘投稿後に行番号を変えて修正し、元スレッドへ返信されること、元の指摘が残ること、Resolve状態をAIが変更しないことを確認してください。途中で投稿に失敗した場合は再実行し、投稿済みの行コメントや返信が重複しないことも確認します。すべての投稿が終わると通常コメントに完了概要を残します。Workflow全体を再実行してAIが異なる指摘を生成した場合は、投稿済みの指摘との不一致で未完了になります。内容を確認し、元の成果物が残っていれば同じ成果物を使う投稿ジョブの再実行で復旧してください。

履歴が30件を超える場合や、コメントの形式が破損している場合は未完了で停止します。集約コメント方式の実動作は[検証用PR #11](https://github.com/teitei-tk/KorekaiteShine/pull/11)で確認済みですが、これは行コメント方式の実証ではありません。

旧形式コメントの互換性は`tools/ai-review/fixtures/legacy-review.txt`を固定データとして検査します。現行のコメント生成関数から再生成せず、出力形式の変更時もこのデータを維持してください。

## 費用予算と記録

生成run/attemptごとに$1。手動で生成を再実行すれば新たな$1となるため、再実行を繰り返した合計額の制限ではない。投稿だけの再試行は生成済みArtifactを使い、追加課金しない。

`COST_BUDGET_EXCEEDED`は次の要求の最大費用が残額に収まらない、または実測で上限を超えたことを表す。投稿専用ジョブが固定PRコメントを送り、`BUDGET_NOTIFIED`とコメントIDを残した場合だけ通知成功とする。容量・回数の`BUDGET_EXCEEDED`、計数失敗の`TOKEN_COUNT_FAILED`、使用量・料金区分不整合の`USAGE_INVALID`とは区別する。

費用記録は親プロセスと一時JSONにあり、`ai-review-cost-<run>-<attempt>` Artifactとして1日保存する。入力・出力・キャッシュのトークン数、予約・実測金額、料金設定版を確認する。`actual: null`は未精算で、ゼロではない。強制終了でArtifactが残らない可能性があり、請求履歴の永続DBとして使わない。

展開前に、固定SDK・WIFで計数APIが使えること、Schemaを含む計数と実測inputが一致すること、計数API自体の課金と請求区分を確認する。公表料金表だけで請求額の確定を主張しない。これらはローカルのモックテストでは検証できない。低予算の実PR検証を行う場合は信頼済みコードのテスト設定を使い、PR側の設定や環境変数から本番の$1上限を変えない。

## 失敗通知の確認

AIレビュー終了後のAI review failure notificationが、同じPRの現在のhead/baseへ固定理由と実行リンクを投稿する。レビュー失敗のチェックは失敗のまま残る。通常CIが失敗してAIレビューが開始されなかった場合や、対象外・更新済みPRは通知対象外。

通知がない場合は、通知Workflowがmainに存在するか、元実行が完了したか、現在のhead/baseと試行が一致するかを確認する。状態Artifactが取得できなくても固定の代替理由で通知する。通知ジョブ自体にFAILURE_NOTIFICATION_FAILEDがあれば、GitHubの読み取り・PR書き込み権限と障害を確認する。通知Workflowだけの再実行はモデルを呼ばず、同じ実行・試行のコメントを重複投稿しない。

## モデルを呼ばない公式WIF接続検証

移行先の固定版公式プロキシによる初期交換を、既存マッピングのまま検証する手順です。有料モデル呼び出しは承認されていません。

1. `AI_REVIEW_MODE`を`off`にし、`EXPECTED_AI_REVIEW_MODE=off pnpm check:ai-settings`で確認します。既存のProvider・サービスアカウント・audience・マッピング条件は変更しません。
2. mainに反映済みの`ai-review-isolation.yml`を手動実行し、`complete`と`reject`の成功を確認します。
3. 現在のmainのpushで開始された、成功済みの`Documentation checks`の実行IDを選びます。`AI_REVIEW_WIF_PROBE_RUN`へそのIDを設定し、そのCIを再実行します。
4. 後続の`AI review execution`で`wif-authentication`が実行され、クレーム一致・初期交換・資格情報隔離・公式終了の成功表示が揃うことを確認します。全体がskippedだった場合は成功扱いしません。
5. 成否にかかわらず`AI_REVIEW_WIF_PROBE_RUN`を削除します。`AI_REVIEW_MODE`は`off`のままにし、有料呼び出しの別途承認を待ちます。

同じリポジトリのmainへのpush、実行ID、ソースSHAと現在のmain SHA、CI成功をすべて照合します。別Workflowや`workflow_dispatch`へWIFのマッピングを広げません。mainが進んだ場合は、新しいmainの隔離検証とCIを使います。検証用PRのコードやArtifactを認証ジョブへ持ち込みません。

公式プロキシは初期交換に成功してから`server-info`を作ります。新規作成とPID一致を確認し、実資格情報を保持するプロキシとroot検査器の環境・メモリへのアクセス拒否、資格情報の環境非継承、設定・server-infoの書込み拒否、読み取り専用sandbox内の通信拒否を検査します。要求トークンは匿名パイプだけで公式プロキシへ渡し、ファイル・引数・その環境変数へ保存しません。診断にトークンや外部応答本文を記録しません。

この検証では`codex exec`やResponses APIを呼ばず、ローカルHTTPは公式の`GET /shutdown`だけを使います。公式Action全体は前段の模擬資格情報の検証、実資格情報の段階は既存の別UID・公式sandboxの検査を再利用します。初期交換成功は期限更新・更新失敗・モデル権限・Schema出力・実利用量の証明ではありません。これらと本体の切替は未完了のままです。通常終了・検査失敗時は子プロセスを停止しますが、runnerの強制終了時の後処理まで保証しません。
