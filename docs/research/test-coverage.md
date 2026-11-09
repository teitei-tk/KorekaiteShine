# テストカバレッジの実測と不足箇所

2026年11月6日、コミット`95e5230604b78f74f6066e46c79f73ac7a0af51a`を対象に、既存テストの行・文・関数・分岐カバレッジを計測しました。100%に向けて、計測経路が接続されていない範囲と、計測済みコードで実行されなかった箇所を分けて扱います。

## main統合後の検証

2026年11月8日、PR #83へmainの`fec4683f9c717638903cf3d2d2ade41a0c45b51b`を統合し、競合を解消しました。全体計測の実行IDは`cc48d43a-5da3-4a78-ac51-e7ea80df8407`で、158ファイル・1103テストが成功しました（783.60秒）。API型生成器のNode.js互換性テストも独立した必須suiteとして成功しています。

| 指標 | 網羅数／総数 | カバレッジ |
| ---- | ------------ | ---------- |
| 行   | 4033／4033   | 100%       |
| 文   | 4162／4162   | 100%       |
| 関数 | 758／758     | 100%       |
| 分岐 | 3104／3104   | 100%       |

対象は131ファイルで、実行要素がある127ファイルすべてが4指標100%、要素なしは4ファイルです。未実行位置は0件です。必須suiteは`inventory`・`generate`・`api-codegen`・`prepare`・`tests`で、元ソースと計測コードのハッシュを照合しています。統合元mainで追加された手書きコードも対象に含めており、以前の125対象の数値とは分母が異なります。

通常CIの境界4分割・結合3分割、Takumi Guard、依存更新、型生成器のCompiler API分離を維持しました。全体計測と100%判定は独立した`Worker real-time checks`で行います。従来のNode限定V8計測は`pnpm test:coverage:node`として残し、出力先を`coverage/node/`へ分けました。

定期実行はmainの単調時計方式へ統一し、早期発火・壁時計補正の回帰テストを維持しました。追加テスト16ファイルをmainのCI分割へ登録し、起動CLI・Guard・変更判定・依存フックの不足ケースも補っています。統合後の初回実行では旧Void 1.5.0を期待するテスト1件が失敗したため採用せず、mainの1.6.2に合わせて修正後に再検証しました。

型検査・Webビルド・Lint・整形・文書検査も成功しています。Actions参照はmainと同一です。ローカルでのActionsロックのオンライン検証はツール取得の403により未実施であり、CIの検証を別途確認します。

以下はmain統合前の履歴です。末尾のファイル別一覧は今回の統合後の実測です。

## main統合前の最終検証結果

2026年11月8日、計画に沿った追加と収集経路の接続を終え、同じソース・計測形式で全体計測を2回実行しました。各回とも通常テストと追加7結合テスト、Node子プロセス、実Workerの記録を同じ実行IDの台帳へ収集しています。

| 指標 | 網羅数／総数 | カバレッジ |
| ---- | ------------ | ---------- |
| 行   | 3903／3903   | 100%       |
| 文   | 4025／4025   | 100%       |
| 関数 | 732／732     | 100%       |
| 分岐 | 2984／2984   | 100%       |

- `cea6a77f-f461-4018-844d-126c39935555`：148ファイル・1061テスト成功（801.05秒）。
- `2f39c5d8-0488-4ca6-a318-5637088f10c0`：148ファイル・1061テスト成功（799.27秒）。

対象125ファイル中、実行要素がある121ファイルがそれぞれ4指標100%です。残る4ファイルは要素なしで、到達済みには含めません。未実行位置は0件で、2回の分母と網羅数は一致しました。

検証対象は基点コミット`95e5230604b78f74f6066e46c79f73ac7a0af51a`に今回の未コミット変更を加えた作業ツリーです。各対象の元ソース・計測コードのハッシュ一致を確認しており、異なる版の結果は合算していません。必須suiteは`inventory`・`generate`・`prepare`・`tests`です。

CIは既存の結合ジョブで`pnpm test:coverage`と`pnpm check:coverage`を順に実行します。全ファイルの4指標について実数で100%を必須とし、丸め表示、空レポート、収集失敗、対象やsuiteの欠落を成功扱いしません。Node設定、全パッケージの型検査、Lint、整形、文書検査も確認しています。Actions参照は変更していません。CIのリモート実行・クラウド変更は行っていません。

生成物・型宣言・テスト専用コードの除外範囲は維持しました。隔離・WIFの追加テストはローカルで境界を制御し、実公式サービスとの新たな接続検証とは区別しています。本番成果物への診断・計測コードの非混入は実ビルドの検査で確認しています。

以下の領域別・初回調査の数値は過去の履歴です。末尾のファイル別一覧は今回の最終結果です。

## 最終検証中に見つかった時刻境界

2026年11月8日、実行ID`2b30493e-15fc-4311-b0e1-d8e4d82f338c`の停止後回復テストで、初回の定期実行が再起動の59999ms後に記録されました。評価は1回で完了しましたが、60000ms以上待つという条件を1ms満たさず、全体検証は失敗としました。この実行は100%達成の証拠に採用しません。

タイマーを壁時計の期限より1ms早く発火させる境界テストで同じ失敗を再現し、ローカル統合検証の定期実行が開始前に期限を確認して残り時間を待つよう修正しました。検査の許容差は広げていません。関連43件、型検査・Lintが成功し、修正ファイルは行240・文242・関数21・分岐242の全要素を検証しました。

## タスク8完了時の全体実測

2026年11月8日、実行ID`a05c40ac-bbb7-449b-8116-6d4caf97e52b`で140ファイル・1017テストが成功しました（783.31秒）。対象125ファイルの行3867/3897（99.23%）、文3989/4019（99.25%）、関数722/729（99.03%）、分岐2954/2984（98.99%）です。全体100%は未達で、残る不足は計測ツール自身にあります。

AIレビュー領域31ファイルは4指標100%になりました。APIの異常応答、重複投稿、監視の終了条件、隔離設定の変更、PID不一致、起動・停止失敗を検証しています。隔離・WIF・モデル検証の追加テストは外部接続とroot操作の境界を制御したローカルテストです。公式Actionとの実接続や実資格情報での検証を新たに実行した結果ではありません。

元ソースCLIの相対importをTypeScriptへ統一し、隔離配布JavaScriptの再生成結果が一致することを確認しました。状態検証後の到達不能な補完と、全呼出しで指定されるprivate引数の任意扱いを整理したため、分母が変わっています。生成物・型宣言以外の対象を未網羅という理由で除外していません。

以下は過去の履歴です。最新のファイル別一覧は末尾に記載します。

## タスク7完了時の全体実測

2026年11月7日、実行ID`0b0d51e2-d8f3-4c11-bc0d-0c6eae2cf5b4`で全126ファイル・805テストが成功しました（864.09秒）。通常テストと追加7結合テスト、Node子プロセス、実Workerの計測を同じ台帳へ収集しています。

| 指標 | 網羅数／総数 | カバレッジ |
| ---- | ------------ | ---------- |
| 行   | 3149／3900   | 80.74%     |
| 文   | 3239／4022   | 80.53%     |
| 関数 | 610／729     | 83.67%     |
| 分岐 | 2363／2998   | 78.81%     |

125対象のうち、4指標達成78、部分網羅37、実行記録なし6、要素なし4です。全体100%は未達です。ローカル統合領域の19ファイルは行1062/1062・文1083/1083・関数160/160・分岐656/656で、タスク3〜6の対象も4指標達成を維持しています。

