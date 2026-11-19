# CI高速化の設計

2026年11月17日。利用者の指示により、型検査器、Lint、時間シャード、PR差分選択、ジョブ並列化を一つのPRで切り替えます。

## 目的と制約

PRの結果待ち時間を短縮し、検査範囲を維持します。基準コミットは`605e2d73be79065e4535b0564eb497fb8f5ed200`です。

- [設計基準](../../spec/mvp.md#設計基準)と[契約生成のADR](../../adr/0006-typespec-api-contracts.md)に従い、TypeSpecを原本とし、生成物はGit管理しません。
- [環境分離](../../adr/0009-explicit-environments.md)と[診断機能の分離](../../adr/0011-access-and-diagnostics-isolation.md)を維持します。
- Guard、pnpmの公開後24時間待機、未審査ビルド拒否、Actionsロックを維持します。storeのみの再利用と毎回の再検証は[依存キャッシュ](#依存キャッシュ)に従います。tsrsの固定版だけは利用者承認の信頼ポリシー例外です。
- 通常CIが対象です。独立した実時間・全体カバレッジ検査を部分テストで代替せず、クラウド配置や実AI検証を追加しません。
- 同一runner内のworkspace検査は直列のままです。Vitestの共有キャッシュ削除競合を避け、検査種別の並列化は別runnerで行います。

## ジョブと生成処理

[通常CI](../../../.github/workflows/ci.yml)のWorkflow名`CI`を維持します。AIレビューの後続条件もWorkflow全体の成功です。

| ジョブ                 | 内容                                             | 依存                   |
| ---------------------- | ------------------------------------------------ | ---------------------- |
| verify-lockfile / docs | 既存のActionsロック・文書検査                    | なし                   |
| lint-format            | 型情報付きoxlint、oxfmt、Guard遮断確認           | なし                   |
| typecheck              | 全workspaceのtsrs型検査                          | なし                   |
| build                  | Web buildとAIレビュー隔離成果物のemit            | なし                   |
| test-plan              | 実テスト一覧、差分選択、時間履歴、シャード計画   | なし                   |
| tests                  | node・worker・boundary・integration・e2eのmatrix | test-plan              |
| ci-result              | 必須ジョブと全シャードの結果照合                 | 全ジョブ。失敗時も実行 |

`prepare:checks`で契約とWebのrouteTreeを生成します。Webの型検査・単体テストからbuildの重複実行を外し、各ジョブで必要な生成だけを行います。TanStack Startの型登録はrouterのソースに置き、ビルドが付与するfooterへ依存しません。ビルドを検証する結合テストは自身で成果物を作ります。

node_modules・pnpm storeを共有する前提のinstall待ちジョブは設けません。PR番号ごとのconcurrencyで古いPR実行だけをキャンセルします。

## 計画・実行結果

[tools/ci](../../../tools/ci/package.json)が計画、依存解析、割当、実行、結果集約を担当します。Vitestの実際の収集結果、Node testの互換性検査、E2E入口を一覧化します。local-integrationは既存のsuite所属を原本とします。

テストIDはproject・suite・相対ファイルパスを組み合わせます。計画にはschema、実行SHA、比較元・head、選択方式、依存グラフ版、時間履歴ID、一覧ハッシュ、選択理由、シャードごとのIDと予測時間を含めます。

選択対象を一度だけ割り当て、runnerへ渡したファイル集合と実際の実行結果を照合します。ファイル名の部分一致で余分なテストが実行されないようにします。欠損・重複・失敗を成功に換算しません。空集合は有効な計画がある場合だけ許可します。

`.ci/plan.json`、`.ci/results/*.json`、`.ci/history.json`をartifactに保存します。隠しディレクトリを含める設定を明示し、run IDとattemptで成果物を分離します。集約はNodeとローカルTypeScriptファイルだけで動作し、依存インストールを繰り返しません。

## 時間履歴とシャード

初期上限はnode 3、worker 3、boundary 4、integration 3、e2e 1です。空シャードは起動しません。

同じrunner種別・OS・Nodeメジャー・worker数の直近10成功サンプルの中央値を予測値とします。予測時間が長い順に、合計予測時間が最小のシャードへ追加します。同値はID順で決定的に処理します。未計測は同種のp75、履歴と初期実測値がともにない場合は均一重みです。

自動取得する履歴は成功したmain pushのartifactだけを使用し、リポジトリ・Workflow・schema・実行条件・30日の期限を検査します。PRは読取りのみです。取得失敗・破損時も全選択対象を割り当てます。履歴は割当にのみ使用し、対象選択や合否を変更しません。

main履歴がない初回の配分には[確認済み初期実測値](../../../tools/ci/timing-seed.json)を使います。2026年11月18日の成功run 44344193908（head `7d325e7`、attempt 1）の計画と17シャード・250件の結果を照合した値です。main実測があるIDはmainを優先し、不足分だけ補います。初期値にも同じ実行条件・出所・30日期限を適用します。PRの任意artifactを自動採用せず、更新時は成功run・head・日時・全対象の欠落と重複を確認してこのファイルをレビューします。使用元は計画の理由へ記録します。`CI_TEST_WEIGHTS=equal`で初期値も含めて無効化できます。

ファイル実行時間と準備・収集・実行・後処理を記録します。総runner時間と壁時計時間は異なるため、ジョブ増加だけで高速化を保証しません。

## PR差分選択

PRではmerge-baseとheadの差分に、実行するmerge commitとheadの差分を加えます。旧・新両グラフを逆方向に探索し、削除や消えた依存辺も扱います。main pushは全件です。

import、export、型import、tsconfig alias、workspace exportsを解析します。契約生成、SQL、fixture、Worker越境、E2Eのfeature/stepなどは非import依存として補います。未解決importの利用側とその利用先を保守的に含め、解析不能・比較不能・未分類の変更・ルート設定変更では全件へ戻します。新規・変更テスト自身は必ず選択します。

文書だけの変更でも、文書を入力とするテストがあれば選択します。単に拡張子だけで全テストを省略しません。回帰テストは削除、alias、未解決依存、グラフ解析失敗、E2E仕様変更、ルート設定変更、空集合を扱います。

## oxlint

[設定](../../../.oxlintrc.json)で全7カテゴリと適用可能なpluginを有効化し、型情報付きで警告も失敗にします。[ルール台帳](../../../tools/lint/rule-inventory.json)と[例外理由](../../../tools/lint/rule-exceptions.json)を固定版の一覧と照合します。アップデート時の未分類ルールを検査で検出します。

対象外フレームワーク、相互に矛盾するスタイル、未使用のReact Compiler専用検査、生成テンプレートの解決環境などは理由を記録します。DB SELECTの先頭は`.at(0)`で取得し、行の欠損を型に反映して実行時検査を維持します。非同期更新、外部SDK、テスト用の部分モックなど、型だけでは判定できない契約の不一致は[局所例外台帳](../../../tools/lint/scoped-exceptions.json)に具体的なファイル・規則・理由を記録します。設定との双方向照合により、理由のない追加や設定から削除した古い例外を拒否します。違反件数だけを理由にルールを無効化しません。

inlineの検査抑制は禁止します。`pnpm lint`は追跡対象のTS・JSをCompiler APIで解析し、コメント内のoxlint・ESLint抑制、Biome抑制、TypeScriptの無検査指定を拒否します。文字列・テンプレート中の検査fixtureは許可します。oxlint 1.93.0にはinline directiveを無効化するCLI flagがないため、独立した検査を必須にします。局所設定は行ではなくファイル全体へ適用されるため、将来そのファイルに追加されるコードにも該当規則が適用されない負担を引き受けます。対象を追加するときは台帳の理由と境界を再評価し、可能ならコードと型の修正で例外を減らします。

JSON境界は実行時検証と型の絞り込みを維持します。生成validatorを使う業務契約を手書き型へ置き換えません。独立配布するAIレビューや、依存なしで動かすCI集約のJSON補助は各ツール内に置きます。

## tsrs

`tsrs@0.25.0-ts7.1.0-beta`を固定し、型検査は`tsrs --fast --noEmit`へ変更します。AIレビュー隔離成果物のemitにもtsrsを使用します。生成器・依存解析が使うTypeScript Compiler APIと比較用の既存TypeScript依存は維持します。

[公式リポジトリ](https://github.com/oxc-project/tsrs)とnpmメタデータでApache-2.0ライセンスを確認しました。固定版のprovenanceには公式`.github/workflows/release.yml`とコミット`0f82b670e4ff861840b1315f8610816229e73e3a`が記録されています。pnpmの`no-downgrade`に拒否されたため、利用者の明示承認に基づきこの版だけを`trustPolicyExclude`へ追加しました。他の依存には適用しません。

ローカルのstrictな隔離fixtureで、数値から文字列への代入2件とnull参照1件を検査しました。tsc 7.0.2とtsrsは同じ位置でTS2322・TS18047を報告しました。tools/ciの同一ソース・tsconfigを各5回検査し、中央値はtsc 1,493.96 ms、tsrs 237.95 msでした。他作業と並行したローカル測定であり、CI全体の短縮率ではありません。

## 検証と運用

[共有検査](../../../tools/docs/README.md)の`pnpm check`に加え、build、結合検査、Actionsロックを確認します。選択器・実行器の検証には履歴破損、欠損結果、異常終了、部分一致、空集合、ジョブskipのケースを含めます。性能の最終評価はGitHub上の待機時間・最長シャード時間・総runner時間を分けて行います。

必須チェックの推奨対象は表示名`CI result`（ジョブID `ci-result`）です。リポジトリのbranch protectionはこのPRでは変更しません。従来のジョブ名を必須にしている場合は、管理者が新しい集約チェックへ更新する必要があります。

選択範囲に疑義があれば計画を全件へ戻し、時間履歴を破棄して均一割当できます。型検査器の復旧はscriptsと固定依存を戻します。実行失敗を省略で回避しません。

## 依存キャッシュ

通常CIのdocs、lint、typecheck、build、test-plan、testsで、既存の固定版setup-nodeによるpnpm storeキャッシュを使います。新しいActionや依存は追加しません。保護設定・lockfile・manifest・Node版・hook・依存準備実装・Guard確認・workflowをキーへ含め、キーの部分一致復元は行いません。集約ジョブは依存をインストールしません。

各ジョブでGuard設定とregistry確認を維持し、キャッシュ命中時もインストールを実行します。新しい一時ディレクトリをmetadataとstateへ指定し、過去のregistry応答やlockfile検証結果を再利用しません。固定lockfile、no-downgrade、公開後待機、ignore-scripts、store integrity検証を維持し、拒否・通信障害時は停止します。node_modulesはキャッシュしません。

固定版pnpmの隔離registry試験で、storeだけを再利用した場合はtarballの再取得を省略しつつmetadataを問い合わせること、現在の403・version削除・公開直後の版を拒否することを確認しました。metadata/stateも再利用した対照試験では、403へ切り替えても通信せず成功したため、この領域の共有は禁止します。store改変時は整合性検査を有効にするとtarballを再取得し、無効にすると改変内容を導入したため、有効設定を明示します。固定lockfileの内容とregistryの現行dist.integrityが異なる場合でも、固定lockfileの内容を使用する挙動はキャッシュの有無と別に扱います。

Guard実サービスの遮断確認は従来のCIステップで継続します。キャッシュなし・ありの速度はGitHub上の依存準備ステップで比較し、全体の高速化とは分けて評価します。テスト計画を待つジョブ依存の変更は本変更に含めません。

### GitHub上の初回測定

2026年11月18日、head `ea644658cf373af21d3ef0115615b743b7317c1d`の[CI実行](https://github.com/teitei-tk/KorekaiteShine/actions/runs/44133521590)で、先行ジョブが作成したstoreを後続シャードが復元することを確認しました。

| 対象                      | インストールステップ | 中央値 |
| ------------------------- | -------------------- | ------ |
| キャッシュ作成前の5ジョブ | 91〜104秒            | 95秒   |
| store復元後の14シャード   | 8〜16秒              | 11秒   |

同一実行内の観測値であり、CI全体の短縮率ではありません。cache-hitを確認したworker-1では579パッケージを再利用し、ダウンロードは0件でした。約316MBのキャッシュ復元には別途約5秒かかりました。Guardの実サービス遮断確認、lint、型検査、build、計画ジョブも成功しています。初回測定時点では全テスト完了前のため、CI全体の成功を示す記録ではありません。
