# CI一括切替の実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 型検査器、Lint規則、テスト選択・割当、CI並列実行を一つのPRで切り替える。

**Architecture:** 独立した検査ジョブと、決定的なテスト計画を生成・実行するtools/ciを使う。逆依存探索に非import依存を補い、不明な変更では全件実行する。成功したmain実行の時間履歴を次の割当へ使用する。

**Tech Stack:** Node.js 26.12.1、pnpm 12.15.0、TypeScript、tsrs、oxlint、Vitest、GitHub Actions。

**Spec:** [設計](../specs/2026-11-17-ci-acceleration-design.md)

## Global Constraints

- 一つのPRで切替。20件のPR待機や複数PRへの分割は行わない。
- Guard・pnpm保護設定・Actionsロック・本番診断非包含検査を維持。tsrs固定版だけは利用者承認の信頼ポリシー例外。
- 実時間・全体カバレッジ検査は独立したまま維持。
- 不明な選択結果・欠損した実行結果を成功にしない。

## Review Focus

- 削除・rename・動的依存でテストが脱落しない。
- 新規テストと壊れた時間履歴でも全対象が一度ずつ割り当てられる。
- 空matrix・キャンセル・計画失敗を集約が成功にしない。
- 生成型がないクリーンcheckoutでも検査が成立する。
- 型情報付きLintで検査されないファイルも専用型検査で検査する。

## Task 1: 型検査器と生成の分離

Files: package.json、各workspace/package.json、pnpm-lock.yaml、apps/web生成入口。
Interfaces: 既存typecheckスクリプトをtsrsへ変更、生成依存をCIから明示。

- [x] Node/pnpmを指定版に揃え、現行検査結果を確認。
- [x] tsrsを固定導入し、正常コード・型エラーfixtureの診断を比較。
- [x] 生成とbuild・typecheckを分け、クリーン状態の型検査を実行。
- [x] emit用途も検証して置換。Compiler API依存は保持。

## Task 2: テスト選択・割当と実行

Files: tools/ci/package.json、tsconfig.json、src/plan.ts、src/graph.ts、src/run.ts、src/history.ts、tests/*.test.ts、local-integrationのsuite定義。
Interfaces: `assignTests(tests, durations, count)`がテストID配列のシャードを返す。`affectedTests(graph, changed, tests)`が逆依存到達集合を返す。CLIは計画JSONを保存し、その計画から実行する。

- [x] 長い順の割当・新規テスト・空集合・破損履歴の失敗テストを一つずつ追加しRedを確認。
- [x] 割当実装、各ケースGreenを確認。
- [x] 逆依存・削除・alias・SQL・Worker越境・設定変更の失敗テストを一つずつ追加。
- [x] グラフ作成と安全側のフォールバックを実装しGreenを確認。
- [x] runnerとの接続・厳密なファイル選択・時間JSON・終了コード伝播を統合検証。

## Task 3: CI並列化と結果集約

Files: .github/workflows/ci.yml、actions.lock、tools/ci/src/cli.ts、結果集約のテスト。
Interfaces: 計画のmatrix、各シャードの結果artifact、main時間履歴artifact。

- [x] 欠落・skip・キャンセルを失敗にする集約テストでRedを確認。
- [ ] lint、typecheck、build、test-plan、tests、ci-resultに分離しGreenを確認。
- [ ] main履歴を読取り、取得不能時の等重み実行とmain限定保存を検証。
- [ ] Actionsロックを更新・検証。

## Task 4: oxlint全ルール

Files: .oxlintrc.json、ルール台帳、全違反箇所、関連テスト。
Interfaces: 固定版全ルールを分類し、適用可能ルールはerror、例外は理由を記載。

- [x] 全カテゴリ・対応プラグイン・型情報付き検査を有効化し診断を集計。
- [x] 自動修正可能箇所を修正。意味が変わる箇所は回帰テストを先行。
- [x] 相互矛盾・対象外ルールだけ理由を記録し例外化。
- [x] Lint・整形・全テストを実行。

## Task 5: 統合検証とPR

Files: 運用文書、設計書、計画チェック欄。

- [ ] 全体check・通常結合・E2E・差分選択照合を実行し結果を記録。
- [x] 新しいコンテキストの担当に差分をレビュー依頼し重要指摘を修正。
- [ ] 同じPRへ全変更をまとめ、最終SHA・検査状況・未検証範囲を報告。

## ローカル検証結果

Node 26.12.1・pnpm 12.15.0で実行しました。

- `pnpm check`はlint、format、全workspaceのtsrs型検査を通過。テスト段階のcoverageで95件成功・2件失敗となり終了しました。
- 3アプリは65ファイル・356テスト成功。Web本番build、build後の型検査、AIレビュー隔離成果物のemitも成功しました。
- tsc比較は12回すべて成功。生成物を退避したクリーン生成でも検査し、TanStack Startの型登録をsourceへ移してbuildへの依存を除きました。
- CI計画器は21テスト成功。全件計画で227エントリを14シャードへ割り当てました。履歴・差分の実際のGitHub Actions経路はPR上で確認します。
- Actionsロックは6 workflowのローカル検証に成功。リモート照合は接続制限により未完了です。
- coverageの実Workers起動・停止テストがこの環境で失敗します。変更前の別checkoutでもランタイム停止タイムアウトを再現しました。成功扱い・テスト除外はせず、PRの実runnerで確認します。

Task 3のGitHub上の動作確認とTask 5のPR最終確認は、上記ローカル検査とは分けて未完了として管理します。
