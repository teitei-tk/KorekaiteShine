# ユーザーの既存AIレビュー実装の調査

確認日: 2026年10月27日。ローカルにあるユーザーの既存実装を読み取り専用で調査した。対象コミットは`ac9a1b999e47d4ebbd7bee0cb6f9c1d90112d512`。未追跡のTerraform計画書1件は対象外とした。以下の出典はこのコミットに固定している。参照元はユーザーの非公開プロジェクトのため、プロジェクト名とリポジトリURLは記載せず、実装内の相対パスで示す。

本書は、KorekaiteShineのAIレビューを既存実装で置き換えられるか判断するための調査記録である。実装・設定変更や採用決定は含まない。

## 結論

再利用候補は、`apps/codex-review`のGo製CLIと`.github/workflows/codex-review.yml`である。生成には`openai/codex-action`を使い、Go側はプロンプトの準備、出力検証、GitHub投稿を担う。`apps/ai-review`はWorkers AIのモデル比較評価用で、PRへの自動投稿の本体ではない。Workflow（参照元内の`.github/workflows/codex-review.yml`）、評価CLI（参照元内の`apps/ai-review/src/cli.ts`）

構造上の特徴は、レビュー用の全文資料を自前で分割してモデルへ送る代わりに、チェックアウトしたリポジトリをCodexが調べる点にある。プロンプトには差分取得コマンド、適用規約、過去指摘を入れる。したがって、静的な資料収集・分割・横断確認の独自制御を減らせる可能性がある。ただし、これはソースからの推論であり、大規模PRの完走や指摘品質が改善するという実測結果ではない。プロンプト生成（参照元内の`apps/codex-review/internal/prompt/prompt.go`）、レビュー指示（参照元内の`documents/prompt/code-review.md`）

## 処理の流れ

1. `main`向けPRの作成・更新・再オープンで起動する。同一リポジトリかつリポジトリ所有者が作成したPRに限る。
2. PRのheadをチェックアウトし、過去のAI指摘を取得する。履歴を取得できなければ生成をスキップする。
3. 変更ファイルに対応する規約、過去指摘、base/head SHAをプロンプトへ組み込む。
4. Codex Actionを読み取り専用プロファイルで起動する。ソース上の指定は`gpt-5.6-luna`、`medium`で、`OPENAI_API_KEY`を使用する。JSON Schemaに従う最終出力を次のジョブへ渡す。
5. 投稿ジョブはPRのbaseをチェックアウトし、そのコードから投稿CLIをビルドする。生成ジョブの実行ファイルやキャッシュを再利用しない。
6. 投稿側で履歴を再取得し、モデル出力、現在のhead、差分行、重複を検査した後、インライン指摘と過去指摘への返信を投稿する。

生成ジョブは`pull-requests: read`、投稿ジョブは`pull-requests: write`を持つ。baseに投稿器がなければ投稿をスキップする。実行時間上限は生成15分、投稿10分で、同じPRの新しい実行が古い実行をキャンセルする。Workflow（参照元内の`.github/workflows/codex-review.yml`）

## 実装済みの機能と境界

| 項目        | ソースで確認できる動作                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| 新規指摘    | 変更後の追加行だけに投稿。確信度0.5未満を除外し、最大5件。0.8未満は参考情報と表示する                                     |
| 投稿形式    | GitHubのレビューを`COMMENT`として作成。指摘なしの場合は条件付きで`LGTM`を投稿する                                         |
| 古い結果    | 投稿時のPR headがレビュー対象SHAと違えば投稿を停止する                                                                    |
| 重複抑止    | headごとのレビューマーカー、過去指摘のfingerprint、返信マーカーを使う。意味が同じ指摘の再出力禁止はプロンプトにも指示する |
| 修正確認    | 対象履歴の全件に`resolved`か`unresolved`の判定を要求。投稿直前のスレッド改訂と照合して返信する                            |
| Resolve操作 | 修正確認を返信する。GitHubのスレッドを自動Resolveする処理はない                                                           |
| 履歴上限    | 最大20スレッド、各20返信、コメント本文16KiB、履歴JSON128KiB。超過時はレビューをスキップし、投稿側で通知する               |
| 履歴の選別  | GitHub Actions botと専用マーカーで自システムの指摘を識別。解決済み指摘を除外する                                          |

