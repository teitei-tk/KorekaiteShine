# 文書検査

文書変更時に、リポジトリルートから次を実行します。Node.jsはルートの[.node-version](../../.node-version)に合わせ、pnpm 12.15.0を使います。文書検査の依存宣言はこのディレクトリに置き、ロックファイルはルートで共有します。

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
```

pnpmはルートの[package.json](../../package.json)の`packageManager`で固定します。検査ツールとテストはTypeScriptで記述します。検査ツールはNode.jsの型除去機能で直接実行し、テストはVitestで実行します。`typecheck`で型検査を別途行います。

`pnpm check`はNode.js設定の整合性・Lint・整形確認・型検査・Vitest・文書検査を順に実行し、失敗時に停止します。型検査とVitestはアプリ・共有パッケージ・ツールを依存順に直列検査します。固定版Vitestがロックファイル変更時に共有キャッシュを削除するため、パッケージ間の同時削除を避けます。AIレビューの設定は[専用手順](../../docs/runbooks/ai-review.md)を参照してください。個別には`pnpm check:node`、`pnpm typecheck`、`pnpm test`、`pnpm check:docs`を使えます。

リポジトリ全体にoxlintとoxfmtを使用します。ルートの`pnpm lint`でLint、`pnpm format:check`で整形確認、`pnpm format`で整形を実行できます。設定はルートの[.oxlintrc.json](../../.oxlintrc.json)と[.oxfmtrc.json](../../.oxfmtrc.json)、固定バージョンはルートの[package.json](../../package.json)で管理します。各ツールの対応ファイルを対象とし、依存・生成物などGitの除外対象は検査しません。自動生成の`pnpm-lock.yaml`と`.github/workflows/actions.lock`は整形対象から除外し、それぞれ専用ツールで管理します。oxlintはcorrectnessをエラーとして検査し、警告も終了コードを失敗にします。型検査は従来のTypeScriptを併用します。CIが呼ぶ`pnpm check`では整形の書き換えを行いません。

ネットワークとGitHub認証が必要なActions検証は`pnpm check:actions`に分けます。CIのActions検証ジョブはNode.js・pnpmの準備に依存しないよう、同じ`gh actions-lock --verify`を直接実行します。

## 文書内のコマンド検査

`pnpm check:docs`は、インラインコードと`sh`・`shell`・`bash`・`zsh`コードブロックの各行の先頭にあるpnpm呼び出しを検査します。`pnpm <script>`、`pnpm run <script>`、それぞれの`--dir <path>`付き形式が対象です。対象の`package.json`の`scripts`に名前があるかを確認し、欠落時は文書名と行を報告します。既存の文書検査CIで実行されます。

作業ディレクトリはリポジトリルートを基準にします。子パッケージのコマンドは`--dir`で明示してください。パスは空白・引用符を含まない相対パスに対応します。固定版pnpm 12.15.0の`--help`に掲載された組み込み操作と別名、および組み込み操作を明示する`pm`は除外します。`test`（`t`・`tst`を含む）・`start`・`stop`・`restart`はスクリプトとして照合します。`run`（`run-script`を含む）で明示した名前は組み込み操作と同名でも検査します。pnpm更新時は組み込み一覧を照合してください。引数、シェルの連結・変数展開、その他のオプション形式、外部CLIの実在や説明との意味上の一致は検査しません。コマンド自体は実行しません。

## commit・push前の検査

[Lefthook設定](../../lefthook.yml)で、commit前とpush前の両方に`pnpm lint`、`pnpm format:check`、`pnpm test`を実行します。検査が失敗すると操作を中止します。作業ツリー全体が対象で、整形の自動修正や自動stageは行いません。部分stage時も未stageの内容を含むため、commit対象そのものの検証はCIでも行います。

clone後は依存をインストールし、フックを明示的に有効化してください。依存のインストールスクリプトは許可しません。

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm hooks:install
```

既存の秘密値検査を維持するため、pre-commitでは`git secrets --pre_commit_hook`も実行します。`git-secrets`を利用可能にし、既存の検出ルールを維持してください。Lefthook導入時に既存pre-commitは`pre-commit.old`へ退避されますが、検査自体はLefthookのコマンドとして実行します。既存のcommit-msg・prepare-commit-msgフックは変更しません。`git secrets --install --force`でpre-commitを上書きしないでください。

