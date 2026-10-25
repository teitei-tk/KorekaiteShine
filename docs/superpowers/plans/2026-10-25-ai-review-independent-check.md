# AIレビューを独立したWorkflowとして表示する

## 目的と境界

PRのチェック一覧で`Documentation checks / AI review`と表示される問題を解消する。Checks APIで登録したチェックは同じGitHub AppとSHAの既存suiteへ関連付けられ、作成APIでは所属Workflowを指定できない。`pull_request`で起動する専用の`AI review` Workflowのジョブを表示に使う。

PR側のジョブはbase SHAの信頼済みコードを実行し、Actions・PR・コードを読むだけにする。OIDCはmain上の生成ジョブ、コメント投稿権限は既存の投稿ジョブに限定する。Resolveは操作しない。PR #13はマージしない。

## 実装と検証の順序

1. 読み取り専用の監視コードと回帰テストを追加する。PR番号・head・base、起点CIの実行IDと最新試行、AI実行と最新試行を照合する。既存の成果物検証と固定理由コードを再利用する。この準備変更を先にmainへ反映し、後続PRがbaseのコードで動作できるようにする。
2. `ai-review-check.yml`を専用PR Workflowへ切り替える。通常CI成功後に起動するモデル実行と投稿は`ai-review.yml`に残す。監視中は実行中、投稿済み記録の検証後に成功、その他は対象と固定理由を概要・エラー注釈へ記録して失敗にする。
3. 仕様・運用手順とWorkflowの回帰テストを更新する。全体検査とActions lock検査を通し、PR経由でmainへ反映する。
4. 検証用PRで通常CIとAIレビューのsuiteが異なること、実行中から成功へ遷移することを確認する。検証用PRはmainへマージしない。

## 待機と再実行

15秒間隔・最大50分の監視を行う。API一覧は最大1,000実行で打ち切り、対象を発見できない場合も成功にはしない。待機にActions実行時間を使う負担を引き受ける。新しい認証情報や外部サービスは増やさない。

対象SHA変更、起点CI失敗、バックエンドのキャンセル・時間切れ、成果物欠落、試行の変更は誤った成功にしない。取得後にも対象と最新試行を再検証する。バックエンド再実行後は表示側も再実行する。ネイティブジョブ自身のキャンセルと、バックエンドのキャンセルを検出した監視ジョブの失敗を区別する。

## 根拠

- [Checks APIとsuiteの関連付け](https://docs.github.com/en/rest/guides/using-the-rest-api-to-interact-with-checks)
- [Workflowの実行とCheck Suite](https://docs.github.com/en/actions/how-tos/monitor-workflows/use-workflow-run-logs)
- [Check Runの作成API](https://docs.github.com/en/rest/checks/runs#create-a-check-run)