タスク7では、起動・停止・IPC・CLI・HTTP契約・証拠・DB・ビルド監査の失敗経路を追加しました。実時間の再試行、SIGKILL後の子孫停止とロック解放、並列環境の隔離、本番成果物への診断・計測コード非混入も既存の実Workerテストで確認しています。同期的に上書きされる空コールバック、常に引数が渡されるprivate関数の既定値、NodeのHTTP応答・依存解決とtest環境で保証される欠損ガードを整理したため、分母が変わっています。生成物や型宣言を追加除外して達成したものではありません。

未計測6ファイルはAIレビュー隔離入口4件（`action-probe.ts`・`probe-child.ts`・`run.ts`・`startup.ts`）と、計測ツールの`runtime-plugin.ts`・`vitest-config.ts`です。残る部分網羅もAIレビューと計測ツールに集中しています。

以下の全体値は過去の履歴です。最新のファイル別一覧は末尾に記載します。

## タスク5完了時の全体実測

2026年11月7日、実行ID`6a9446d9-49fa-4756-8ae0-e6c8d3a5a20d`で全107ファイル・627テストが成功しました（794.49秒）。その後、手書き実行コードのハッシュが同じことを確認し、正式評価Queueへの通知1ケースを同じ台帳へ追加実行しました。合計628ケースを検証しています。

| 指標 | 網羅数／総数 | カバレッジ |
| ---- | ------------ | ---------- |
| 行   | 2945／3905   | 75.41%     |
| 文   | 3032／4027   | 75.29%     |
| 関数 | 580／731     | 79.34%     |
| 分岐 | 2192／3014   | 72.72%     |

125対象のうち、4指標達成56、部分網羅58、実行記録なし7、要素なし4です。全体100%は未達です。Worker・D1の29対象は行309/309・文310/310・関数73/73・分岐174/174で、タスク3・4の対象も4指標達成を維持しています。

実行記録がない対象は次の7ファイルです。

- `tools/ai-review/isolation/action-probe.ts`
- `tools/ai-review/isolation/probe-child.ts`
- `tools/ai-review/isolation/run.ts`
- `tools/ai-review/isolation/startup.ts`
- `tools/coverage/src/runtime-plugin.ts`
- `tools/coverage/src/vitest-config.ts`
- `tools/local-integration/src/build-audit.ts`

以下の収集基盤導入時と初回調査の数値は履歴です。最新のファイル別実測は末尾の一覧に記載します。

タスク6では契約生成・文書検査の6ファイルも4指標100%を確認しました（行247/247・文249/249・関数23/23・分岐201/201）。領域別93件とルート103ファイル・645件が成功し、生成失敗の追加2件も検証しました。生成物10ファイルの再生成結果はSHA-256が一致しています。この領域別結果は上記の全体値へ算術合算していません。この後のタスク7全体計測には、これらの変更も含めています。

## 収集基盤導入後の実測結果

2026年11月7日、`pnpm test:coverage`で94ファイル・584テストがすべて成功しました（787.68秒）。実行IDは`19ca86a6-b70d-4828-af64-37c950b832b0`です。API生成、開発DBの保持確認の前準備、通常テストと追加7結合テスト、Node子プロセス、test環境のWorkerを同じ計測位置定義で集計しました。

| 指標 | カバレッジ | 網羅数／総数 | 未網羅数 |
| ---- | ---------- | ------------ | -------- |
| 行   | 74.02%     | 2893／3908   | 1015     |
| 文   | 73.90%     | 2979／4031   | 1052     |
| 関数 | 76.91%     | 563／732     | 169      |
| 分岐 | 71.60%     | 2161／3018   | 857      |

125対象の内訳は、4指標達成36・部分網羅74・実行記録なし9・計測要素なし6です。初回の105対象を維持し、計測ツール20ファイルを追加しています。既存範囲の総数は行3478・文3576・関数621・分岐2802、計測ツールは行430・文455・関数111・分岐216です。初回からの分母差は、既存のランタイム接続変更（行と文が各5、分岐16増加）と計測ツール追加によるものです。

実行記録のない対象は次の9ファイルです。実行記録がないことと、動作テストが存在しないことは区別します。

- `apps/web/scripts/verify-http.ts`
- `packages/database/db/seed.ts`
- `tools/ai-review/isolation/action-probe.ts`
- `tools/ai-review/isolation/probe-child.ts`
- `tools/ai-review/isolation/run.ts`
- `tools/ai-review/isolation/startup.ts`
- `tools/coverage/src/runtime-plugin.ts`
- `tools/coverage/src/vitest-config.ts`
- `tools/local-integration/src/build-audit.ts`

タスク2時点で要素なしだった6ファイルは後掲します。Vite・Void設定は実行式を持ちますが、計測器はdefault exportの式に文カウンターを割り当てません。0件を検証済みとは扱わず、タスク4で設定評価の検証と計測可能な等価な記述への整理を行いました。

タスク3では評価試行制御と共有環境設定に7ケースを追加し、到達不能な初期コールバックとタイマー入口ガードを整理しました。対象の実行要素がある6ファイルは行80/80・文80/80・関数13/13・分岐60/60です。ルート通常テスト88ファイル・576件が成功しています。この領域別検証は上記の全体基準値と別の台帳で実行し、古い全体結果へ混ぜていません。

以下の「実測結果」「計測条件」は11月6日の初回調査の記録です。最新のファイル別値は末尾の基準値一覧、未実行の行・文・関数・分岐位置は`coverage/combined/files.json`と`missing.json`に保存しています。

Web領域も追加検証し、17対象で行217/217・文220/220・関数48/48・分岐137/137の100%を確認しました。タスク完了時のルートテストは90ファイル・585件成功しています。この領域別結果を上記の全体実測値へ算術合算してはいません。Vite・Void設定は同じ設定値を変数経由でexportする形に整理したため、次の全体計測では要素0の分類から外れます。

## 実測結果

初回調査の最終実行は68テストファイル・522テストすべて成功し、終了コードは0でした。実行時間は494.22秒です。実行回数が負の値になっていないことを集計時に検査しました。

| 指標 | カバレッジ | 網羅数／総数 | 未網羅数 |
| ---- | ---------- | ------------ | -------- |
| 行   | 49.66%     | 1725／3473   | 1748     |
| 文   | 49.76%     | 1777／3571   | 1794     |
| 関数 | 52.97%     | 329／621     | 292      |
| 分岐 | 53.84%     | 1500／2786   | 1286     |

この数値は別プロセスの未計測部分を含む基準値であり、未網羅数がすべてテスト未実装を意味するわけではありません。選定した105ファイル中、実行要素のある99ファイルは、実行記録なし41・部分網羅47・4指標100%が11でした。残る6ファイルは計測要素0件です。

| 領域                      | 行     | 文     | 関数    | 分岐   |
| ------------------------- | ------ | ------ | ------- | ------ |
| `apps/evaluation`         | 23.33% | 23.23% | 16.98%  | 14.09% |
| `apps/interview`          | 0.00%  | 0.00%  | 0.00%   | 0.00%  |
| `apps/web`                | 69.58% | 69.54% | 70.83%  | 77.69% |
| `packages/api-contracts`  | 36.06% | 36.06% | 33.33%  | 80.00% |
| `packages/database`       | 0.00%  | 0.00%  | 0.00%   | 0.00%  |
| `packages/runtime-config` | 95.65% | 95.65% | 100.00% | 97.22% |
| `tools/ai-review`         | 55.27% | 55.23% | 63.54%  | 62.04% |
| `tools/docs`              | 74.19% | 73.93% | 52.94%  | 76.06% |
| `tools/local-integration` | 41.90% | 42.10% | 45.67%  | 30.50% |

