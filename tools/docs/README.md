# 文書検査

文書変更時に、リポジトリルートから次を実行します。Node.jsはルートの[.node-version](../../.node-version)に合わせ、pnpm 12.15.0を使います。文書検査の依存宣言はこのディレクトリに置き、ロックファイルはルートで共有します。

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
```

pnpmはルートの[package.json](../../package.json)の`packageManager`で固定します。検査ツールとテストはTypeScriptで記述します。検査ツールはNode.jsの型除去機能で直接実行し、テストはVitestで実行します。`typecheck`で型検査を別途行います。

`pnpm check`はNode.js設定の整合性・型検査・Vitest・文書検査を順に実行し、失敗時に停止します。個別には`pnpm check:node`、`pnpm typecheck`、`pnpm test`、`pnpm check:docs`を使えます。

ネットワークとGitHub認証が必要なActions検証は`pnpm check:actions`に分けます。CIのActions検証ジョブはNode.js・pnpmの準備に依存しないよう、同じ`gh actions-lock --verify`を直接実行します。

## 検査する内容

- Node.js設定：`.node-version`がルートおよび各パッケージに宣言された`engines.node`の範囲内か、`@types/node`が同じメジャーか、各ワークフローの`actions/setup-node`が`.node-version`を参照しているかを検査します。Git管理対象と未追跡ファイルを対象にし、依存・生成物はGitの除外設定に従います。

- Markdownの書式：markdownlintを使用します。日本語の段落・長いURLのため行長制限を無効にし、表の列幅揃えも要求しません。同名の見出しは同じ階層の兄弟間で検査します。
- 番号付きリストの開始番号は制約しません。仕様書のユーザーストーリーは、見出しをまたぐ通し番号を維持します。
- 相対リンク：Markdownの構文解析によりリンク・画像・参照形式リンクを読み取り、ファイルの存在を確認します。
- 見出しアンカー：日本語、見出し内の装飾やコード、重複見出しの連番を含め、GitHub形式のアンカーを確認します。

対象はGit管理対象と未追跡のMarkdownです。Gitで除外した依存・生成物は対象外です。検査コマンドは文書を変更しません。

外部URLには接続せず、到達性や資料の正確さは検査しません。HTMLで独自に付けたアンカー、Markdown以外へのフラグメントリンクは未対応です。仕様・ADRの意味の整合性と合意事項の網羅性は、人またはレビュー担当エージェントが確認します。

## 依存のサプライチェーン対策

設定はルートの[pnpm-workspace.yaml](../../pnpm-workspace.yaml)で管理します。`packages`で`tools/*`と`apps/*`を対象にするため、将来追加する`apps/worker`・`apps/frontend`にも共通の保護設定が適用されます。各パッケージには`package.json`を置き、入れ子の`pnpm-workspace.yaml`で別ワークスペースに分離しない方針です。アプリのディレクトリや雛形はまだ作成していません。

- `minimumReleaseAge: 1440`：公開後24時間待ちます。条件を満たす版がない場合や公開日時を確認できない場合は失敗させます。
- `strictDepBuilds: true`：通常のインストールで未審査の依存ビルドが見つかったら失敗させます。上記手順とCIの`--ignore-scripts`は別途維持し、インストールスクリプトを実行しません。
- `blockExoticSubdeps: true`：推移依存からの未信頼なGit・tarball URL等を制限します。直接依存の取得元は別途レビューします。
- `trustPolicy: no-downgrade`：以前の公開版より信頼情報が弱い版を拒否します。すべてのパッケージにprovenanceを要求する設定ではありません。
- `trustLockfile: false`：ロック済み依存も待機期間・信頼情報の検証対象にします。

例外指定は追加していません。拒否された場合は対象版と理由を確認し、設定全体を無効化して回避しません。待機期間は攻撃の検出猶予であり、安全性の保証ではありません。緊急の修正版も待機対象になります。

仕様の根拠：[pnpm依存解決設定](https://pnpm.io/settings/dependency-resolution)、[ビルド設定](https://pnpm.io/settings/build)。

## CIでの実行

GitHub Actionsでも`.node-version`からNode.jsのバージョンを読み取り、同じテストと検査を実行します。PRとmainへのpushを対象にし、ジョブの権限はリポジトリの読み取りだけです。実行にアプリのAPIキーは不要です。既存のローカルgit-secretsフックは変更しません。

### Actionsのロック

[gh-actions-lock](https://github.com/github/gh-actions-lock) v0.4.0で[actions.lock](../../.github/workflows/actions.lock)を生成します。ワークフローの`uses:`には具体的なタグを残し、完全なコミットSHAと取得元の識別情報はロックファイルで固定します。

GitHub CLIの認証後、リポジトリルートで実行します。

```sh
gh extension install github/gh-actions-lock --pin v0.4.0
gh actions-lock
gh actions-lock --verify
```

拡張を導入済みの場合はインストールを省略します。ワークフローや`uses:`を変更したら再生成し、ワークフローとロックファイルの差分を一緒にレビューします。ロックファイルは手編集しません。CIも固定版のツールで`--verify`を実行し、読み取り専用の`github.token`をそのステップにだけ渡します。

既存の参照先を更新する場合は`gh actions-lock --relock`を使い、変更されたSHAと更新理由を確認します。`--accept-moved`で自動的に受け入れる運用は行いません。`--verify-local`はネットワーク不要の対応関係の検査であり、取得元を確認する`--verify`の代わりにはしません。

このツールは公開プレビューです。更新時はツールの版・ロック形式・CIの互換性を確認します。シェル内で導入するCLIやnpm依存はActionsロックの対象外であり、別途バージョン固定とpnpmの保護設定を維持します。
