# Codex セッション終了時の Docker コンテナ削除の実装計画

> 実装者は `superpowers:executing-plans` を使い、各タスクをリポジトリの Red/Green TDD 手順で進めます。

## 目的と設計

KorekaiteShine のローカル Codex セッションで専用コマンドから作成した使い捨てコンテナを、同じセッションの `SessionEnd` で削除します。実装には既存の Node.js と Docker CLI を使います。

セッション ID をプロジェクト固有の Docker ラベルに記録します。終了フックと手動再実行は同じ削除コマンドを呼び出します。通常の開発手順には常駐 Docker サービスの定義が見当たらないため、新しい起動コマンドを任意で使う構成とします。[MVP 仕様書の設計基準](../../spec/mvp.md#設計基準)と[ADR 0009](../../adr/0009-explicit-environments.md)の実行単位の分離に沿うローカル開発ツールです。

## 対象と制約

- ローカルで動作する Codex と Unix ソケットで接続する Docker を対象とします。現在のマシンでは Docker CLI が導入済みで、選択中のコンテキストは `orbstack` です。
- 削除対象は `io.github.teitei-tk.korekaite-shine.codex-session=<session_id>` に完全一致するコンテナです。起動済み・停止済みの両方を対象とし、削除コマンドの引数は照合済みの完全なコンテナ ID に限定します。既存の共有コンテナ、イメージ、ボリュームには変更を加えません。
- `SessionEnd` は正常終了、開いている会話のアーカイブ・削除などで発火します。会話を切り替えただけの場合は即時には発火しません。強制終了などでフックが実行されない場合や、最大3秒の実行枠内に処理できない場合は、セッション ID を指定して手動再実行します。[Codex Hooks](https://developers.openai.com/codex/hooks#sessionend)
- 操作が短時間で完結するコンテナは `docker run --rm` も使えます。同じセッションで複数の応答や追加指示をまたいで使うコンテナには専用の起動コマンドを使います。

## 1. 起動時に所有セッションを記録する

ファイルは `tools/codex-docker/session.mjs`、`tools/codex-docker/session.test.mjs`、ルートの `package.json` です。

- [x] 現行 Codex で、ツールのシェル環境の `CODEX_THREAD_ID` と終了フックの標準入力に含まれる `session_id` が一致することを診断用フックで確認します。ID の一致判定だけを記録し、Docker への書き込みは行いません。このチャットのシェルでは UUID 形式の環境変数を確認済みです。使用するクライアントで ID が取得できない、または一致しない場合は、ラベル付き起動を有効にする前に ID の受け渡しを再設計します。
- [x] Docker CLI を差し替えたテストを追加し、`run IMAGE [COMMAND ...]` が `CODEX_THREAD_ID` を含むラベルを付けてコンテナを起動すること、および ID が空・不正な場合は Docker を呼ばないことを確認します。ルートの `pnpm test` に `node --test` の実行を組み込み、テストを一件ずつ Red/Green で追加します。
- [x] `node tools/codex-docker/session.mjs run IMAGE [COMMAND ...]` を実装します。Docker の起動引数はスクリプトで組み立て、利用者の引数はイメージとコンテナ内コマンドとして渡します。`docker run --detach` の成功時はコンテナ ID を返します。
- [x] 起動と削除で `~/.config/korekaite-shine/docker-context` に記載した同じ Docker コンテキスト名を指定します。未設定、存在しない名前、Unix ソケット以外の接続先では起動・削除を失敗させます。選択中のコンテキストを切り替えても明示した接続先を使うことをテストします。

## 2. 所有コンテナを終了フックから削除する

ステップ1のスクリプトとテストに削除処理を追加します。フック設定の例は `tools/codex-docker/hooks.example.json`、導入と手動再実行の手順は `docs/runbooks/agent-workflow.md` に置きます。

- [x] `node tools/codex-docker/session.mjs cleanup` は標準入力の `SessionEnd` JSON から `session_id` を読む契約とし、`cleanup --session ID` は同じ処理を手動で実行する契約とします。偽の Docker CLI を使い、2つのセッションとラベルなしのコンテナから、終了したセッションの起動済み・停止済みコンテナだけが削除されることを確かめます。
- [x] 入力のイベント名と ID を検証し、`docker ps --all --quiet --no-trunc --filter label=…` で列挙して、結果が完全なコンテナ ID であることを確認してから `docker rm --force` に渡します。対象が0件なら成功とし、Docker が停止中の場合や列挙・削除が失敗した場合は非ゼロで返します。途中で一部を削除できた場合も、再実行は残っている同じラベルのコンテナに作用します。不正な入力、空の結果、部分失敗後の再実行をそれぞれテストします。
- [x] 設定例に同期 `SessionEnd` のコマンドと `timeout: 3` を登録します。Git ルートを使ってスクリプトを解決し、サブディレクトリから開始したセッションでも呼び出せるようにします。利用者が `.codex/hooks.json` に既存の定義と併合し、Codex 上でフックを信頼する手順を記載します。セッション ID を起動時に控え、Docker の不調時に `cleanup --session ID` を実行する手順も記載します。

## 受け入れ確認

- [x] `pnpm test` の Red/Green を確認し、最後に `pnpm check` を実行します。
- [x] ローカル Docker と検証用 Codex セッションで、同じイメージからセッション A・B のコンテナとラベルなしの対照コンテナを作ります。A の応答完了時点では A が残り、A の正常終了またはアーカイブ後に A だけが消えることを確認します。3秒の制限、フック実行時の Node.js と Docker の解決、手動再実行も確認し、使用クライアントと検証結果を運用手順に記録します。
