# AIレビューのGPT-6.2 Sol切替計画

> 実装は `superpowers:executing-plans` の手順に従い、各変更をRed/Greenで確認する。

通常レビューでGPT-6.2 Solの`medium`を使う。[現行の生成仕様](../../spec/ai-review.md#公式actionによる生成)と[ADR 0005](../../adr/0005-partitioned-ai-review.md#公式actionへの置換)に従い、公式Action・CLI・WIFプロキシの固定版、認証境界、15分の実行枠と投稿再開の契約を維持する。

## 設定とローカル検査

- [x] `tools/ai-review/workflow.test.ts`で、通常生成とWIF検証が`gpt-6.2-sol`、`medium`を使うことを検査する。`pnpm test`で旧設定による失敗を確認する。
- [x] `.github/workflows/ai-review.yml`の2箇所と、`tools/ai-review`内のCodex設定、WIF検証の期待値、コメントのモデル表記を揃える。WIF要求の検査では推論強度も照合する。
- [x] [正式仕様](../../spec/ai-review.md)と[運用手順](../../runbooks/ai-review.md)を更新する。`pnpm test`と`pnpm check`を実行する。

## 実接続と比較

- [ ] 通常レビューを停止した状態で、承認されたGitHub上のmain反映後、指定したmainのCI実行から既存のWIF限定検証を1回実行する。SolのSchema出力、利用量、対象Organizationのクレジット消化を確認する。
- [ ] 修正済みの不具合を含む過去PRを2〜3件選び、差分・履歴・プロンプトを固定する。LunaとSolの`medium`の出力を投稿せずに比較し、検出、誤指摘、15分以内の完走、費用を記録する。
- [ ] 検証結果を確認してから通常レビューを有効化する。運用停止には`AI_REVIEW_MODE=off`、Lunaへの復帰には設定変更のrevertを使う。