初回の子プロセス合算を有効にした実行は521成功・1タイムアウトでした。対象は`check-object.test.ts`の「遅延上限より先の通知は保留し、送信前の停止から期限到来後に回復する」です。同じ計測方式・並列度1の再実行で成功し、上記の最終実行でも成功しました。不正な合算結果や再実行の数値は上記の基準値へ混ぜていません。

## 計測条件

Node.js 26.12.1、pnpm 12.15.0、Vitest 5.1.0、`@vitest/coverage-v8` 5.1.0を使用しました。各パッケージの通常の`test`スクリプトと同じテスト選択を、7つのVitestプロジェクトにまとめて実行しています。Webの専用includeと、ローカル結合検証の7ファイルのexcludeを維持し、契約生成は事前に実行しました。並列度は4です。

Git管理対象の手書きTypeScript・JavaScriptを明示的な`coverage.include`に列挙し、テストから読み込まれなかったファイルも分母へ含めました。対象はアプリ、共有パッケージ、開発ツール、生成処理の実装、DBスキーマ、実行設定です。

- 生成APIコード、生成ルート、ビルド成果物、依存パッケージ、生成SQLマイグレーションは除外しました。生成処理を実装したスクリプトは除外していません。
- 型宣言、TypeSpecの契約宣言、テスト本体、テスト専用fixture・補助コード、Vitest設定は除外しました。実行要素が0件のファイルを、4指標達成済みのファイル数へ算入しません。
- シェルスクリプト`tools/ai-review/isolation/prepare.sh`と`setup.sh`はV8の対象外で、未計測です。この集計でシェルやWorkflowも含めたリポジトリ全体の100%を判定することはできません。

`test:integration`に分離された`end-to-end`、`queue-retry`、`formal-routing`、`restart`、`isolation`、`dlq-restart`、`cli-recovery`の7テストファイルは今回の通常テスト計測に含みません。`http-contract.test.ts`など通常の`test`にも含まれる境界テストは実行しています。

### 別プロセスの扱い

最終集計では`coverage.autoAttachSubprocess`を無効にしています。有効にした診断実行では、`packages/runtime-config/src/resources.ts`の分岐実行回数に`-80`が現れ、同じ分岐や関数の位置情報が重複しました。Node.jsの型除去による直接実行とVitest変換後の実行を混在させた集計は、今回の基準値として採用していません。

Node.jsの子プロセス、Viteが読み込む設定、別プロセスのworkerd内部を、Vitest側の実行記録だけで網羅できたとは扱いません。これらの0%は「既存テストがない」という意味ではありません。ソースを文字列として確認するテストも、対象コードを実行したカバレッジにはなりません。

実行環境のPID 1が終了済みの孤児プロセスを回収しないため、子プロセス回収を行うラッパーでVitestを起動しました。アプリやテストの実装、タイムアウト値は変更していません。

### 実装中の計測方式検証

2026年11月7日、固定版Miniflare 5のローカルWorkerに対してInspector経由の計測を試しました。`Profiler.enable`は応答せず、`Profiler.startPreciseCoverage`は`Profiler is not enabled`を返したため、この環境では収集経路として成立していません。他のworkerd構成でも非対応だと断定する結果ではありません。

事前挿入したカウンターは、試験用Inspectorの`Runtime.enable`で取得した実行コンテキストIDを指定し、`Runtime.evaluate`で読み出せました。コンテキスト未指定では`Cannot find default execution context`になりました。これは小さなWorkerの停止前の取得試験であり、既存Voidランタイムの停止・再起動・強制終了を含む収集の保証ではありません。

後続の収集基盤では、rolldown 1.2.15でTypeScriptの型を除去し、`@vitest/istanbul-lib-instrument` 2.1.0で共通の計測コードを挿入する方式を採用します。同じ計測済みソースをNode子プロセスとWorkerで実行した小さな試験では、9文・5関数・9分岐の位置定義と入力ソースマップが一致しました。既定引数、if、短絡評価、三項演算、async例外を含む9分岐を両者の記録で網羅し、未呼び出し関数の実行回数は0のまま保持しました。TSXはJSXを残して型を除去し、計測コードを挿入してからJSXを変換する順序で検証しています。

以前不正な合算が発生した`resources.ts`では、依存する`environment.ts`とともに計測コードを挿入し、Node子プロセスの本番分岐とVitestの開発分岐を実行しました。両者の計測位置と入力ソースマップは一致し、分母を増やさず網羅した分岐を増やせること、負の実行回数がないことを確認しました。試験用importの一括置換が埋め込み元ソースまで変更すると比較が失敗するため、試験では実コード行だけを書き換えています。元ソースの一致確認を省略して合算する方式は採用しません。

小さなfixtureの元ソースへの位置変換では、行7・文9・関数5・分岐9の分母が変換前後で一致しました。これは方式検証であり、上記の全体カバレッジを更新する結果ではありません。方式選定時点では、全対象での元ソースへの変換、正常終了・強制終了時の回収、既存Workerテストへの接続は未完了でした。後続のタスク2で接続・検証しました。計測対象の選別では調査時の105ファイルに欠落がなく、追加した計測ツールの実装2ファイルも対象に含まれることを確認しました。

タスク2では、収集片の実行ID・リビジョン・ソースハッシュ・計測コードハッシュ・位置定義・実行回数の照合、重複・欠落・未完了の拒否を実装しました。開始台帳を別に残し、収集片のファイル自体が消えた場合も検出します。4指標の判定は割合の丸めではなく網羅数と総数の完全一致を使い、空の結果を成功扱いしません。

Nodeの終了時保存だけではSIGKILL時に回収できないため、カウンターの更新を同期journalへ追記する方式を追加しました。実際のSIGKILL後に文・関数・分岐の回数を復元できることと、生存中のプロセスのjournalを完了扱いしないことを検査しています。失敗終了を期待するテストと収集完了を区別し、suiteの成否は実行側で別に確認します。

既存の3 Workers経路では、test環境の生成Vite設定にだけ計測を挿入し、停止前にInspectorから回収します。コピーしたWebソースは内容ハッシュが一致する原本にだけ対応付けます。MiniflareのInspectorプロキシはOriginヘッダーがない接続を切断するため、Node.js 26のWebSocket拡張でローカルOriginを指定しました。実HTTP呼び出し後のWeb原本の関数実行を回収するテストが成功しています。本番ビルドへの計測モジュールのimportと計測カウンターの挿入を拒否する回帰テストも追加しました。

追加の実行で、既存のVite強制終了テストがInspectorプロキシも終了させ、残ったworkerdからの回収に失敗することが分かりました。起動時に子workerdの所有ソケットから直接Inspectorを特定し、通常停止はプロキシ、Vite消失時は直接接続を使います。この探索はLinuxの`/proc`を使用します。通常終了・ViteのSIGKILLの両ケースで回収を確認しました。Worker再生成によるカウンター消失は、開始時と終了時の識別値を照合して失敗にします。

