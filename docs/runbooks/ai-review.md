# AIレビューの初期設定と確認

この手順は`teitei-tk/KorekaiteShine`の管理者本人向けです。2026年10月24日時点でWorkflowとローカル検査を実装しています。OpenAI側の設定、実際のOIDCクレーム、Luna呼び出し、コメント投稿、精度・料金は未検証です。まず診断だけを実行し、その後に課金レビューを有効化します。

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
- `Review using GPT-6 Luna`が3分以内に完了する。Actionのインストール時間も含む上限です。
- 出力検証が成功し、`publish`が集約コメントを作成する。
- コメントの対象SHAがレビューしたコミットと一致する。

同じhead/baseの投稿がある場合は、通常CIを再実行してもモデルを呼びません。再評価が必要なら、対象PRを新しいコミットで更新してください。権限・認証エラーや期限超過では、自動再試行や別モデル・長期キーへの切り替えは行いません。

## 費用・精度・防御の確認

最初の数件は、既知のバグを入れた小さな変更と正常な変更を用意し、指摘の妥当性、見逃し、誤検知、処理時間、使用量を記録します。OpenAIの対象ProjectのUsageとCostsで請求実績を確認します。CodexのJSONイベントに使用量が出た場合はActionsログと照合してください。料金を独自の固定単価で推定して成功扱いする実装にはしていません。

初期上限は変更80ファイル、資料160ファイル（base/headの同一パス・同一内容は重複排除）、資料本文300KB、JSON全体400KB、指摘3件です。関連コード・テスト・仕様を一緒に渡すため、変更が小さくてもリポジトリ全体の資料量で上限に達します。その場合は課金前に停止します。上限の引き上げより先に、関連ファイルの選択方式を見直してください。

収集した資料をプロンプトへ直接添付し、[信頼するCodex設定](../../tools/ai-review/codex.toml)でシェル実行・Web検索・複数エージェントを無効にします。ロック、生成物、依存、秘密値ファイル、symlink等は資料から除外します。追跡済みファイルに秘密値が書かれていないことは、別途リポジトリの管理責任として確認してください。削除だけの行は指摘位置に使えないため、必要に応じて未確認事項として表示します。モデルが資料外の知識や版を推測した指摘も採用前に確認します。

本人以外のPR、fork、bot、Draft、古いCI、投稿前にhead/baseが変わった場合を確認します。他人のPRを本人が再実行しても対象外です。通常CIの実行は制限しません。投稿前の照合とGitHubのコメント更新は原子的ではないため、直後のpushとの競合は完全には防げません。コメントに対象SHAを残して区別します。

## 停止と障害時の扱い

`AI_REVIEW_MODE`を削除するか`off`に変更すると、次の実行から認証・生成を停止します。進行中の実行はActions画面でキャンセルしてください。

| 状況                         | 確認すること                                                                |
| ---------------------------- | --------------------------------------------------------------------------- |
| Workflowが起動しない         | mainへの反映、対象CI名、Variables、非Draftか、本人・同一リポジトリのPRか    |
| クレーム不一致               | SummaryとProvider条件、Workflowのファイル名・ref・イベント                  |
| WIF HTTP 400/401/403         | Provider/サービスアカウントID、マッピング、有効状態、Organizationの設定権限 |
| 残存時間が240秒未満          | トークン期限、交換の遅延。期限検査を外さない                                |
| モデル実行の認証・権限エラー | ProjectのLuna利用可否、サービスアカウントの実効権限、短命Bearerとの互換性   |
| 3分以内に完了しない          | 入力量とインストール時間。長時間化する場合はSDKのWIF対応案へ切り替える      |
| 不正な出力・位置             | Schemaと資料の整合。未完了を問題なしと扱わない                              |
| コメントがない               | 投稿前のSHA変更、重複判定、出力検証、GitHubのPR書き込み権限                 |

公式Actionと短命Bearerの組み合わせは、実際の成功を確認するまでは検証中です。SDK案への切り替えは別途実装が必要で、このWorkflowが自動で切り替えるわけではありません。

## 参照先とローカル検査

- [OpenAIのGitHub Actions向けWIF](https://developers.openai.com/api/docs/guides/workload-identity-federation/github-actions)
- [トークン交換と有効期限](https://developers.openai.com/api/reference/workload-identity-federation)
- [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)
- [codex-action v1.13](https://github.com/openai/codex-action/tree/v1.13)
- [レビュー指示](../../tools/ai-review/prompt.md)と[導入設計](../research/ai-code-review.md)

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
gh actions-lock --verify
```

`pnpm check`にはリポジトリ全体のoxlintとoxfmtによる検査も含まれます。整形を修正する場合は、ルートで`pnpm format`を実行してください。

GitHub Actionsでは`Documentation checks`の`Repository lint, format and AI review checks`ジョブで、全体のLint・整形確認とAIレビューツールの型検査・テストを確認できます。このジョブはPRとmainへのpushで動作し、WIFやOpenAIの認証情報を必要としません。

認証・モデル・投稿の実検証はGitHubとOpenAIの設定後に別途行います。ローカルのテストは外部APIを模擬し、実際のアカウントへの接続成功を意味しません。
