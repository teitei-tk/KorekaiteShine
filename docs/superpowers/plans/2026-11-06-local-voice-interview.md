# ローカル音声面接の実装計画

> エージェント向け：`superpowers:executing-plans`でタスク順に実装する。各変更をRed/Green TDDで検証する。

**目的：** 経験Markdownから、音声面接・記録保存・実AI評価までローカルで一通り使えるようにする。

**構成：** Webが材料と画面、Interview DOが音声・面接状態、EvaluationがQueue経由の評価を担当する。D1を正本とし、既存ジョブ制御を再利用する。

**技術：** TypeSpec、React、TanStack Start、Void、Drizzle、Cloudflare DO・D1・Queue、GPT-LiveとResponses。

**設計：** [実装設計](../specs/2026-11-06-local-voice-interview-design.md)。2026年11月6日の利用者指示により、自動検査では外部AI・マイクをモック化し、実ブラウザと実AIの確認は最後に行う。

## 全体の制約

- 経験Markdown原本をリポジトリへコピーしない。fixtureは架空の材料とする。
- HTTP・音声イベント・AI結果はTypeSpecから型とvalidatorを生成する。DBはDrizzleを原本にする。
- 通常テストで有料APIを呼ばず、秘密値をファイル・ログ・ブラウザへ出さない。
- 一時停止5分、再接続1分、AI評価120秒、試行180秒と既存再試行規則を維持する。
- 最新の利用者指示に従い、細かなRed/Greenは対象パッケージのモックテストで進める。実装の区切りでルートの`pnpm test`、最終通常検査で`pnpm check`を実行する。
- 現worktreeを継続し、クラウド配置・原本変更・pushはしない。

## 重点確認

- 日本語の材料は文字数でなくUTF-8バイト数で上限を判定する（タスク1）。
- 画面からの任意のAI指示・URL・モデル指定を受け付けない（タスク1・3）。
- マイク許可の遅延・拒否や画面破棄で音声送信が残らない（タスク5）。
- 終了受付の通信断・再送で会話や初回ジョブが二重にならない（タスク2・3）。
- 聞けなかった質問・未保存の発言を評価根拠にしない（タスク3・4）。

## タスク1：材料分析の契約と業務処理

ファイル：`packages/api-contracts/http/materials.tsp`、`scripts/generate-materials-validation.ts`、`tests/materials.test.ts`、`apps/web/src/application/analyze-material.ts`、`apps/web/tests/analyze-material.test.ts`。

インターフェース：生成された`MaterialAnalysisRequest`と`MaterialAnalysisResult`を使い、`analyzeMaterial(input, dependencies)`で確認済み材料だけを分析する。依存は`analyze(markdown, signal)`とし、結果の根拠が入力に存在することを検証して返す。

- [x] 最初にAPI契約のテストを追加し、確認済みフラグ必須、余分な項目拒否、候補・抜粋の構造を検証する。`pnpm test`でRedを確認する。
- [x] TypeSpecと生成処理を実装し、`pnpm test`でGreenにする。
- [x] 業務テストを一つずつ追加し、未確認・空・32KiB超過・存在しない引用を拒否する処理をRed/Greenで実装する。

`/practice` から本人の送信確認後に分析APIを呼びます。ローカルD1で分析枠を予約し、検証したテーマ候補を保存します。外部AIの入出力はモックで検査しました。

## タスク2：正式な面接と評価入力の永続化

ファイル：`packages/database/db/schema/interviews.ts`とVoid生成migration、`apps/web/src/server/repositories/interviews.ts`、`apps/interview/src/server/repositories/interviews.ts`、`tools/local-integration/tests/voice-interview.test.ts`、`tools/local-integration/src/test-suites.ts`。

インターフェース：面接ID、固定したテーマ・抜粋、発言IDと順序、接続世代、終了時の評価ジョブIDを保存する。終了は会話範囲・評価入力・job・outboxを一体保存し、同じ面接の再要求には同じjobIdを返す。

分析候補と面接の所有者、開始要求の再送をD1で照合します。終了時は発言原文・再生確認・欠落状態・評価条件を固定し、ジョブ・通知と一緒に保存します。履歴の取得、失敗評価の手動再実行、面接削除を正式HTTPとローカルD1で検査しました。削除後の通常キュー・DLQ通知は削除済みとして処理します。

- [x] 同時開始の一件制限、断片保存の冪等性、終了再送の同一jobId、削除後の結果拒否を一つずつRed/Greenで検証する。
- [x] Drizzleを変更し、`pnpm db:generate`で生成したSQLをレビューする。独立test環境で適用し、開発DBをリセットしない。
- [x] 一覧・詳細・削除・評価再実行のTypeSpecと生成validator、対応するWeb処理を実装する。

