# AIレビュー適応出力の実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox syntax for tracking.

**Goal:** 出力不足から費用を保った回復と、保存・投稿の整合を実装する。
**Architecture:** 要求別出力予約、種類別回復、順次候補比較を既存パイプラインへ接続する。
**Tech Stack:** TypeScript、OpenAI SDK、Vitest、GitHub Actions。
**Spec:** [設計書](../specs/2026-10-27-ai-review-adaptive-output.md)。

## 共通制約

実行ごとの$1・30分。unknown禁止。Resolve非操作。PR #13非マージ。実レビュー未実施を成功と報告しない。

## レビュー重点

未精算での回復禁止、単一担当、別候補の原文、失敗親のusage、旧成果物互換をそれぞれ以下で検査する。

## 作業1: 要求別予約

対象: budget.ts、review.ts、review-worker.ts、orchestrate.tsと各テスト。
インターフェース: reserve(input, hash, outputLimit?)、maximumCost(input, outputLimit?)。既存呼び出しの既定8,000は旧互換用。

- [x] 可変出力枠の予約・精算・改ざん・未精算拒否テストを追加し失敗確認。
- [x] 台帳v2、モデル最大128,000、要求枠のIPC伝達、推論usageを実装。
- [x] SDKの中断usage精算と親側の精算済み検査をテスト。

## 作業2: 回復と候補比較

対象: partition-review.ts、partition-review.test.ts、failure-message.ts。
インターフェース: TaskInvocation.outputLimit、invocationの既定枠、既存runPartitionReview。

- [x] 出力不足後の枠拡大、最大枠分割、単一担当終了、最後の子の失敗テストを追加し失敗確認。
- [x] 出力不足だけ回復し、同一枠再送を禁止。課金は同一台帳。
- [x] 順次候補比較と両側原文を実装。重複成功・拒否・循環防止を検査。
- [x] 出力不足の日本語説明を追加。

## 作業3: 保存・投稿と統合検証

対象: artifact.ts、orchestrate.ts、large-review.test.ts、artifact.test.ts。
インターフェース: writePartitionArtifact/verifyPartitionArtifactが台帳v2を結合検証。

- [x] 失敗親を含むusageの保存・再読込・投稿を固定実資料でテストし失敗確認。
- [x] 成果物v2、旧v1互換、台帳ハッシュ・対象・総usageの検証を実装。
- [x] 全検査と独立レビュー。重要指摘は失敗再現後に修正。

## 実行記録

利用者は設計・計画作成と実装を一括承認済みのため、計画の再承認で停止しない。現在の専用worktreeを再利用し、本チャットで実装する。commit・push・mainへの反映は今回まだ実施しない。

### 検証経過

- 作業1: 可変枠と予約超過usageの2テストが修正前に失敗、修正後に成功。実行ごとの$1・旧v1・新v2も確認。
- 作業2: 出力不足回復・最大枠終了の2テストと候補順次比較のテストが修正前に失敗、修正後に成功。履歴30件にも中断を入れ、最後の子の失敗と回復対象外の中断を確認。
- 作業3: 固定実資料で失敗親のusageを含む成果物v2のassertが失敗、実装後に保存・再読込・投稿まで成功。台帳枠とusage合計の改ざんを拒否。
- `pnpm check`: 最終AI363件・文書13件、型・Lint・整形・文書検査成功。独立レビュー完了。
- 設計判断: 生成の最大出力128,000と入力922,000は公式モデル仕様を確認。25,000+担当数×32は開始枠であり、完走保証や料金拒否の代理ではない。
- 設計判断: 子要求の将来費用を推定して全件予約する方式は採らず、出力枠拡大を優先して共通資料の再送を抑える。生成直前に実計数して同一台帳へ予約し、残予算不足なら停止する。
- 設計判断: 旧Artifactは読取互換、新生成は費用台帳を実行記録に埋め込む。投稿ジョブのArtifactファイル構成・権限を変更しない。
- 実API・実GitHubへの投稿は今回未実施。検証PR #32は未完走のまま継続検証対象。今回PRの作成・更新・マージは行っていない。

### 独立レビューの修正

- 空の課金台帳を持つv2成果物を拒否するテストが修正前に失敗、必須作業数以上の精算記録を要求して成功。
- Actions概要が回復前の失敗usageを除外するテストが修正前に失敗、成果物と同じ台帳合計を表示して成功。
- 原文不足テストがTypeErrorでも通っていた。固定理由・メッセージのassertで失敗を確認し、順次比較で提示していない原文を混入する反例へ修正。期待したOUTPUT_INVALIDで成功。
- 最終 `pnpm check` は376テスト成功。独立レビューの重要指摘は残っていない。実モデルの完走は別途必要であり、この検査を実レビュー成功とは扱わない。