根拠: 出力検証・選別（参照元内の`apps/codex-review/internal/finding/finding.go`）、投稿処理（参照元内の`apps/codex-review/internal/githubreview/review.go`）、履歴処理（参照元内の`apps/codex-review/internal/reviewhistory/history.go`）

## 移植時にそのまま使えない部分

- 規約の選択はGo・Terraform・`apps/batch/`・`infra/`を前提にしている。KorekaiteShineのコードレビュー基準と文書構成への対応が必要になる。規約選択（参照元内の`apps/codex-review/internal/policy/policy.go`）
- プロンプトは変数・条件・例外処理・境界値・明白な仕様不整合・テスト不足を対象とし、設計上の好みや一般的改善提案を除外している。現在の文書レビュー要件を同じ範囲で満たせるかは別途確認が必要になる。レビュー指示（参照元内の`documents/prompt/code-review.md`）
- Go 1.25.1のモジュールと依存、OpenAI APIキーを必要とする。現在のAI基盤の認証・料金管理をそのまま引き継ぐ構成ではない。Goモジュール（参照元内の`apps/codex-review/go.mod`）、Workflow（参照元内の`.github/workflows/codex-review.yml`）
- 履歴は移植元固有のマーカーに依存する。既存KorekaiteShineの指摘を自動で引き継げるとはいえない。履歴処理（参照元内の`apps/codex-review/internal/reviewhistory/history.go`）
- 取得する資料の網羅性を証明する台帳、実行ごとのドル予算台帳、独自の出力不足回復、モデル出力を保存したArtifactからの投稿専用再実行は、このWorkflowとCLIにはない。生成結果はジョブ出力で受け渡している。要件を維持するなら単純コピーだけでは足りない。Workflow（参照元内の`.github/workflows/codex-review.yml`）、CLI（参照元内の`apps/codex-review/internal/command/command.go`）

## 現行方式との重要な差分

現行KorekaiteShineは、渡した静的資料だけで作業を完了させ、不可欠な資料が不足すれば未完了にする。追加取得や後続への引き継ぎはなく、必須作業の一つでも未完了なら部分結果を投稿しない。ユーザーの既存実装はCodexにリポジトリの調査を任せるため、この資料取得と終了条件が異なる。ただし、この違いだけで過去の停止原因を特定できるわけではない。[現行のモデル指示](../../tools/ai-review/partition-review.ts)、[現行の失敗処理](../../tools/ai-review/orchestrate.ts)、[ADR 0005](../adr/0005-partitioned-ai-review.md)

認証も移植の前提になる。現行の[運用記録](../runbooks/ai-review.md)には、2026年10月24日にOpenAI WIFの交換には成功したが、Codex Action内プロキシの認証文字列1,024バイト制限で停止し、OpenAI SDKへ変更したとある。ユーザーの既存実装は長期の`OPENAI_API_KEY`を渡す構成である。WIFを維持したままActionへ戻す互換性は、今回の調査では確認していない。

修正確認の要件も一致しない。現行は毎回修正確認し、状態が変わった場合だけ返信して再発も扱う。ユーザーの既存実装は解決済み履歴を確認対象から外し、返信の重複は同じheadへの返信の有無で抑止する。現行要件を維持するなら、この差分は移植時に扱う必要がある。[現行の修正確認要件](../spec/ai-review.md)、ユーザーの既存実装の履歴選別（参照元内の`apps/codex-review/internal/reviewhistory/history.go`、101行）、ユーザーの既存実装の返信抑止（参照元内の`apps/codex-review/internal/githubreview/review.go`、97行）

## 確認範囲と未検証事項

ローカルのWorkflow、プロンプト、Go CLI、履歴・投稿処理、Workers AI評価CLIを静的に確認した。Go側には投稿器のbase固定・キャッシュ分離・head側から受け取る出力の限定を検査するテストもある。ただし、今回ユーザーの既存実装のテストは実行していない。Workflow境界のテスト（参照元内の`apps/codex-review/internal/workflowsecurity/codex_review_workflow_test.go`）

実際のActions成功履歴、現在のモデル利用可否・料金、Codex Action内部の挙動、大規模PRの入力・出力上限、実モデルの品質と費用は未確認である。ソースにモデル名が書かれていることを、現在利用できる根拠とは扱わない。生成側はPR headのコードとプロンプトを使うため、base由来の投稿器に分離していても、任意の投稿者へ安全に対象を拡大できるという確認にはならない。現設定の所有者限定も含めて再利用範囲を判断する必要がある。
