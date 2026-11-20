# 境界テストの事前ビルド Implementation Plan

> **For agentic workers:** superpowers:executing-plansで順に実装する。

**Goal:** check-object・dlq・diagnostics・delivery-anomaliesの同じ検証を、共有ビルドとケース別の独立したWorker状態で高速化する。

**Architecture:** 利用者が採用した事前ビルド方式を使う。各テストジョブでtest専用の3 Workerを一度ビルドし、各ケースの成果物ディレクトリへコピーする。Worker・DB・DO・Queueの接続情報を共通RuntimeConfigから割り当て直し、独立したpersistToでpreview起動する。手動初期化・評価保留はtest専用の起動時bindingで切り替える。

**Tech Stack:** 固定版Void/Vite/Cloudflareビルド成果物、既存のNode管理プロセスとVitest。

**Spec:** 利用者が承認した「境界テスト用Workerを一度ビルドし、各テストでは状態を分離して起動する」方式とADR0009・0011。

## Global Constraints

- Guard・固定lockfile・信頼ポリシーを維持し、依存を追加しない。
- inline lint抑制を追加しない。既存のassertion・実時間待機・再起動後の永続状態を維持する。
- ビルドをジョブ単位にするのは実装上の選択。全テストを単一ビルドジョブ待ちにせず、既存の並列性を保つ。
- topology等の開発接続・ビルド検証と本番成果物検証は従来方式を維持する。
- 使い回すのは同じ検査実行内のコードだけ。実行をまたぐ永続キャッシュは導入しない。
- coverage実行も同じビルド条件で作成し、対象除外や閾値を変更しない。

## Review Focus

- 別ケースのWorker名・DO所有者・D1・Queue・保存先が残らないこと。
- 再起動でmanual/probeフラグを変えても既存DB・DOを保持すること。
- shared成果物がケース側の変更で書き換わらないこと。
- build失敗・起動失敗・中断後にも既存の所有者と停止処理が機能すること。
- ビルド時間を含むジョブ時間で効果を測り、起動時間だけで改善を判断しないこと。

## Task 1: 成果物の分離と再割当

- [x] Worker設定の再割当・未知参照拒否・状態分離を検査するテストを先に失敗させる。
- [x] boundary-bundle.tsでビルドメタデータ、コピー、接続情報の再割当を実装し、成功させる。

## Task 2: test専用ビルドと起動

- [x] 起動時フラグ・環境制限の回帰テストを追加する。
- [x] runtime.tsの既存所有者・ロック・DB migrationを使い、test専用previewを実装する。
- [x] 同一ビルドを2環境で起動する実検証とcheck-objectの全検証を実行する。

## Task 3: ジョブ内共有と比較

- [x] CI runnerで対象ファイルがある場合だけ事前ビルドする。準備時間へ計上し、失敗はジョブ失敗とする。
- [x] 対象4ファイルのhelperを変更する。直接実行ではファイルのbeforeAllでビルドし、テスト時間制限へビルドを混ぜない。
- [ ] lint・型・通常検査・文書検査・新しいコンテキストでのレビューを実行する。
- [ ] 同じPRのCIで、ビルド込み時間、起動内訳、全assertionの成功を比較する。
