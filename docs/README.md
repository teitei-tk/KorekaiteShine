# ドキュメントの案内

この文書群は、開発者本人と開発を支援するエージェントが、合意済みの要件と選定理由を確認するためのものです。本文は日本語で記述します。製品名、API名、ファイル名は公式の表記を使います。

2026年10月24日時点の設計相談を整理した文書です。アプリは未実装で、技術連携も未検証です。文書の作成は実装・依存追加・クラウド作成の承認を意味しません。

## 読む順序

1. [用語集](../GLOSSARY.md)：プロジェクト固有の言葉の意味。
2. [MVP仕様書](spec/mvp.md)：目的、合意済みの動作、採用構成、未確定事項。
3. 関係するADR：現在の選択に至った理由と引き受ける負担。
4. [技術調査記録](research/platform-integration.md)：公式資料の根拠と、実動作で確認すべき事項。

AIコードレビューは[導入設計](research/ai-code-review.md)と[初期設定・確認手順](runbooks/ai-review.md)を参照してください。Workflowは実装済みですが、実アカウントのWIF認証・モデル呼び出し・投稿は未検証です。

エージェントによる認証設定の確認・調査結果の扱い・レビュー委譲は[エージェント作業手順](runbooks/agent-workflow.md)を参照してください。

## 設計判断の記録

| ADR                                               | 判断                                                         |
| ------------------------------------------------- | ------------------------------------------------------------ |
| [0001](adr/0001-server-relayed-interviews.md)     | 音声をサーバーで中継し、面接ごとのDOで状態を管理する         |
| [0002](adr/0002-queued-evaluation.md)             | 評価をQueuesとDLQで音声面接から分離する                      |
| [0003](adr/0003-immutable-evaluation-evidence.md) | 評価の根拠を固定し、追記メモを分離する                       |
| [0004](adr/0004-tanstack-start-with-void.md)      | TanStack Startをアプリの土台とし、VoidでCloudflareへ配置する |

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
