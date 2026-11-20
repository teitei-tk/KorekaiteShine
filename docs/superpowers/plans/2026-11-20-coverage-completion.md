# 100%カバレッジ補完 Implementation Plan

> **For agentic workers:** executing-plansの検証手順を使い、独立領域はdispatching-parallel-agentsで分担する。

**Goal:** PR #122の通常CIと長時間検査を、各ファイルの行・文・関数・分岐100%で成功させる。

**Architecture:** CI実行44555392536のmissing.jsonを基準に、未網羅の正常系・異常系を既存の公開境界から検査する。子プロセスとWorkerは既存の共通計測器を使う。到達不能と証明できる重複処理だけを等価に整理し、必要な防御処理は維持する。

**Tech Stack:** Vitest、共通Istanbul計測、Node 26、固定版Void/Vite。

**Spec:** 利用者の100%coverage・CI成功の依頼、tools/docs/README.mdの4指標検査、既存MVP仕様とADR。

## Global Constraints

- 閾値・対象集合・失敗判定を弱めず、ignoreやinline lint抑制を追加しない。
- カウンターを捏造せず、実際の入力・結果・後処理をassertする。
- Guard・固定lockfile・信頼ポリシー・状態分離・実時間待機を維持する。
- 同じPRへ反映し、マージは行わない。

## Review Focus

- 不正入力・外部応答の拒否と、例外時の状態保持・後処理。
- 子プロセス・Workerの計測が欠落したまま成功にならないこと。
- 到達不能処理の整理で、非同期競合や外部入力への防御を失わないこと。
- モックだけの成功にせず、既存の結合・再起動検査を保持すること。
- 計測対象・source map・4指標の判定を保持すること。

## Task 1: 領域別の未網羅補完

対象はapps全体、tools/ciのCLI・依存解析・inventory、tools/ciのrunner・history・入力、tools/ai-review、tools/local-integration、tools/coverage、tools/docs・e2e・lint。各領域の担当は対応するソースとテストのみを編集する。

- [x] CIのmissing.jsonで未達の行・分岐と入力条件を特定する。
- [x] 既存の呼び出し境界から意味のあるassertionを持つテストを追加する。
- [x] 不具合を見つけた場合はRedを確認して最小修正する。
- [x] 同じ計測器による領域別実行で不足が解消することを確認する。
- [x] 対象lint・型検査を成功させる。

## Task 2: 統合と実CI

- [ ] 差分をレビューし、通常検査・全体coverageを実行する。
- [ ] 同じPRのheadを更新する。
- [ ] 通常CIと長時間検査の100%判定を成功させる。
- [ ] 最終head・検査結果・PR状態を報告する。
