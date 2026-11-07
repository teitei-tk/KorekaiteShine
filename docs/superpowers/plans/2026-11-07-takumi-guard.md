# Takumi Guard匿名モードの実装計画

> 実装担当エージェントへ：superpowers:executing-plansを使い、各タスクを順に進めてください。チェック欄は実装と検証の完了後に更新します。

**目的：** CIのnpm依存取得をTakumi Guardへ向け、将来のShisho Cloud連携手順を残す。

**構成：** 公式Actionを各対象ジョブの最初のnpm系取得前に配置する。初期導入は匿名モードとし、pnpm storeのキャッシュ復元を無効にする。

**使用技術：** GitHub Actions、setup-takumi-guard-npm v1.4.0、pnpm 12.15.0、既存のVitest・TypeScript・gh-actions-lock v0.4.0。

**設計：** [匿名導入と将来の組織連携](../specs/2026-11-07-takumi-guard-design.md)。2026年11月7日、匿名モードを実装。ローカル検査とGitHub Actionsの検証を順に確認中。

## 共通制約

- 既存のpnpm保護設定、依存版、integrity、AIレビューの隔離境界を維持する。
- ローカルのregistry、Cloudflare、Shisho Cloud、GitHubのVariables・Secretsを変更しない。
- Guard拒否と接続障害を区別し、いずれもnpm公式レジストリへ自動迂回しない。
- GitHubへ接続する操作は、ネットワーク制限のあるサンドボックス外で行う。

## レビューで重点確認する条件

1. pnpm本体の準備やスクリプト内部の取得が、Guard設定より前に行われないこと。
2. キャッシュ復元、scope別registry、直接tarball URLで検査を迂回しないこと。
3. 遮断確認が「単なるコマンド失敗」を成功と判定しないこと。
4. 文書検査の条件付き実行、fork PR、Dependabotで設定が欠落しないこと。
5. AIレビューのroot・専用UID・後続Actionでregistry設定と既存の隔離が両立すること。

## タスク1：取得経路と遮断確認の検証

**対象：** `.github/workflows/ci.yml`、`.github/workflows/ci-realtime.yml`、`.github/workflows/ai-review.yml`、`.github/workflows/ai-review-isolation.yml`、`tools/ai-review/isolation/prepare.sh`と固定版の外部Action。

**入出力：** 現在の取得処理と固定版Actionを読み、配置順・環境変数の継承・対象外の取得を確認した記録をタスク2へ渡す。

- [x] v1.4.0の`action.yml`と固定版pnpm Actionを確認し、pnpm本体の取得にもregistryが適用される配置を決める。公式Codex Action内の明示的なregistry指定・環境変数の除去も確認する。
- [x] 使い捨ての作業場所と空のstoreで、既存ロックファイルを使ったGuard経由のインストールを実行する。既存保護設定が成立し、ロックファイルに差分がないことを確認する。
- [x] 公式の`@panda-guard/test-malicious`をスクリプト無効・一時ディレクトリで取得し、Guardの拒否応答を確認する。プロジェクト依存には追加しない。
- [x] 遮断確認処理を`tools/docs/check-guard.ts`、そのテストを`tools/docs/check-guard.test.ts`に追加する。正常取得・明示的拒否・接続障害・予期しない取得成功を扱い、接続障害と取得成功は失敗にする。応答形式は実測結果から固定し、テストは1件ずつ`pnpm test`でRed/Greenを確認する。

## タスク2：CIへ匿名モードを組み込む

**対象：** 上記4 Workflow、`.github/workflows/actions.lock`、必要に応じて`tools/docs/changes.test.ts`。

**入出力：** タスク1で確認した配置順と遮断確認処理を使い、Guard経由でのみ依存を取得するWorkflowを作る。

- [x] `flatt-security/setup-takumi-guard-npm@v1.4.0`を、pnpm導入を含む最初のnpm系取得より前に追加する。`bot-id`は指定しない。文書検査ジョブでは既存の実行条件に合わせる。
- [x] 対象ジョブの`cache: pnpm`と対応するキャッシュ設定を外す。setup-nodeの暗黙のパッケージマネージャーキャッシュも固定版の入力仕様に沿って無効化する。
- [x] 通常CIの1ジョブで`node tools/docs/check-guard.ts`を実行する。外部サービスへの確認を通常の`pnpm test`には混ぜない。
- [x] pnpm準備後、実際の取得場所で有効registryがGuardであることを確認する。scope別registry・直接URLは個別に確認し、意図しない取得先があれば停止する。
- [x] `gh actions-lock`でロックを再生成し、`gh actions-lock --verify`で取得元とSHAを検証する。ロックファイルは手編集しない。

## タスク3：運用文書と検証結果を整える

**対象：** `tools/docs/README.md`、`docs/README.md`、本設計・計画、`docs/research/takumi-guard.md`。

**入出力：** 実装と検証結果を使い、現在の匿名運用と将来のOIDC移行を区別して記録する。

- [x] 依存保護の説明に、Guardの対象、障害時の再実行、キャッシュ方針、匿名利用の制限を追記する。Shisho Cloudへの移行は設計書へリンクし、未実施と明記する。
- [x] 調査記録に取得経路、固定版、Guard拒否の証拠、所要時間、未検証範囲を残す。文書の案内から導入記録へリンクする。
- [x] `pnpm check`とActionsロック検証を実行する。新しいテストの失敗だけでなく、既存の失敗があれば区別して報告する。
- [ ] CIで通常の境界4分割・結合3分割と実時間検査を確認する。AIレビューは既存の隔離受入検査で、正常完了・拒否の両方を確認する。外部サービスへの実行は承認済みの範囲に限定し、未実行分を成功と記録しない。
- [ ] PR・main push・夜間・手動の各経路で設定が適用されることを確認する。fork PR・Dependabotを実行していなければ、その範囲を未検証として記録する。

CIの実行・所要時間・匿名レート制限は実装後の確認事項です。本計画の文書検査成功は、Guard導入や実runnerでの動作成功を意味しません。