## タスク3：面接DOと音声アダプター

実装順序の調整：利用者のモック優先の指示に合わせ、DB・DOへ接続する前に、純粋な状態遷移を`apps/interview/src/domain/interview-state.ts`と`tests/interview-state.test.ts`で実装しました。開始確認・一時停止・切断・引き継ぎ・期限・終了保存の状態を検証済みです。音声アダプターは単体で実装済みですが、DOへの組み込みは未実施です。

ファイル：`apps/interview/src/interview-object.ts`、`src/application/interview-session.ts`、`src/server/live-connection.ts`、対応する`tests`、`packages/api-contracts/events`。

インターフェース：DOはstart、audio、pause、resume、takeover、rephrase、skip、finishを受ける。上流アダプターは接続・音声送信・イベント購読・終了を提供し、テストでは同じ境界をモック化する。

- [x] 開始確認前の音声拒否、古い世代拒否、停止中の計測停止、5分・1分の期限、終了時の保存待ちを一つずつRed/Greenで実装する。
- [x] 上流の文字起こしと音声イベントを検証し、原文断片・再生確認・欠落状態を保存する。
- [x] GPT-Liveへの接続・store:false・ツール無効化を実装し、実接続は行わずモック接続で確認する。

音声アダプターは固定URLへの認証付き接続、開始確認、PCM送受信、文字起こし、利用時間、言い換え・見送り、終了待ちを扱います。開始30秒・上流終了15秒、受信量の上限を設け、保存コールバックを直列に待ちます。上流イベントと送信イベントの型・validatorは`packages/api-contracts/events`のTypeSpecから生成します。実APIへの接続はまだ行っていません。

再開文脈は材料を指示から分離し、発言原文を維持して組み立てます。現段階ではモデル専用tokenizerを導入せず、UTF-8バイト数とメッセージ分の余白を合わせた8000の保守的な上限を使います。APIの8192トークン上限とは異なる制約で、超過時にはDOが面接を終了し、保存済みの原文を評価へ渡します。実際に会話できる分量は実機で確認します。

## タスク4：正式評価Consumer

ファイル：`apps/evaluation/src/worker.ts`、`src/domain/evaluation-result.ts`、`src/application/evaluate-interview.ts`、`src/server/openai-interview-evaluator.ts`、対応する`tests`と正式Queue結合検査。

インターフェース：`evaluateInterview(jobId, signal)`は固定された入力を読み、既存`consumeJob`が保存できる評価結果を返す。診断結果と正式評価結果を用途で区別する。

- [x] モックAIで5軸、未確認・対象外、引用整合、回答なし、拒否・不正出力・一時失敗を一つずつRed/Greenで実装する。
- [x] 既存の実行権・試行制御と正式Queueへ接続し、画面終了後の継続、再試行、手動再実行を検証する。

## タスク5：画面・音声入出力・ローカル起動

ファイル：`apps/web/src/routes`の面接画面とAPI、`src/lib/practice*.ts`と`src/components/practice-*.tsx`、対応する`tests`、`tools/local-integration/src/runtime.ts`と環境設定。

インターフェース：生成HTTP型と音声イベント型を画面で利用する。AudioWorkletのcapture/playbackをテスト用アダプターへ差し替え可能にし、製品画面にモック専用操作を含めない。

- [x] ファイル選択では送信せず確認操作で分析すること、テーマ選択・開始・停止・終了・結果表示をDOM操作でRed/Green検証する。
- [x] マイク拒否・接続失敗・古い応答・画面破棄を検証し、ブラウザ実機の操作は要求しない。
- [x] localhost保護、利用量予約、秘密値のメモリ注入を実装し、架空値の到達範囲・成果物非混入を検査する。
- [x] テスト専用Consumerが正式経路を横取りしないよう構成を分け、診断の既存回帰を維持する。

## タスク6：結合検査と最後の実機確認

- [x] モック音声AI・評価AIと本物のローカルWorkers・D1・Queueで材料→面接→評価を確認する。
- [x] `pnpm check`、`pnpm test:integration:pr`、`pnpm test:realtime`を実行し、失敗は原因を調べて修正する。
- [x] 全体レビューと起動手順・実装状況の文書更新を行う。
- [ ] 最後にモデル権限・秘密値の設定を確認し、指定Markdownと本人のブラウザ・マイクで実AIを通す。自動検査との違いを確認する。

実機確認前は「実装・自動検査まで」と報告し、目標全体を完了とは扱わない。
