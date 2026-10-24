# 文書検査

文書変更時に、リポジトリルートから次を実行します。Node.jsはルートの[.node-version](../../.node-version)に合わせ、pnpm 12.15.0を使います。依存は文書検査専用のこのディレクトリで管理します。

```sh
pnpm --dir tools/docs install --frozen-lockfile --ignore-scripts
pnpm --dir tools/docs typecheck
pnpm --dir tools/docs test
pnpm --dir tools/docs check
```

pnpmは`package.json`の`packageManager`で固定します。検査ツールとテストはTypeScriptで記述し、Node.jsの型除去機能で直接実行します。`typecheck`で型検査を別途行います。

## 検査する内容

- Markdownの書式：markdownlintを使用します。日本語の段落・長いURLのため行長制限を無効にし、表の列幅揃えも要求しません。同名の見出しは同じ階層の兄弟間で検査します。
- 番号付きリストの開始番号は制約しません。仕様書のユーザーストーリーは、見出しをまたぐ通し番号を維持します。
- 相対リンク：Markdownの構文解析によりリンク・画像・参照形式リンクを読み取り、ファイルの存在を確認します。
- 見出しアンカー：日本語、見出し内の装飾やコード、重複見出しの連番を含め、GitHub形式のアンカーを確認します。

対象はGit管理対象と未追跡のMarkdownです。Gitで除外した依存・生成物は対象外です。検査コマンドは文書を変更しません。

外部URLには接続せず、到達性や資料の正確さは検査しません。HTMLで独自に付けたアンカー、Markdown以外へのフラグメントリンクは未対応です。仕様・ADRの意味の整合性と合意事項の網羅性は、人またはレビュー担当エージェントが確認します。

## CI

GitHub Actionsでも`.node-version`からNode.jsのバージョンを読み取り、同じテストと検査を実行します。PRとmainへのpushを対象にし、ジョブの権限はリポジトリの読み取りだけです。実行にアプリのAPIキーは不要です。既存のローカルgit-secretsフックは変更しません。
