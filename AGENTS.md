# 作業時の参照先

- 日本語で簡潔かつ丁寧に回答し、文書も日本語で記述する。
- 設計・実装を提案する前に、[文書の案内](docs/README.md)から[MVP仕様書の設計基準](docs/spec/mvp.md#設計基準)と対象領域のADRを読む。合意済みの選定理由との整合性を確認する。
- コードレビュー時は[コードレビュー基準](CODING_STANDARDS.md)を参照する。
- ドメインの用語は[GLOSSARY.md](GLOSSARY.md)に合わせる。未確定事項は[仕様書の補足事項](docs/spec/mvp.md#補足事項)を参照する。
- 文書変更時は[共有の文書検査](tools/docs/README.md)を実行する。レビューでは自動検査に加え、仕様とADRの整合性を確認する。
- 認証設定の確認、大きなツール応答、レビュー委譲、PRを扱った作業の終了時は[エージェント作業手順](docs/runbooks/agent-workflow.md)を参照する。
- 現在の構成と実装状況は[文書の案内](docs/README.md)を参照する。クラウドへの配置・リソース変更は、会話内で利用者が承認した対象と操作の範囲で行う。文書更新やローカル検査の依頼は、クラウド変更の承認には含めない。

## 構成と原本

変更する責務に応じて配置先を選ぶ。Worker間の境界は[配置と業務モデル](docs/spec/mvp.md#配置と業務モデル)と[ADR 0007](docs/adr/0007-three-workers.md)に従う。

| 配置先                    | 責務・原本                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| `apps/web`                | 画面・HTTP API。実装と検査は[Webアプリ](apps/web/README.md)を参照する                            |
| `apps/interview`          | 面接ごとのDOと音声接続                                                                           |
| `apps/evaluation`         | 評価Consumer・DLQ・定期回復。単体検査は[Evaluationのテスト](apps/evaluation/README.md)を参照する |
| `packages/api-contracts`  | HTTP・QueueのTypeSpecと生成処理                                                                  |
| `packages/database`       | 共有D1のDrizzleスキーマ・マイグレーション。業務処理は担当するアプリに置く                        |
| `packages/runtime-config` | 環境ごとのリソース対応と生成先の共通設定                                                         |
| `tools`                   | 契約の型生成、ローカル接続検証、文書検査、AIレビューなどの開発・検証基盤                         |

架空データ・診断スタブでのローカル検証と、正式な面接・実AI・クラウドでの検証を区別する。実装済み範囲と後続事項は[文書の案内](docs/README.md)で確認する。

## 変更対象別の参照先

| 変更対象                       | 作業前に確認する内容                                                                                                                                                                                                                                                                                             |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP API                       | [契約管理](docs/spec/mvp.md#http-apiの契約管理)と[ADR 0006](docs/adr/0006-typespec-api-contracts.md)。`packages/api-contracts/http`のTypeSpecを先に変更し、生成した型・validatorで入力・成功応答・エラー応答を検証する                                                                                           |
| Queue契約                      | [Queueの契約](docs/spec/mvp.md#queueの契約)と[ADR 0010](docs/adr/0010-queue-contracts-and-job-control.md)。`packages/api-contracts/messages`からOpenAPIを経由せず生成し、送信・Consumer・DLQの境界で検証する                                                                                                     |
| DBスキーマ・マイグレーション   | [共有D1とマイグレーション](docs/spec/mvp.md#共有d1とマイグレーション)、[ADR 0008](docs/adr/0008-shared-d1-with-void.md)、[DBの変更手順](docs/runbooks/local-development.md#dbの変更)。Void経由で生成したSQLをレビューしてから適用し、既存データの保持と新旧Workerの互換性を確認する。D1とDOのmigrationを区別する |
| 環境・バインディング・起動処理 | [環境と検証データ](docs/spec/mvp.md#環境と検証データ)と[ADR 0009](docs/adr/0009-explicit-environments.md)。共通設定を通じ、`APP_ENV`とテスト実行単位でリソース・状態・生成先を分離する。DBリセットは[ローカル開発手順](docs/runbooks/local-development.md)に従う明示操作に限定する                               |
| 非同期処理・再試行・削除       | [評価ジョブと再実行](docs/spec/mvp.md#評価ジョブと再実行)、[保持と削除](docs/spec/mvp.md#保持と削除)と関連ADR。D1を状態の正本とし、冪等性・実行権・ack／retry・削除との競合を確認する                                                                                                                            |
| 診断機能・認可                 | [アクセスと秘密情報](docs/spec/mvp.md#アクセスと秘密情報)、[接続確認と検証の拡張](docs/spec/mvp.md#最小骨格の接続確認と検証の拡張)と関連ADR。診断機能は開発・テスト用入口から組み込み、本番成果物への非包含を検査する                                                                                            |
| 依存・生成ツール               | [依存バージョンの制約](docs/spec/mvp.md#依存バージョンの制約)と[依存の保護設定](tools/docs/README.md#依存のサプライチェーン対策)。固定・置換の理由を確認し、契約生成・型検査・Workerビルドなど指定の再検証を行う                                                                                                 |

API契約の生成物は手編集・Git管理せず、TypeSpecや生成処理を修正して再生成する。保存形式はDrizzle、HTTP・Queue契約はTypeSpecを原本とし、型やSchemaを二重管理しない。DBマイグレーションのSQL・メタデータは適用履歴として管理し、APIの生成物と区別する。

## 開発の進め方

開発は Red/Green TDD で進める。以下をリポジトリルートで実行し、テストを1つずつ追加する。

1. **Red**：まず失敗するテストを1つ書き、`pnpm test`で期待どおりに失敗することを確認する。
2. **Green**：そのテストを通す最小限のコードを書き、`pnpm test`が通ることを確認する。
3. **リファクタリング**：必要に応じてコードを整理し、`pnpm test`でテストが通っている状態を保つ。

完了時は[共有の検査手順](tools/docs/README.md)に従い、`pnpm check`で通常検査を行う。Worker間接続・配送・回復に関係する変更では、[通常CIと長時間検査の使い分け](docs/runbooks/local-development.md#通常ciと長時間検査の使い分け)に従って結合検査・実時間検査も確認する。実行した検査と未検証の範囲を報告する。

テストの配置は[ローカル接続検証](tools/local-integration/README.md#テストの配置)を参照する。ローカル接続検証のテストを追加・削除・移動する場合は、[テスト所属の定義](tools/local-integration/src/test-suites.ts)も更新する。

## GitHubへの接続

GitHub CLIやGitHubへ接続するGitコマンドは、サンドボックスのネットワークが無効なら最初からサンドボックス外で実行する。認証エラーはサンドボックス外で再確認し、そこで認証エラーになった場合に限りログインを依頼する。
