# ドキュメントの案内

この文書群は、開発者本人と開発を支援するエージェントが、合意済みの要件と選定理由を確認するためのものです。本文は日本語で記述します。製品名、API名、ファイル名は公式の表記を使います。

2026年10月24日時点の設計相談を整理した文書です。アプリは未実装で、技術連携も未検証です。文書の作成は実装・依存追加・クラウド作成の承認を意味しません。

## 読む順序

1. [用語集](../GLOSSARY.md)：プロジェクト固有の言葉の意味。
2. [MVP仕様書](spec/mvp.md)：目的、合意済みの動作、採用構成、未確定事項。
3. 関係するADR：現在の選択に至った理由と引き受ける負担。
4. [技術調査記録](research/platform-integration.md)：公式資料の根拠と、実動作で確認すべき事項。

AIコードレビューは[導入設計](research/ai-code-review.md)と[初期設定・確認手順](runbooks/ai-review.md)を参照してください。Workflowは実装済みですが、実アカウントのWIF交換は成功しています。SDK版のモデル呼び出し・投稿はmain反映後に検証します。

エージェントによる認証設定の確認・調査結果の扱い・レビュー委譲は[エージェント作業手順](runbooks/agent-workflow.md)を参照してください。

AIレビューの指摘履歴と修正確認は[コメントと修正確認の要件](spec/ai-review.md)を参照してください。集約コメント方式は実PRで検証済みです。該当行のレビュースレッドへの投稿と返信も実装し、実PRでの確認はmain反映後に行います。

コードレビュー時の型と外部入力の判断は[コードレビュー基準](../CODING_STANDARDS.md)を参照してください。

資料収集の容量問題への対応は[AIレビューの分割と横断確認の設計](spec/ai-review-partitioning.md)にまとめています。承認済みの設計に沿って実装・回帰テストを追加しています。PR #13の上限引き上げはマージしません。

既存実装の再利用候補と現方式との違いは[ユーザーの既存AIレビュー実装の調査](research/existing-ai-review-investigation.md)にまとめています。採用や移植は未実施です。

ユーザーの既存実装を使う方式で現行WIFを維持する可否は[WIF導入調査](research/codex-action-wif-feasibility.md)を参照してください。公式プロキシの対応を確認していますが、接続の実装・実API検証は未実施です。

移行案は[ユーザーの既存実装と公式WIFプロキシを使うAIレビューの設計](superpowers/specs/2026-10-27-existing-review-wif-design.md)にまとめています。利用者が選択した公式Action方式、周辺処理のTypeScript実装、$1厳密上限の撤廃を反映した設計レビュー用の文書です。実装・Workflow・認証設定は変更していません。 [敵対的検証](research/existing-review-wif-adversarial-validation.md)の2件は設計へ反映済みです。利用者は公式`unprivileged-user`による[資格情報の隔離](research/codex-wif-credential-isolation.md)と、読み取り専用環境内でのPRコード実行を選択しました。[厳密な実行禁止](research/codex-pr-execution-restrictions.md)を理由とする保留条件は解除し、隔離・接続の実検証を受け入れ条件として残しています。

TypeScript変更後の[敵対的検証](research/typescript-review-adversarial-validation.md)では、再利用元のページ数上限に関するP2を1件確認しました。このP2は設計へ反映済みです。履歴検証と投稿の再利用範囲を明確にし、共通スナップショットと一つの投稿処理へ集約する方針を記載しています。実装による解消は未検証です。

履歴の改訂検知と投稿再開の[再検証](research/review-resume-adversarial-validation.md)では、通常の再開手順は整合すると判断しました。応答喪失後に削除された返信を検知できない限界について、P2を1件記録し、設計へ反映しました。投稿済みコメントの保持・読取可能性を再開保証の前提とし、手動削除後は同じArtifactを再試行しない運用を明記しています。実装は未変更です。

2026年10月28日に利用者が移行の実装開始を承認しました。[実装計画](superpowers/plans/2026-10-28-codex-review-migration.md)に従い、[資格情報を使わない隔離検査](../tools/ai-review/isolation/README.md)を先行実装しています。ローカルLinuxの初期検査は成功しましたが、実runner・WIF接続・新レビュー本体の移行は未完了です。現行の有料レビューWorkflowは変更していません。

## 設計判断の記録

| ADR                                               | 判断                                                         |
| ------------------------------------------------- | ------------------------------------------------------------ |
| [0001](adr/0001-server-relayed-interviews.md)     | 音声をサーバーで中継し、面接ごとのDOで状態を管理する         |
| [0002](adr/0002-queued-evaluation.md)             | 評価をQueuesとDLQで音声面接から分離する                      |
| [0003](adr/0003-immutable-evaluation-evidence.md) | 評価の根拠を固定し、追記メモを分離する                       |
| [0004](adr/0004-tanstack-start-with-void.md)      | TanStack Startをアプリの土台とし、VoidでCloudflareへ配置する |

[ADR 0005](adr/0005-partitioned-ai-review.md)には分割レビューと横断確認を採用した理由を記録しています。

## 文書ごとの役割

- `spec`：現在満たすべき要件を記述します。動作の正式な記載先です。
- `adr`：変更の負担が大きく、背景がないと意図が伝わりにくい、実際のトレードオフを伴う判断だけを記録します。
- `research`：確認日、出典、公式資料の記載、実動作の検証状況を記録します。製品の最新仕様を保証する文書ではありません。
- `runbooks`：初期設定・配置・障害対応の手順です。未検証の手順はその状態を明記し、実動作の確認後に更新します。

未確定事項は[仕様書の補足事項](spec/mvp.md#補足事項)へ集約します。同じ仕様を複数文書で管理せず、判断理由と調査証拠はリンクで結びます。

## 更新時の確認

設計を変更する時は[設計基準](spec/mvp.md#設計基準)と関連ADRを確認します。機械的な書式・リンク検査は[共有の文書検査](../tools/docs/README.md)で行い、仕様と選定理由の整合性はレビューで確認します。

## 書式の出典

[mattpocock/skillsの参照コミット](https://github.com/mattpocock/skills/tree/5beb35b040e3de97e54fa9e386d7e42d15c295c2)に合わせます。

- [仕様書テンプレート](https://github.com/mattpocock/skills/blob/5beb35b040e3de97e54fa9e386d7e42d15c295c2/skills/engineering/to-spec/SKILL.md)の見出しを日本語化します。元のIssue公開フローは採用せず、利用者指定の`docs/spec`に保存します。
- [用語集書式](https://github.com/mattpocock/skills/blob/5beb35b040e3de97e54fa9e386d7e42d15c295c2/skills/engineering/domain-modeling/GLOSSARY-FORMAT.md)に従い、ルートに`GLOSSARY.md`を置きます。旧称は`CONTEXT.md`です。
- [ADR書式](https://github.com/mattpocock/skills/blob/5beb35b040e3de97e54fa9e386d7e42d15c295c2/skills/engineering/domain-modeling/ADR-FORMAT.md)に従い、連番・短いタイトル・背景と決定理由を基本とします。

`research`と`runbooks`は、このプロジェクト向けに追加した区分です。