Nodeローダー自身はフック登録前に読み込まれるため、生成した起動用コードから原本と同じ位置定義の計測コードを実行し、初期カウンターもjournalへ引き継ぎます。原本ローダーは除外しません。ファイル別一覧には「要素なし・未実行・一部実行・4指標100%」を保存し、要素なしには理由を付けます。

収集入口の`test:coverage`と保存済み結果を検査する`check:coverage`を追加しました。全体収集はAPI生成、既存の`prepare:integration`、全テストの順に実行します。初回の接続では保持確認の前準備が抜け、環境隔離テストが失敗しました。前準備後の計測付き再実行は成功し、この順序を回帰テストで固定しました。新方式の全体収集・集計は成功し、冒頭の基準値を確定しました。100%は未達です。

## 未計測範囲と確認する順序

次の表は初回調査時の優先順です。Node・Workerの収集接続はタスク2で完了し、現在は冒頭の9ファイルと位置別の不足を後続タスクで確認します。

| 優先 | 範囲                                | 既存の検証と不足する計測                                                                                                                                                      |
| ---- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | 評価Consumer、面接DO、D1リポジトリ  | `tools/local-integration/tests`に実行権・再配送・DLQ・回復・配送異常・DOの境界テストがあります。workerd内部の実行記録と元ソースの対応を取得してから、未実行分岐を判断します。 |
| 1    | Webのルーター、HTTP入口、DB接続     | HTTP境界テストは別Workerを呼びます。API関数の単体テストの数値と、ルーターやDB接続の数値を同一視しません。                                                                     |
| 1    | Node.js子プロセスとビルドプラグイン | CLI、ランタイム所有者、生成・ビルド処理は直接実行・別プロセスで動きます。変換方式別に正しく計測できることを先に確認します。                                                   |
| 2    | 契約の生成スクリプト                | 契約テストは生成結果を検証しますが、事前の生成コマンドは計測開始前です。正常生成に加え、不正・欠落した入力に対する生成処理の分岐を計測対象にします。                          |
| 2    | 実時間の結合検証と隔離検証          | 今回除外した7テストと、専用環境を前提とするAIレビュー隔離プローブを、通常テストの未達分と区別して計測します。                                                                 |