Lefthookは2.2.1に固定しています。2026年10月24日の導入時、2.2.2はpnpmの`trustPolicy: no-downgrade`に拒否されたため、保護設定を維持して直前の版を採用しました。[公式のインストール手順](https://lefthook.dev/usage/commands/install/)に沿って、CIではなく開発者のcloneでフックを有効化します。

## 検査する内容

- Node.js設定：`.node-version`がルートおよび各パッケージに宣言された`engines.node`の範囲内か、`@types/node`が同じメジャーか、各ワークフローの`actions/setup-node`が`.node-version`を参照しているかを検査します。Git管理対象と未追跡ファイルを対象にし、依存・生成物はGitの除外設定に従います。

- Markdownの書式：markdownlintを使用します。日本語の段落・長いURLのため行長制限を無効にし、表の列幅揃えも要求しません。同名の見出しは同じ階層の兄弟間で検査します。
- 番号付きリストの開始番号は制約しません。仕様書のユーザーストーリーは、見出しをまたぐ通し番号を維持します。
- 相対リンク：Markdownの構文解析によりリンク・画像・参照形式リンクを読み取り、ファイルの存在を確認します。
- 見出しアンカー：日本語、見出し内の装飾やコード、重複見出しの連番を含め、GitHub形式のアンカーを確認します。

対象はGit管理対象と未追跡のMarkdownです。Gitで除外した依存・生成物は対象外です。検査コマンドは文書を変更しません。

外部URLには接続せず、到達性や資料の正確さは検査しません。HTMLで独自に付けたアンカー、Markdown以外へのフラグメントリンクは未対応です。仕様・ADRの意味の整合性と合意事項の網羅性は、人またはレビュー担当エージェントが確認します。

## 依存のサプライチェーン対策

設定はルートの[pnpm-workspace.yaml](../../pnpm-workspace.yaml)で管理します。`packages`で`tools/*`・`apps/*`・`packages/*`を対象にするため、将来追加するアプリにも共通の保護設定が適用されます。各パッケージには`package.json`を置き、入れ子の`pnpm-workspace.yaml`で別ワークスペースに分離しない方針です。現在は[Webアプリ](../../apps/web/README.md)と3 Workersのローカル接続を実装しています。正式な面接・実AI・クラウド配置は後続範囲です。

- `minimumReleaseAge: 1440`：公開後24時間待ちます。条件を満たす版がない場合や公開日時を確認できない場合は失敗させます。
- `strictDepBuilds: true`：通常のインストールで未審査の依存ビルドが見つかったら失敗させます。上記手順とCIの`--ignore-scripts`は別途維持し、インストールスクリプトを実行しません。
- `allowBuilds.lefthook: false`：Gitフックを自動登録するインストールスクリプトを明示的に拒否します。未審査としてのエラーを防ぎ、フックの登録は`pnpm hooks:install`で行います。
- `blockExoticSubdeps: true`：推移依存からの未信頼なGit・tarball URL等を制限します。直接依存の取得元は別途レビューします。
- `trustPolicy: no-downgrade`：以前の公開版より信頼情報が弱い版を拒否します。すべてのパッケージにprovenanceを要求する設定ではありません。
- `trustLockfile: false`：ロック済み依存も待機期間・信頼情報の検証対象にします。

例外指定は追加していません。拒否された場合は対象版と理由を確認し、設定全体を無効化して回避しません。待機期間は攻撃の検出猶予であり、安全性の保証ではありません。緊急の修正版も待機対象になります。

仕様の根拠：[pnpm依存解決設定](https://pnpm.io/settings/dependency-resolution)、[ビルド設定](https://pnpm.io/settings/build)。

### CIのTakumi Guard

通常CI、Workerの実時間検査、AIレビュー、隔離受入検査では、公式の`setup-takumi-guard-npm` v1.4.0をpnpmの準備前に実行します。npm依存の取得先をTakumi Guardへ向け、匿名モードで悪性パッケージを拒否します。アカウント・トークン・Guard用のOIDC権限は不要です。ローカルのregistry設定は変更しません。

各対象ジョブで有効なnpm・pnpmのregistryを確認し、通常CIの`Repository lint and format`では[遮断確認](check-guard.ts)も実行します。空の一時キャッシュで正常なパッケージの取得と公式の確認用パッケージの拒否を確認し、一時ファイルを削除します。接続障害、一般的な403、予期しない取得成功は失敗にします。外部通信を伴うため、遮断確認は`pnpm test`や`pnpm check`には含めません。

Guard設定済みのCI環境では、次で再確認できます。ローカルで未設定ならregistry確認で停止します。

```sh
node tools/docs/check-guard.ts --registry-only
node tools/docs/check-guard.ts
```

取得済み依存が現在のGuard判定を迂回しないよう、対象ジョブのpnpm storeキャッシュ復元とsetup-nodeの自動キャッシュを無効にしています。GitHub-hosted runnerの使い捨て環境を前提とし、pnpm Action自身のstoreキャッシュも既定の無効状態で使います。再実行では依存を再取得するため、通信量と所要時間が増えます。Guardの拒否・障害時は対象版と応答を確認し、必要に応じて復旧後に再実行してください。npm公式レジストリへの自動切替は行いません。

匿名モードには取得履歴と事後通知がありません。scope別registryや直接URLの依存は別途レビューし、GitHub Releases・apt・Actions本体の取得はGuardの保護範囲外として扱います。固定版の確認結果と未検証範囲は[検証記録](../../docs/research/takumi-guard.md)、将来のShisho CloudへのOIDC移行は[導入設計](../../docs/superpowers/specs/2026-11-07-takumi-guard-design.md#将来のshisho-cloud連携)を参照してください。

## Dependabotによる依存更新

[Dependabot設定](../../.github/dependabot.yml)で、`daily`（平日9時、日本時間）にnpm依存とGitHub Actionsの更新を確認します。更新PRの上限はそれぞれ10件です。メジャー更新も対象とし、自動マージは設定しません。

npmの設定はルートの共有ロックファイルを起点にします。現在の`tools/docs`と、今後同じpnpmワークスペースへ追加する`apps/*`の依存を対象にします。別の言語や独立したロックファイルを採用するアプリには、対応する設定を追加してください。通常のnpm更新には公開後1日の待機期間を設け、CIでも既存のpnpm保護設定を確認します。

2026年10月24日の[GitHub公式の対応表](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#package-ecosystem)にはpnpm v7〜v10が掲載されており、本リポジトリのpnpm 12.15.0は対応表にありません。設定をデフォルトブランチへ反映した後、Dependabotの実行ログでマニフェストの検出とロック更新の成否を確認してください。現時点ではpnpm 12での自動更新は未検証です。

Actions更新PRでは`uses:`と[Actionsのロック](#actionsのロック)を合わせて確認します。`actions.lock`が更新されていなければ、PRのブランチで`gh actions-lock`と`gh actions-lock --verify`を実行し、生成結果を同じPRへ追加します。ロック検証が通るまでマージしません。

`.node-version`のNode.js、`packageManager`のpnpm本体、シェル内で固定した`gh-actions-lock`の版は、この設定による自動更新を保証しません。これらは関連設定と互換性を確認して別途更新します。更新PRは`pnpm check`とActionsロック検証の成功後にレビューします。

## CIでの実行

GitHub Actionsでも`.node-version`からNode.jsのバージョンを読み取り、同じテストと検査を実行します。PRとmainへのpushを対象にし、ジョブの権限はリポジトリの読み取りだけです。実行にアプリのAPIキーは不要です。ローカルのgit-secretsによるpre-commit検査はLefthookから実行します。

[ci.yml](../../.github/workflows/ci.yml)の`CI`内で、次のジョブを並列実行します。

| ジョブ              | 検査範囲                                             |
| ------------------- | ---------------------------------------------------- |
| `lint-format`       | ルート設定を含む全体のLint・整形チェック             |
| `apps`              | アプリのビルド・型検査・単体テスト                   |
| `packages`          | 共有パッケージの生成・型検査・テスト                 |
| `tools`             | ローカル結合検証を除く開発ツールの型検査・単体テスト |
| `local-boundaries`  | DO・D1境界テスト、開発・ビルド済みWorkerのHTTP契約   |
| `local-integration` | 実時間の接続・回復・環境分離テスト                   |
| `docs`              | Node.js設定・文書・リンク・見出し検査                |
| `verify-lockfile`   | Actionsロック検証                                    |

ジョブ間では生成物を共有せず、型検査・テストを行う各ジョブで共有契約を生成します。`apps/interview`と共有D1の実行境界テストは`tools/local-integration/tests`にあるため、`local-boundaries`が担当します。`local-integration`の各分割は開発DB保持確認の準備と、通常結合14件の担当分だけを実行します。長時間1件は別ワークフローが担当します。

通常検査の上限は15分、`local-boundaries`と`local-integration`はそれぞれ25分です。境界4分割と結合3分割に順序依存はなく、別runnerで並列実行します。旧ジョブでは依存インストール・ビルド・型検査後の通常テスト中に5分上限へ達したため、分割後も実行時間を確保します。CIでは整形を書き換えず、実AIやCloudflareクラウドへ接続しません。ローカルの全体検査入口は`pnpm check`です。 所要時間の内訳と環境共有の測定結果は[CI性能の検証記録](../../docs/research/ci-worker-test-performance.md)を参照してください。

文書検査ジョブでは、Markdown・`tools/docs/**`・Workflow・各`package.json`・共有の依存設定・Node.js設定・Markdown/Lint/整形設定・Git除外設定に変更がある場合だけ、依存インストールと検査を実行します。相対リンク切れを確認するため、任意のファイルの削除・移動も対象です。PRは分岐点からheadまで、mainへのpushはpush前後を比較し、比較元が取得できない場合は検査します。対象外の場合もジョブは起動し、検査ステップをスキップして成功します。他のジョブは変更パスで省略しません。文書検査ツール自体の型検査・テストは`tools`が担当します。

有料のAIレビューを行う後続Workflowは、`CI`全体が成功した場合だけ対象PRを確認します。旧名からの切り替えと移行PRの制約は[AIレビュー運用手順](../../docs/runbooks/ai-review.md#ciの名称移行)を参照してください。

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

## 型の禁止ルール

`pnpm lint`はoxlintの`typescript/no-restricted-types`で、リポジトリ内の`unknown`型を拒否します。コメント・文字列は対象外です。既存のcommit・pushフックとCIでも同じLintを実行します。`lint-policy.test.ts`で、単独・オブジェクト内・型引数の禁止と、コメント・文字列の許可を確認します。

外部入力には具体的な入力型を付け、実行時の形式検証を維持してください。型アサーションだけではJSONやAPI応答を検証したことになりません。

## 4指標のカバレッジ検査

`pnpm test:coverage`でAPI生成・保持確認の準備・通常テスト・結合テストを実行し、行・文・関数・分岐の計測結果を`coverage/combined/`へ保存します。生成物・型宣言・テスト補助コードは対象外です。実行されない手書きコードも台帳に残します。

`pnpm check:coverage`は、現在のコミット・対象集合・元ソースと計測コードのハッシュが一致する保存結果だけを検査します。全体と各ファイルの4指標を実数で判定し、1件でも未網羅なら失敗します。必須suiteの欠落、失敗・未完了の収集、空のレポートも成功扱いしません。計測要素がない個別ファイルは理由を記録し、到達済みには数えません。

通常CIの境界4分割・結合3分割と、各パッケージの型検査・テストは維持します。両コマンドは独立した`Worker real-time checks`で順に実行し、長時間の全体計測と100%判定を担当します。計測器や変換設定を更新した場合は、分母の変化を[調査記録](../../docs/research/test-coverage.md)と照合してください。

通常CIは境界4分割と通常結合3分割を含みます。450秒の再試行待機1件と全体カバレッジ検査は `Worker real-time checks` に分離し、夜間・手動・関連変更のPRで実行します。通常CIの成功と長時間検査の結果は独立しています。全件のローカル検査は引き続き `pnpm check`、`pnpm prepare:integration`、`pnpm test:integration` です。