[設計基準](../spec/mvp.md#設計基準)と[ADR 0010](../adr/0010-queue-contracts-and-job-control.md)に従い、実行権・保存・ack・retry・DLQの境界を維持します。100%のためにこれらを一括してモックへ置き換えると、既存の境界テストが保証している性質を失います。[ADR 0006](../adr/0006-typespec-api-contracts.md)の生成契約検証と、[ADR 0011](../adr/0011-access-and-diagnostics-isolation.md)の本番成果物検査も維持します。

## 計測成果物

ローカルの`coverage/audit/`にHTML、`coverage-final.json`、`coverage-summary.json`、ファイル別の`file-coverage.csv`、未実行の文・行・関数・分岐の位置を持つ`uncovered-details.json`を保存します。計測用設定・対象一覧・集計処理・プロセス回収ラッパーは`.local/coverage-audit/`にあります。これらはGit除外対象で、この文書の集計表と区別して扱います。

計測ツールは一時領域に配置し、依存宣言・ロックファイル・通常のテスト設定には変更を加えていません。今回の環境で使用した計測コマンドは次のとおりです。Node.jsとpnpmは上記の固定版をPATHに設定した状態で実行します。

```sh
pnpm --filter @korekaite/api-contracts generate
python3 .local/coverage-audit/reap.py node apps/web/node_modules/vitest/vitest.mjs run --config .local/coverage-audit/vitest.config.mjs --coverage --maxWorkers 4
node .local/coverage-audit/summarize.mjs
```

この調査ではテストの追加や100%閾値のCIへの導入は行っていません。今後は計測漏れを解消したうえで、未実行位置ごとに必要な動作を確認し、テストを1件ずつ追加します。UIの無効化などで到達しないガードや上書きされる初期コールバックは、単純なテスト不足と断定せず到達可能性を確認します。数字を上げる目的だけの除外は追加しません。

## 計測済みコードで不足するケース

次は実行記録のあるコードの未網羅位置と、その処理内容です。Worker側に同等の境界テストがある箇所は、先に計測を接続して重複追加を避けます。優先度は障害時の影響と不足箇所の具体性を基準にしています。

| 優先 | 対象と未網羅位置                                                                                                                                                                     | 確認するケース                                                                                                                                                             |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | [評価の試行制御](../../apps/evaluation/src/application/run-evaluation-attempt.ts)の14・31・34・69行、18行の初期コールバック                                                          | 開始時に期限到来済み、停止後・期限到来後の更新、保存失敗時の期限到来。上書きされる初期コールバックは到達可能性の確認が必要です。分岐は68.75%です。                         |
| 1    | [診断API受付](../../apps/web/src/diagnostics/accept.ts)の24・28・40・44・54・58〜85行の未網羅箇所と、[状態取得](../../apps/web/src/diagnostics/get.ts)の15・26〜34行の未網羅箇所     | Content-Type・冪等キー・本文の拒否、競合、後続処理の開始失敗、DBエラー、参照結果の分岐。既存のHTTP・D1境界テストの計測接続を優先します。                                   |
| 1    | [AIレビュー準備](../../tools/ai-review/prepare.ts)の21・37〜95行の未網羅箇所                                                                                                         | 認証不足、資料収集、途中投稿の検出、準備失敗の状態表示・出力。未網羅は28文・27分岐です。CLI部分の未計測も含みます。                                                        |
| 2    | [実行領域の確保](../../packages/runtime-config/src/artifacts.ts)の13行                                                                                                               | EEXIST以外の書き込み失敗を握りつぶさず再送出する。共有環境設定は残り1行・1文・1分岐で、関数は100%です。                                                                    |
| 2    | [診断画面](../../apps/web/src/diagnostics/page.tsx)の39行と94行の偽分岐                                                                                                              | 実行情報なしの送信と許可外シナリオ値。UIの無効化や選択肢により到達できない可能性を確認します。関数は100%、未網羅は1行・1文・2分岐です。                                    |
| 2    | [文書検査](../../tools/docs/check.ts)                                                                                                                                                | 未網羅38文・6関数・35分岐。CLI入口とファイル列挙、エラー報告を関数単位の検証と区別して確認します。                                                                         |
| 3    | [AIレビュー実行制御](../../tools/ai-review/runtime.ts)、[隔離のライフサイクル](../../tools/ai-review/isolation/lifecycle.ts)、[モデル検証](../../tools/ai-review/isolation/model.ts) | それぞれ101・126・100文が未網羅です。実runner・WIF・隔離環境の前提があり、通常テストと専用環境の実行記録を分けて取得します。単なるケース追加だけで解消するとは扱いません。 |
| 3    | [結合検証の実行処理](../../tools/local-integration/src/integration.ts)                                                                                                               | 未網羅239文・19関数・246分岐。通常テストでは読み込み確認が中心で、別入口の結合検証を今回実行していない影響が大きい範囲です。                                               |

## ファイル別の最終値

main統合後の全体計測です。要素がない指標は「—」で示します。

| ファイル                                                                                                                                     | 状態      | 行               | 文               | 関数           | 分岐             |
| -------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------------- | ---------------- | -------------- | ---------------- |
| [.pnpmfile.cjs](../../.pnpmfile.cjs)                                                                                                         | 4指標100% | 100%（5／5）     | 100%（5／5）     | 100%（1／1）   | 100%（4／4）     |
| [apps/evaluation/src/application/classify-delivery.ts](../../apps/evaluation/src/application/classify-delivery.ts)                           | 4指標100% | 100%（5／5）     | 100%（5／5）     | 100%（1／1）   | 100%（4／4）     |
| [apps/evaluation/src/application/consume-dlq.ts](../../apps/evaluation/src/application/consume-dlq.ts)                                       | 4指標100% | 100%（5／5）     | 100%（5／5）     | 100%（1／1）   | 100%（4／4）     |
| [apps/evaluation/src/application/consume-job.ts](../../apps/evaluation/src/application/consume-job.ts)                                       | 4指標100% | 100%（27／27）   | 100%（27／27）   | 100%（5／5）   | 100%（29／29）   |
| [apps/evaluation/src/application/dispatch-notifications.ts](../../apps/evaluation/src/application/dispatch-notifications.ts)                 | 4指標100% | 100%（24／24）   | 100%（24／24）   | 100%（1／1）   | 100%（21／21）   |
| [apps/evaluation/src/application/recover-executions.ts](../../apps/evaluation/src/application/recover-executions.ts)                         | 4指標100% | 100%（7／7）     | 100%（7／7）     | 100%（2／2）   | 100%（1／1）     |
| [apps/evaluation/src/application/recover-initialization.ts](../../apps/evaluation/src/application/recover-initialization.ts)                 | 4指標100% | 100%（7／7）     | 100%（7／7）     | 100%（2／2）   | 100%（1／1）     |
| [apps/evaluation/src/application/recover-jobs.ts](../../apps/evaluation/src/application/recover-jobs.ts)                                     | 4指標100% | 100%（4／4）     | 100%（4／4）     | 100%（1／1）   | —                |
| [apps/evaluation/src/application/run-evaluation-attempt.ts](../../apps/evaluation/src/application/run-evaluation-attempt.ts)                 | 4指標100% | 100%（47／47）   | 100%（47／47）   | 100%（8／8）   | 100%（14／14）   |
| [apps/evaluation/src/diagnostics/consume.ts](../../apps/evaluation/src/diagnostics/consume.ts)                                               | 4指標100% | 100%（12／12）   | 100%（12／12）   | 100%（4／4）   | 100%（6／6）     |
| [apps/evaluation/src/diagnostics/evaluator.ts](../../apps/evaluation/src/diagnostics/evaluator.ts)                                           | 4指標100% | 100%（3／3）     | 100%（3／3）     | 100%（1／1）   | 100%（5／5）     |
| [apps/evaluation/src/domain/evaluation-result.ts](../../apps/evaluation/src/domain/evaluation-result.ts)                                     | 要素なし  | —                | —                | —              | —                |
| [apps/evaluation/src/domain/job-state.ts](../../apps/evaluation/src/domain/job-state.ts)                                                     | 4指標100% | 100%（2／2）     | 100%（2／2）     | —              | —                |
| [apps/evaluation/src/domain/lease.ts](../../apps/evaluation/src/domain/lease.ts)                                                             | 4指標100% | 100%（1／1）     | 100%（1／1）     | —              | —                |
| [apps/evaluation/src/domain/retry-policy.ts](../../apps/evaluation/src/domain/retry-policy.ts)                                               | 4指標100% | 100%（9／9）     | 100%（9／9）     | 100%（1／1）   | 100%（10／10）   |
| [apps/evaluation/src/server/repositories/delivery-anomalies.ts](../../apps/evaluation/src/server/repositories/delivery-anomalies.ts)         | 4指標100% | 100%（6／6）     | 100%（6／6）     | 100%（4／4）   | —                |
| [apps/evaluation/src/server/repositories/dlq-receipts.ts](../../apps/evaluation/src/server/repositories/dlq-receipts.ts)                     | 4指標100% | 100%（4／4）     | 100%（4／4）     | 100%（1／1）   | —                |
| [apps/evaluation/src/server/repositories/job-execution.ts](../../apps/evaluation/src/server/repositories/job-execution.ts)                   | 4指標100% | 100%（44／44）   | 100%（44／44）   | 100%（10／10） | 100%（22／22）   |
| [apps/evaluation/src/server/repositories/outbox.ts](../../apps/evaluation/src/server/repositories/outbox.ts)                                 | 4指標100% | 100%（6／6）     | 100%（6／6）     | 100%（4／4）   | 100%（2／2）     |
| [apps/evaluation/src/worker.local.ts](../../apps/evaluation/src/worker.local.ts)                                                             | 4指標100% | 100%（24／24）   | 100%（24／24）   | 100%（6／6）   | 100%（28／28）   |
| [apps/evaluation/src/worker.ts](../../apps/evaluation/src/worker.ts)                                                                         | 要素なし  | —                | —                | —              | —                |
| [apps/interview/src/diagnostics/check-object.ts](../../apps/interview/src/diagnostics/check-object.ts)                                       | 4指標100% | 100%（27／27）   | 100%（27／27）   | 100%（2／2）   | 100%（19／19）   |
| [apps/interview/src/server/repositories/check-outbox.ts](../../apps/interview/src/server/repositories/check-outbox.ts)                       | 4指標100% | 100%（19／19）   | 100%（19／19）   | 100%（4／4）   | 100%（6／6）     |
| [apps/interview/src/worker.local.ts](../../apps/interview/src/worker.local.ts)                                                               | 要素なし  | —                | —                | —              | —                |
| [apps/interview/src/worker.ts](../../apps/interview/src/worker.ts)                                                                           | 要素なし  | —                | —                | —              | —                |
| [apps/web/scripts/verify-http.ts](../../apps/web/scripts/verify-http.ts)                                                                     | 4指標100% | 100%（11／11）   | 100%（11／11）   | 100%（1／1）   | 100%（2／2）     |
| [apps/web/src/diagnostics/accept.ts](../../apps/web/src/diagnostics/accept.ts)                                                               | 4指標100% | 100%（26／26）   | 100%（27／27）   | 100%（2／2）   | 100%（14／14）   |
| [apps/web/src/diagnostics/client.tsx](../../apps/web/src/diagnostics/client.tsx)                                                             | 4指標100% | 100%（25／25）   | 100%（25／25）   | 100%（5／5）   | 100%（15／15）   |
| [apps/web/src/diagnostics/errors.ts](../../apps/web/src/diagnostics/errors.ts)                                                               | 4指標100% | 100%（21／21）   | 100%（21／21）   | 100%（5／5）   | 100%（16／16）   |
| [apps/web/src/diagnostics/get.ts](../../apps/web/src/diagnostics/get.ts)                                                                     | 4指標100% | 100%（12／12）   | 100%（12／12）   | 100%（1／1）   | 100%（6／6）     |
| [apps/web/src/diagnostics/page.tsx](../../apps/web/src/diagnostics/page.tsx)                                                                 | 4指標100% | 100%（49／49）   | 100%（50／50）   | 100%（10／10） | 100%（43／43）   |
| [apps/web/src/lib/date-time.ts](../../apps/web/src/lib/date-time.ts)                                                                         | 4指標100% | 100%（1／1）     | 100%（1／1）     | 100%（1／1）   | —                |
| [apps/web/src/lib/interviews.ts](../../apps/web/src/lib/interviews.ts)                                                                       | 4指標100% | 100%（7／7）     | 100%（7／7）     | 100%（1／1）   | 100%（7／7）     |
| [apps/web/src/router.tsx](../../apps/web/src/router.tsx)                                                                                     | 4指標100% | 100%（1／1）     | 100%（1／1）     | 100%（1／1）   | —                |
| [apps/web/src/routes/__root.tsx](../../apps/web/src/routes/__root.tsx)                                                                       | 4指標100% | 100%（3／3）     | 100%（3／3）     | 100%（2／2）   | —                |
| [apps/web/src/routes/api.interviews.ts](../../apps/web/src/routes/api.interviews.ts)                                                         | 4指標100% | 100%（2／2）     | 100%（2／2）     | 100%（1／1）   | —                |
| [apps/web/src/routes/index.tsx](../../apps/web/src/routes/index.tsx)                                                                         | 4指標100% | 100%（19／19）   | 100%（20／20）   | 100%（8／8）   | 100%（10／10）   |
| [apps/web/src/server/interviews.ts](../../apps/web/src/server/interviews.ts)                                                                 | 4指標100% | 100%（10／10）   | 100%（10／10）   | 100%（3／3）   | 100%（10／10）   |
| [apps/web/src/server/repositories/database-error.ts](../../apps/web/src/server/repositories/database-error.ts)                               | 4指標100% | 100%（5／5）     | 100%（5／5）     | 100%（2／2）   | —                |
| [apps/web/src/server/repositories/diagnostic-jobs.ts](../../apps/web/src/server/repositories/diagnostic-jobs.ts)                             | 4指標100% | 100%（23／23）   | 100%（23／23）   | 100%（5／5）   | 100%（14／14）   |
| [apps/web/vite.config.ts](../../apps/web/vite.config.ts)                                                                                     | 4指標100% | 100%（1／1）     | 100%（1／1）     | —              | —                |
| [apps/web/void.config.ts](../../apps/web/void.config.ts)                                                                                     | 4指標100% | 100%（1／1）     | 100%（1／1）     | —              | —                |
| [packages/api-contracts/scripts/generate-diagnostics-validation.ts](../../packages/api-contracts/scripts/generate-diagnostics-validation.ts) | 4指標100% | 100%（21／21）   | 100%（21／21）   | 100%（2／2）   | 100%（4／4）     |
| [packages/api-contracts/scripts/generate-messages.ts](../../packages/api-contracts/scripts/generate-messages.ts)                             | 4指標100% | 100%（8／8）     | 100%（8／8）     | 100%（1／1）   | —                |
| [packages/api-contracts/scripts/generate-validation.ts](../../packages/api-contracts/scripts/generate-validation.ts)                         | 4指標100% | 100%（10／10）   | 100%（10／10）   | 100%（1／1）   | —                |
| [packages/api-contracts/scripts/reachable-schema.ts](../../packages/api-contracts/scripts/reachable-schema.ts)                               | 4指標100% | 100%（22／22）   | 100%（22／22）   | 100%（2／2）   | 100%（16／16）   |
| [packages/database/db/schema.ts](../../packages/database/db/schema.ts)                                                                       | 4指標100% | 100%（1／1）     | 100%（1／1）     | —              | —                |
| [packages/database/db/schema/diagnostics.ts](../../packages/database/db/schema/diagnostics.ts)                                               | 4指標100% | 100%（5／5）     | 100%（5／5）     | 100%（3／3）   | —                |
| [packages/database/db/schema/jobs.ts](../../packages/database/db/schema/jobs.ts)                                                             | 4指標100% | 100%（15／15）   | 100%（15／15）   | 100%（8／8）   | —                |
| [packages/database/db/seed.ts](../../packages/database/db/seed.ts)                                                                           | 4指標100% | 100%（1／1）     | 100%（1／1）     | 100%（1／1）   | —                |
| [packages/database/src/connection.ts](../../packages/database/src/connection.ts)                                                             | 4指標100% | 100%（4／4）     | 100%（5／5）     | 100%（3／3）   | 100%（2／2）     |
| [packages/runtime-config/src/artifacts.ts](../../packages/runtime-config/src/artifacts.ts)                                                   | 4指標100% | 100%（10／10）   | 100%（10／10）   | 100%（1／1）   | 100%（7／7）     |
| [packages/runtime-config/src/environment.ts](../../packages/runtime-config/src/environment.ts)                                               | 4指標100% | 100%（3／3）     | 100%（3／3）     | 100%（1／1）   | 100%（5／5）     |
| [packages/runtime-config/src/resources.ts](../../packages/runtime-config/src/resources.ts)                                                   | 4指標100% | 100%（10／10）   | 100%（10／10）   | 100%（2／2）   | 100%（24／24）   |
| [tools/ai-review/artifact.ts](../../tools/ai-review/artifact.ts)                                                                             | 4指標100% | 100%（48／48）   | 100%（53／53）   | 100%（17／17） | 100%（65／65）   |
| [tools/ai-review/check-run.ts](../../tools/ai-review/check-run.ts)                                                                           | 4指標100% | 100%（77／77）   | 100%（79／79）   | 100%（8／8）   | 100%（74／74）   |
| [tools/ai-review/check-settings.ts](../../tools/ai-review/check-settings.ts)                                                                 | 4指標100% | 100%（38／38）   | 100%（39／39）   | 100%（9／9）   | 100%（30／30）   |
| [tools/ai-review/check-status.ts](../../tools/ai-review/check-status.ts)                                                                     | 4指標100% | 100%（27／27）   | 100%（29／29）   | 100%（5／5）   | 100%（26／26）   |
| [tools/ai-review/coverage-diagnostic.ts](../../tools/ai-review/coverage-diagnostic.ts)                                                       | 4指標100% | 100%（33／33）   | 100%（37／37）   | 100%（13／13） | 100%（54／54）   |
| [tools/ai-review/diagnostics.ts](../../tools/ai-review/diagnostics.ts)                                                                       | 4指標100% | 100%（41／41）   | 100%（44／44）   | 100%（18／18） | 100%（73／73）   |
| [tools/ai-review/failure-message.ts](../../tools/ai-review/failure-message.ts)                                                               | 4指標100% | 100%（9／9）     | 100%（9／9）     | 100%（1／1）   | 100%（14／14）   |
| [tools/ai-review/failure-notify.ts](../../tools/ai-review/failure-notify.ts)                                                                 | 4指標100% | 100%（65／65）   | 100%（67／67）   | 100%（5／5）   | 100%（88／88）   |
| [tools/ai-review/failure.ts](../../tools/ai-review/failure.ts)                                                                               | 4指標100% | 100%（5／5）     | 100%（6／6）     | 100%（3／3）   | 100%（2／2）     |
| [tools/ai-review/followup.ts](../../tools/ai-review/followup.ts)                                                                             | 4指標100% | 100%（20／20）   | 100%（20／20）   | 100%（4／4）   | 100%（23／23）   |
| [tools/ai-review/github.ts](../../tools/ai-review/github.ts)                                                                                 | 4指標100% | 100%（43／43）   | 100%（44／44）   | 100%（8／8）   | 100%（53／53）   |
| [tools/ai-review/history.ts](../../tools/ai-review/history.ts)                                                                               | 4指標100% | 100%（41／41）   | 100%（43／43）   | 100%（9／9）   | 100%（30／30）   |
| [tools/ai-review/isolation-probe.ts](../../tools/ai-review/isolation-probe.ts)                                                               | 4指標100% | 100%（67／67）   | 100%（73／73）   | 100%（27／27） | 100%（59／59）   |
| [tools/ai-review/isolation/action-probe.ts](../../tools/ai-review/isolation/action-probe.ts)                                                 | 4指標100% | 100%（22／22）   | 100%（23／23）   | 100%（3／3）   | 100%（22／22）   |
| [tools/ai-review/isolation/lifecycle.ts](../../tools/ai-review/isolation/lifecycle.ts)                                                       | 4指標100% | 100%（128／128） | 100%（131／131） | 100%（21／21） | 100%（104／104） |
| [tools/ai-review/isolation/model.ts](../../tools/ai-review/isolation/model.ts)                                                               | 4指標100% | 100%（127／127） | 100%（131／131） | 100%（21／21） | 100%（104／104） |
| [tools/ai-review/isolation/probe-child.ts](../../tools/ai-review/isolation/probe-child.ts)                                                   | 4指標100% | 100%（5／5）     | 100%（5／5）     | —              | 100%（2／2）     |
| [tools/ai-review/isolation/run.ts](../../tools/ai-review/isolation/run.ts)                                                                   | 4指標100% | 100%（74／74）   | 100%（83／83）   | 100%（18／18） | 100%（30／30）   |
| [tools/ai-review/isolation/startup.ts](../../tools/ai-review/isolation/startup.ts)                                                           | 4指標100% | 100%（62／62）   | 100%（70／70）   | 100%（17／17） | 100%（36／36）   |
| [tools/ai-review/isolation/wif.ts](../../tools/ai-review/isolation/wif.ts)                                                                   | 4指標100% | 100%（58／58）   | 100%（62／62）   | 100%（9／9）   | 100%（43／43）   |
| [tools/ai-review/material.ts](../../tools/ai-review/material.ts)                                                                             | 4指標100% | 100%（40／40）   | 100%（40／40）   | 100%（4／4）   | 100%（14／14）   |
| [tools/ai-review/policy.ts](../../tools/ai-review/policy.ts)                                                                                 | 4指標100% | 100%（43／43）   | 100%（45／45）   | 100%（15／15） | 100%（64／64）   |
| [tools/ai-review/prepare.ts](../../tools/ai-review/prepare.ts)                                                                               | 4指標100% | 100%（42／42）   | 100%（42／42）   | 100%（3／3）   | 100%（40／40）   |
| [tools/ai-review/publish.ts](../../tools/ai-review/publish.ts)                                                                               | 4指標100% | 100%（64／64）   | 100%（64／64）   | 100%（9／9）   | 100%（65／65）   |
| [tools/ai-review/run-version.ts](../../tools/ai-review/run-version.ts)                                                                       | 4指標100% | 100%（37／37）   | 100%（37／37）   | 100%（3／3）   | 100%（57／57）   |
| [tools/ai-review/runtime.ts](../../tools/ai-review/runtime.ts)                                                                               | 4指標100% | 100%（169／169） | 100%（172／172） | 100%（14／14） | 100%（86／86）   |
| [tools/ai-review/snapshot.ts](../../tools/ai-review/snapshot.ts)                                                                             | 4指標100% | 100%（51／51）   | 100%（56／56）   | 100%（20／20） | 100%（70／70）   |
| [tools/ai-review/source-ci.ts](../../tools/ai-review/source-ci.ts)                                                                           | 4指標100% | 100%（1／1）     | 100%（1／1）     | 100%（1／1）   | 100%（2／2）     |
| [tools/ai-review/status-report.ts](../../tools/ai-review/status-report.ts)                                                                   | 4指標100% | 100%（43／43）   | 100%（43／43）   | 100%（8／8）   | 100%（86／86）   |
| [tools/ai-review/wait-review.ts](../../tools/ai-review/wait-review.ts)                                                                       | 4指標100% | 100%（96／96）   | 100%（97／97）   | 100%（12／12） | 100%（124／124） |
| [tools/ai-review/wif.ts](../../tools/ai-review/wif.ts)                                                                                       | 4指標100% | 100%（33／33）   | 100%（34／34）   | 100%（5／5）   | 100%（24／24）   |
| [tools/coverage/run.ts](../../tools/coverage/run.ts)                                                                                         | 4指標100% | 100%（17／17）   | 100%（18／18）   | 100%（3／3）   | 100%（12／12）   |
| [tools/coverage/src/capture.ts](../../tools/coverage/src/capture.ts)                                                                         | 4指標100% | 100%（31／31）   | 100%（32／32）   | 100%（9／9）   | 100%（10／10）   |
| [tools/coverage/src/check.ts](../../tools/coverage/src/check.ts)                                                                             | 4指標100% | 100%（13／13）   | 100%（14／14）   | 100%（3／3）   | 100%（6／6）     |
| [tools/coverage/src/collect.ts](../../tools/coverage/src/collect.ts)                                                                         | 4指標100% | 100%（25／25）   | 100%（25／25）   | 100%（4／4）   | 100%（6／6）     |
| [tools/coverage/src/instrument.ts](../../tools/coverage/src/instrument.ts)                                                                   | 4指標100% | 100%（7／7）     | 100%（7／7）     | 100%（1／1）   | 100%（2／2）     |
| [tools/coverage/src/journal.ts](../../tools/coverage/src/journal.ts)                                                                         | 4指標100% | 100%（39／39）   | 100%（41／41）   | 100%（9／9）   | 100%（18／18）   |
| [tools/coverage/src/merge.ts](../../tools/coverage/src/merge.ts)                                                                             | 4指標100% | 100%（45／45）   | 100%（51／51）   | 100%（10／10） | 100%（34／34）   |
| [tools/coverage/src/node-loader.ts](../../tools/coverage/src/node-loader.ts)                                                                 | 4指標100% | 100%（27／27）   | 100%（29／29）   | 100%（4／4）   | 100%（18／18）   |
| [tools/coverage/src/preload.ts](../../tools/coverage/src/preload.ts)                                                                         | 4指標100% | 100%（9／9）     | 100%（10／10）   | 100%（2／2）   | 100%（2／2）     |
| [tools/coverage/src/prepare.ts](../../tools/coverage/src/prepare.ts)                                                                         | 4指標100% | 100%（9／9）     | 100%（10／10）   | 100%（4／4）   | —                |
| [tools/coverage/src/report.ts](../../tools/coverage/src/report.ts)                                                                           | 4指標100% | 100%（48／48）   | 100%（50／50）   | 100%（17／17） | 100%（19／19）   |
| [tools/coverage/src/runtime-capture.ts](../../tools/coverage/src/runtime-capture.ts)                                                         | 4指標100% | 100%（23／23）   | 100%（24／24）   | 100%（7／7）   | 100%（11／11）   |
| [tools/coverage/src/runtime-plugin.ts](../../tools/coverage/src/runtime-plugin.ts)                                                           | 4指標100% | 100%（2／2）     | 100%（2／2）     | 100%（1／1）   | —                |
| [tools/coverage/src/targets.ts](../../tools/coverage/src/targets.ts)                                                                         | 4指標100% | 100%（19／19）   | 100%（19／19）   | 100%（6／6）   | 100%（21／21）   |
| [tools/coverage/src/verify.ts](../../tools/coverage/src/verify.ts)                                                                           | 4指標100% | 100%（10／10）   | 100%（11／11）   | 100%（3／3）   | 100%（4／4）     |
| [tools/coverage/src/vite-plugin.ts](../../tools/coverage/src/vite-plugin.ts)                                                                 | 4指標100% | 100%（16／16）   | 100%（19／19）   | 100%（6／6）   | 100%（13／13）   |
| [tools/coverage/src/vitest-config.ts](../../tools/coverage/src/vitest-config.ts)                                                             | 4指標100% | 100%（3／3）     | 100%（3／3）     | 100%（2／2）   | —                |
| [tools/coverage/src/vitest-setup.ts](../../tools/coverage/src/vitest-setup.ts)                                                               | 4指標100% | 100%（5／5）     | 100%（5／5）     | 100%（1／1）   | 100%（2／2）     |
| [tools/coverage/src/worker.ts](../../tools/coverage/src/worker.ts)                                                                           | 4指標100% | 100%（51／51）   | 100%（51／51）   | 100%（12／12） | 100%（19／19）   |
| [tools/coverage/src/workerd-inspector.ts](../../tools/coverage/src/workerd-inspector.ts)                                                     | 4指標100% | 100%（32／32）   | 100%（35／35）   | 100%（8／8）   | 100%（19／19）   |
| [tools/docs/check-guard.ts](../../tools/docs/check-guard.ts)                                                                                 | 4指標100% | 100%（30／30）   | 100%（30／30）   | 100%（3／3）   | 100%（28／28）   |
| [tools/docs/check-node.ts](../../tools/docs/check-node.ts)                                                                                   | 4指標100% | 100%（37／37）   | 100%（37／37）   | 100%（3／3）   | 100%（41／41）   |
| [tools/docs/check.ts](../../tools/docs/check.ts)                                                                                             | 4指標100% | 100%（149／149） | 100%（151／151） | 100%（14／14） | 100%（140／140） |
| [tools/local-integration/src/build-audit.ts](../../tools/local-integration/src/build-audit.ts)                                               | 4指標100% | 100%（15／15）   | 100%（15／15）   | 100%（2／2）   | 100%（6／6）     |
| [tools/local-integration/src/ci-selection.ts](../../tools/local-integration/src/ci-selection.ts)                                             | 4指標100% | 100%（27／27）   | 100%（29／29）   | 100%（5／5）   | 100%（40／40）   |
| [tools/local-integration/src/database.ts](../../tools/local-integration/src/database.ts)                                                     | 4指標100% | 100%（35／35）   | 100%（35／35）   | 100%（3／3）   | 100%（38／38）   |
| [tools/local-integration/src/development-snapshot.ts](../../tools/local-integration/src/development-snapshot.ts)                             | 4指標100% | 100%（36／36）   | 100%（36／36）   | 100%（4／4）   | 100%（11／11）   |
| [tools/local-integration/src/diagnostic-http-contract.ts](../../tools/local-integration/src/diagnostic-http-contract.ts)                     | 4指標100% | 100%（98／98）   | 100%（99／99）   | 100%（8／8）   | 100%（14／14）   |
| [tools/local-integration/src/evidence.ts](../../tools/local-integration/src/evidence.ts)                                                     | 4指標100% | 100%（23／23）   | 100%（23／23）   | 100%（3／3）   | 100%（6／6）     |
| [tools/local-integration/src/http-contract.ts](../../tools/local-integration/src/http-contract.ts)                                           | 4指標100% | 100%（30／30）   | 100%（31／31）   | 100%（5／5）   | 100%（8／8）     |
| [tools/local-integration/src/integration-run.ts](../../tools/local-integration/src/integration-run.ts)                                       | 4指標100% | 100%（11／11）   | 100%（12／12）   | 100%（3／3）   | 100%（3／3）     |
| [tools/local-integration/src/integration.ts](../../tools/local-integration/src/integration.ts)                                               | 4指標100% | 100%（235／235） | 100%（237／237） | 100%（19／19） | 100%（245／245） |
| [tools/local-integration/src/isolation.ts](../../tools/local-integration/src/isolation.ts)                                                   | 4指標100% | 100%（93／93）   | 100%（98／98）   | 100%（18／18） | 100%（14／14）   |
| [tools/local-integration/src/lock.ts](../../tools/local-integration/src/lock.ts)                                                             | 4指標100% | 100%（13／13）   | 100%（13／13）   | 100%（2／2）   | 100%（10／10）   |
| [tools/local-integration/src/prepare-integration.ts](../../tools/local-integration/src/prepare-integration.ts)                               | 4指標100% | 100%（19／19）   | 100%（19／19）   | 100%（2／2）   | 100%（7／7）     |
| [tools/local-integration/src/process.ts](../../tools/local-integration/src/process.ts)                                                       | 4指標100% | 100%（52／52）   | 100%（55／55）   | 100%（13／13） | 100%（32／32）   |
| [tools/local-integration/src/production.ts](../../tools/local-integration/src/production.ts)                                                 | 4指標100% | 100%（114／114） | 100%（117／117） | 100%（16／16） | 100%（76／76）   |
| [tools/local-integration/src/readiness.ts](../../tools/local-integration/src/readiness.ts)                                                   | 4指標100% | 100%（5／5）     | 100%（5／5）     | 100%（1／1）   | 100%（5／5）     |
| [tools/local-integration/src/run-test-suite.ts](../../tools/local-integration/src/run-test-suite.ts)                                         | 4指標100% | 100%（38／38）   | 100%（40／40）   | 100%（11／11） | 100%（17／17）   |
| [tools/local-integration/src/run.ts](../../tools/local-integration/src/run.ts)                                                               | 4指標100% | 100%（51／51）   | 100%（51／51）   | 100%（9／9）   | 100%（32／32）   |
| [tools/local-integration/src/runtime-owner-host.ts](../../tools/local-integration/src/runtime-owner-host.ts)                                 | 4指標100% | 100%（45／45）   | 100%（45／45）   | 100%（11／11） | 100%（31／31）   |
| [tools/local-integration/src/runtime-owner.ts](../../tools/local-integration/src/runtime-owner.ts)                                           | 4指標100% | 100%（42／42）   | 100%（45／45）   | 100%（17／17） | 100%（22／22）   |
| [tools/local-integration/src/runtime.ts](../../tools/local-integration/src/runtime.ts)                                                       | 4指標100% | 100%（128／128） | 100%（130／130） | 100%（22／22） | 100%（90／90）   |
| [tools/local-integration/src/scheduled-interval.ts](../../tools/local-integration/src/scheduled-interval.ts)                                 | 4指標100% | 100%（12／12）   | 100%（13／13）   | 100%（3／3）   | 100%（2／2）     |
| [tools/local-integration/src/test-suites.ts](../../tools/local-integration/src/test-suites.ts)                                               | 4指標100% | 100%（23／23）   | 100%（25／25）   | 100%（5／5）   | 100%（26／26）   |
| [tools/local-integration/src/versions.ts](../../tools/local-integration/src/versions.ts)                                                     | 4指標100% | 100%（17／17）   | 100%（17／17）   | 100%（2／2）   | 100%（9／9）     |

計測要素が0件のファイルは次のとおりです。型のみ、空のエントリ、再exportであり、0件を動作検証済みの100%とは扱いません。

- [apps/evaluation/src/domain/evaluation-result.ts](../../apps/evaluation/src/domain/evaluation-result.ts)
- [apps/evaluation/src/worker.ts](../../apps/evaluation/src/worker.ts)
- [apps/interview/src/worker.local.ts](../../apps/interview/src/worker.local.ts)
- [apps/interview/src/worker.ts](../../apps/interview/src/worker.ts)
