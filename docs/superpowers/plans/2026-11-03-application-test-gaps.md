# アプリの不足テストを追加する実装計画

> **実行担当へ：** 実装開始の依頼を受けてから、`superpowers:executing-plans`または`superpowers:subagent-driven-development`でタスクごとに実行する。チェック欄は実際の検証後に更新する。

**目的：** 一覧・診断画面の操作と、評価・DO・契約処理の未検証の境界を自動テストで保護する。

**構成：** 純粋なロジックと画面のテストは所有アプリへ置く。D1・DO・複数Workerを必要とする検査は、既存の`tools/local-integration`へ追加する。既存の結合テストを同内容の単体テストで重複させない。

**技術：** 既存のVitest 5.0.5、React 19.3.1、Node.js 26.12.1、pnpm 12.15.0を維持する。画面操作用にReact Testing Library・user-event・jsdomを開発依存へ追加した。固定版と選定理由は[Webの案内](../../../apps/web/README.md#テストの配置)に記載する。

**仕様：** [MVP仕様書](../../spec/mvp.md)、[既存骨格の計画](2026-11-02-local-worker-skeleton.md)、[ADR 0010](../../adr/0010-queue-contracts-and-job-control.md)、[ADR 0011](../../adr/0011-access-and-diagnostics-isolation.md)、[ADR 0012](../../adr/0012-idempotent-diagnostics-api.md)、[コードレビュー基準](../../../CODING_STANDARDS.md)。追加対象は、このチャットで確認した8項目の不足テスト。

## 対象と進め方

調査・実装の比較元は`f05f0ba`。利用者の実装依頼に従い、タスク1〜8の実装と検証を完了した。チェック欄は各タスクの検証結果を示す。

### 実装記録

| タスク                      | コミット  | 追加・移動したテスト    |
| --------------------------- | --------- | ----------------------- |
| 1：一覧画面                 | `4fe5c62` | 10件追加                |
| 2：診断画面                 | `e54a8df` | 11件追加                |
| 3：クライアント・エラー整形 | `ef0513f` | 15件追加                |
| 4：再試行・実行制御         | `9c341a6` | 11件追加、既存6件を移動 |
| 5：通知配送                 | `7161979` | 8件追加                 |
| 6：DO入口                   | `4848cfe` | 3件追加                 |
| 7：Schema参照               | `0a65247` | 7件追加                 |

通常テストは446件から511件へ増えた。実行制御6件は移動であり、新規追加の65件には含めない。

### 優先順位と依存関係

| 優先順位 | タスク | 追加する保護                                             |
| -------- | ------ | -------------------------------------------------------- |
| 高       | 1・2   | 一覧・診断画面の操作、非同期応答の競合、再送時の冪等キー |
| 高       | 3・4   | クライアントの異常応答、再試行回数・待機時間の境界       |
| 中       | 5・6   | 通知の部分失敗、DO入口の拒否と副作用の防止               |
| 中       | 7      | Schema参照の循環・欠落・エスケープ                       |
| 最後     | 8      | 全体検証とテスト配置の案内                               |

タスク2はタスク1のDOM環境を使う。タスク3〜7は機能上は独立しているが、共有ロックファイルとローカル実行環境の競合を避け、記載順に進める。タスク8は1〜7の完了後に行う。Interview・Evaluationの既存の結合テストは維持し、アプリ配下にテストがないことだけを理由に同じ検査を増やさない。

| 方針                                            | 利点と負担                                                           | 本計画での扱い                       |
| ----------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------ |
| DOMで画面操作、ローカルWorkerで永続化境界を検査 | 応答順序と失敗を短時間で再現できる。DOM検査用の依存が増える          | 推奨案                               |
| 画面ケースをすべて実ブラウザE2Eへ追加           | ブラウザ込みで確認できる。遅延応答の制御、起動、後処理の負担が増える | 今回は採用せず、既存の接続検査を維持 |
| 静的HTML・関数の検査だけを追加                  | 追加依存は少ない。クリックと非同期状態遷移が未検証のまま残る         | 目的を満たさないため不採用           |

上の選択は計画作成者の提案であり、新しい画面仕様の合意ではない。画面は現行の表示・操作を検査し、明らかになった不具合だけを最小限修正する。新しい機能や判断の分かれる振る舞いが必要になった場合は、仕様を確認してから実装する。

対象外はカバレッジ100%の計測・閾値設定、全テストの移動、正式評価・音声・Accessの実装、クラウド操作、実AI、秘密値の利用、push・PR。型や定数の値を写すだけのテスト、空の本番Worker入口だけを検査するテストは追加しない。

## 共通の制約と検証方法

- [設計基準](../../spec/mvp.md#設計基準)の責務分離と既存ADRを維持する。アプリ同士の実装importを増やさない。
- `curly`・`Date`禁止・`unknown`型禁止を維持する。日時はTemporal、テスト用時計は既存の注入点とVitestの仮想時計を使う。
- 依存は実行時にNode・React・Vitestとの互換性を確認し、完全な版番号で固定する。pnpmの公開後24時間待機、信頼情報検証、インストールスクリプト禁止を緩めない。実装時に検証して追加する。
- テストを1件ずつ追加し、毎回ルートの`pnpm test`で結果を確認する。不具合を再現した場合はRed→最小修正→Greenの順で進める。
- 既存動作の回帰テストが初回から成功した場合、失敗を作るために仕様を変えない。対象の処理を一時的に誤らせるとテストが失敗することを必要に応じて確認し、変更を戻す。移動した既存テストは新規Redとして数えない。
- ローカルD1・DO検査は実行IDで分離したtest環境のみを使う。開発DBや本番リソースを変更しない。テスト補助入口は`tools/local-integration/fixtures`へ置き、本番成果物に含めない。
- 固定sleepで応答を待たない。画面は制御可能なPromiseと表示条件、Workerは既存の期限付きpollを使う。DOM・fetch差し替え・時計・Worker・一時DBは成功／失敗の双方で後処理する。
- 各タスクは関連ファイルだけをcommitする。フックを無効化しない。実行中のテストと生成・ビルドを競合させない。

## 重点的に確認する条件

| 条件                                                 | 期待する結果                                                   | 担当    |
| ---------------------------------------------------- | -------------------------------------------------------------- | ------- |
| 先の一覧要求が再取得より遅く完了する                 | 最新要求の成功・失敗表示を古い応答で上書きしない               | タスク1 |
| 診断開始の応答を失った後、シナリオを変更して再送する | 元のシナリオと冪等キーを保持する。新規実行だけ新しいキーを使う | タスク2 |
| Retry-Afterが既定待機より長い、または不正            | 長い待機を尊重し、不正値を次回時刻へ保存しない                 | タスク4 |
| 複数通知の途中で送信に失敗する                       | 失敗通知を未送信のまま残し、後続の別通知を送信する             | タスク5 |
| 保存済みDOに別のジョブIDを渡す                       | 元の保存値を保持し、別ジョブの確認結果や通知を作らない         | タスク6 |

## タスク1：一覧画面の操作テストを追加する

**変更先：** `apps/web/package.json`、`apps/web/vitest.config.ts`、`apps/web/src/routes/index.tsx`、`pnpm-lock.yaml`。

**追加先：** `apps/web/tests/interviews-page.test.tsx`、`apps/web/tests/helpers/dom.ts`。

**インターフェース：** 現行の`InterviewPage()`を名前付きexportにし、ルートの`component`として引き続き使う。画面のpropsやHTTP契約は増やさない。補助ファイルはDOMの後処理だけを担当し、業務状態を模擬しない。

- [x] Webの開発依存へReact Testing Library・user-event・jsdomと必要なpeer依存を固定版で追加する。既存の`tests/**/*.test.ts`に`.test.tsx`を加える。DOMテストだけ`@vitest-environment jsdom`を指定し、既存HTTPテストのNode環境を維持する。
- [x] `afterEach`で`cleanup()`とfetchなどの差し替えを解除する。jsdomのURLを固定し、NodeのRequest／Responseが使えることを確認する。実クライアントを通し、fetch境界で契約に合う応答と応答順序を制御する。
- [x] 次のケースを一つずつ追加する。読み込み中／2件の一覧と日本時間の日時・状態ラベル／0件／取得失敗／再取得中に前の結果を消す／失敗後の再取得成功／古い成功・古い失敗が最新要求を上書きしない。アンマウント後の応答も次の画面に混入しないことを確認する。
- [x] 各ケースを`pnpm test`で確認する。主要assertionは`getByRole('status')`の件数・読み込み表示、`getByRole('alert')`のエラー、行の内容、fetch要求回数。Reactの内部stateやHTML全体のsnapshotを期待値にしない。
- [x] 本体の変更はexportと再現した不具合の修正に限定する。終了時に`pnpm check`が成功し、一覧API・日時表示の既存テストも通ることを確認する。
- [x] タスクの変更を`test: 面接一覧画面の操作と応答競合を検証`としてcommitする。

## タスク2：診断画面の操作テストを追加する

**追加先：** `apps/web/tests/diagnostics-page-interactions.test.tsx`。

**参照・必要時の修正先：** `apps/web/src/diagnostics/page.tsx`、`apps/web/tests/diagnostics-page.test.ts`。

**インターフェース：** `DiagnosticPage()`、`DiagnosticResult({ result })`は維持する。タスク1のDOM環境・後処理を使う。`createDiagnosticRun`をモックせず、実クライアントのfetch境界で受付・失敗・状態応答を返す。

- [x] 初期化後の操作有効化、選択したシナリオでの開始、受付結果の表示を一つずつ検査する。既存のSSR初期無効化テストは残す。
- [x] 応答消失→シナリオ変更→「同じ実行を再送」の順に操作し、2要求の本文と冪等キーが同じであることを検査する。「新しい実行を開始」では変更後のシナリオと別キーを使う。
- [x] 送信中・状態取得中の操作無効化と、再描画前の連続操作でも要求が重複しないことを検査する。ボタンのdisabledだけでなく実際の要求数をassertする。
- [x] 受付前は状態取得できず、受付後は対象jobIdへGETすることを検査する。ジョブの`failed`は診断結果として表示し、HTTP失敗とは区別する。
- [x] 状態取得失敗・契約外応答→再取得成功、入力検証エラーのcode・details・requestId表示、新規開始時の前回結果消去を一つずつ検査する。
- [x] ケース追加ごとに`pnpm test`、終了時に`pnpm check`を通し、必要な本体修正だけを含めて`test: 診断画面の再送と状態遷移を検証`としてcommitする。

## タスク3：Webクライアントとエラー整形の境界を補う

**変更先：** `apps/web/tests/client.test.ts`、`apps/web/tests/diagnostics-client.test.ts`。

**追加先：** `apps/web/tests/diagnostics-errors.test.ts`。

**インターフェース：** `getInterviews(baseUrl, fetcher)`、`createDiagnosticRun(scenario, options).start()`、`getDiagnosticStatus(jobId, options)`、`bodyValidationDetails(errors)`を直接検査する。公開シグネチャは変更しない。

- [x] 一覧取得のHTTP 500と通信例外、診断開始のHTTP 409・503と契約外202本文、状態取得のHTTP 404・503を1ケースずつ追加する。エラー本文を成功結果へ返さないことをassertする。
- [x] 別の`createDiagnosticRun`には異なる固定UUIDを返すnewIdを注入し、各要求のキーが異なることを確認する。同じ実行の再送テストは既存のものを維持する。
- [x] 入力エラー以外の400本文を`DiagnosticValidationError`として扱わないことを検査する。説明文を変更してもcodeに基づく分類が変わらないことを確認する。
- [x] エラー整形は、未定義errorsで空配列、requiredで`REQUIRED`、追加項目で`UNRECOGNIZED_FIELD`、formatで`INVALID_FORMAT`を検査する。項目名`a~/b`が`/a~0~1b`になることをassertする。
- [x] 各ケースの`pnpm test`と最終`pnpm check`が成功したら、`test: Webクライアントと入力エラーの境界を補強`としてcommitする。

## タスク4：Evaluationの単体テストを所有アプリへ置く

**追加先：** `apps/evaluation/tests/retry-policy.test.ts`。

**移動先：** `tools/local-integration/tests/execution-control.test.ts`を`apps/evaluation/tests/execution-control.test.ts`へ移す。

**変更先：** `apps/evaluation/package.json`、必要なら`apps/evaluation/tsconfig.json`、`pnpm-lock.yaml`。不具合が出た場合だけ`src/domain/retry-policy.ts`を修正する。

**インターフェース：** `retryDelayMs(attemptNumber, failure): number | null`、`maxEvaluationAttempts`、既存の`runEvaluationAttempt`を維持する。Evaluationの`test`を`vitest run`とし、Vitestは既存と同じ5.0.5へ固定する。

- [x] 再試行可能な失敗の1・2・3回目が30,000・120,000・300,000ms、4回目がnullになることを検査する。最大試行回数は4として既存仕様を保つ。
- [x] `retryable: false`なら待機せずnull、Retry-Afterが短い場合は既定値、長い場合は指定値を採用することを一つずつ検査する。例えば1回目の10,000msは30,000ms、60,000msは60,000msを期待する。
- [x] 再試行可能な1回目について、`retryAfterMs`が負数・NaN・Infinityなら例外になることを個別に検査する。終端判定後に不要な入力検査を強制する仕様変更は行わない。
- [x] ケース追加ごとに`pnpm test`を実行する。既存の実行制御6ケースを移動してimportを修正し、旧位置との二重実行・ケース削除がないことを確認する。仮想時計で120秒・180秒の境界を引き続き検査する。
- [x] `pnpm check`が成功したら`test: 評価の再試行方針と実行制御をアプリ側で検証`としてcommitする。

## タスク5：通知配送の境界をローカルD1で検査する

**追加先：** `tools/local-integration/tests/dispatch-notifications.test.ts`。

**変更候補：** `tools/local-integration/fixtures/evaluation.ts`、`tools/local-integration/fixtures/api.evaluation-test.ts`。本体は`apps/evaluation/src/application/dispatch-notifications.ts`を検査する。

**インターフェース：** test専用probeに`dispatchForTest(now: number, failJobId?: string)`を用意する。実D1と本物の`dispatchNotifications`を使い、送信関数だけを要求記録・指定jobIdでの失敗へ差し替える。返すのは送信要求の用途・操作・jobId・delaySecondsと実際の集計。D1のsentAtも独立して照合する。

- [x] 固定nowから予定時刻が過去・一致・1ms後・1,001ms後のケースで、delaySecondsが0・0・1・2になることを一つずつ検査する。固定時計を用い、実時間で待たない。
- [x] 86,400秒ちょうどは送信し、上限より1ms先は未送信で残す。`nextAttemptAt`がoutbox予定時刻より遅い場合にも、早く通知しないことを確認する。
- [x] 予定時刻の異なる3ジョブを準備し、中央の送信だけを失敗させる。前後の2件が送信済み、中央は未送信、集計が`outboxSent: 2`・`outboxDeferred: 1`になることをassertする。復旧後は中央だけを送る。
- [x] test専用probeはtest以外で公開しない。送信関数の差し替えによる検査を実Queue配送成功とは表現せず、既存の実Queue結合テストを残す。
- [x] 各ケースの`pnpm test`と最終`pnpm check`を通す。本番成果物からprobeが除外される既存検査も成功させ、`test: 通知配送の時刻境界と部分失敗を検証`としてcommitする。

## タスク6：InterviewのDO入口の拒否条件を検査する

**追加先：** `tools/local-integration/tests/check-object-guards.test.ts`。

**変更候補：** `tools/local-integration/fixtures/api.check-object-test.ts`、`tools/local-integration/fixtures/interview.ts`、必要ならtest専用設定を組む`tools/local-integration/src/runtime.ts`。

**インターフェース：** 本物の`CheckObject.initializeCheck(jobId)`とDO storageを使う。既存probeへtest専用の「DO選択用IDと呼び出しjobIdを別々に指定する」操作を足す。本体へテスト用メソッドを追加しない。

- [x] 不正UUIDをDO入口へ直接渡し、拒否と保存・通知の副作用なしを確認する。HTTP入口だけで拒否してDOまで到達しない試験にしない。
- [x] 有効な診断ジョブA・Bを作る。A用DOをAで初期化後、同じDOへBを渡す。拒否され、Aの初回日時が保持され、Bの保存確認・notifyが増えないことをassertする。
- [x] 独立したtest用Worker設定で、対象DOのAPP_ENVだけを許可外値にして呼び出す。D1・DO namespace・Queue名・保存先はtestのままとし、初期化が副作用前に拒否されることを確認する。本番環境を起動したり、本番成果物へ診断を含めたりしない。
- [x] ケース追加ごとに`pnpm test`を実行し、既存の初回日時保持・停止回復も通ることを確認する。終了時に`pnpm check`を通し、`test: 診断DOの入力と対応関係を検証`としてcommitする。

## タスク7：契約Schemaの参照抽出を単体検査する

**追加先：** `packages/api-contracts/tests/reachable-schema.test.ts`。

**対象：** `packages/api-contracts/scripts/reachable-schema.ts`。生成器と公開HTTP契約は変更しない。

**インターフェース：** `withReachableSchemas(schema, components)`を既存の構造のまま呼ぶ。

- [x] A→Bの参照を含む入力でA・Bだけが出力され、未参照Cを含めないことを検査する。
- [x] A→B→Aの循環で終了し、各Schemaを一度だけ含むことを検査する。
- [x] 不在の参照先、外部URLの参照を個別に与え、成功結果を返さず例外となることを検査する。
- [x] 配列内の参照と、`#/components/schemas/a~0~1b`からキー`a~/b`を解決するケースを追加する。入力オブジェクトを変更しないことも確認する。
- [x] 各ケースの`pnpm test`と最終`pnpm check`を通す。生成validatorの既存テストも維持し、`test: 契約Schemaの参照抽出を検証`としてcommitする。

## タスク8：全体確認と検査の案内を更新する

**変更先：** `apps/web/README.md`、`tools/local-integration/README.md`。**追加先：** `apps/evaluation/README.md`。

- [x] 単体・画面・結合テストの所在を記載する。Interviewには実ランタイム検査があることを示し、空のtestスクリプトを追加しない。新規依存の固定版と選定理由をWebの案内へ記録する。
- [x] `pnpm check`を実行し、既存＋追加ケースがすべて成功することを確認する。テスト移動による減少と新規追加を区別し、除外設定で既存ケースを落としていないことを確認する。
- [x] test専用probeと設定の変更を含むため、最後に`pnpm test:integration`を一度実行する。既存の実時間17ケース、開発データ保持、本番診断除外の検査を維持する。開発保持行の準備が必要な新規環境では、既存手順の`pnpm prepare:integration`を使い、resetは行わない。
- [x] 追加ケースと対象処理の対応、再現した不具合、未検証のブラウザ固有挙動を記録する。jsdom成功をCSS・実ブラウザ・クラウドの検証成功とは扱わない。
- [x] 共有の文書検査を含む`pnpm check`の成功を確認し、案内文書をcommitする。直前に同一内容で成功済みの検査は、変更や未解決の懸念がない限り重複実行しない。

## 完了条件

- 一覧と診断画面の利用者操作をDOMで自動検査できる。
- 再試行・クライアント・通知・DO・Schema・エラー整形の上記ケースが追加されている。
- Evaluationの実行制御6ケースが所有アプリへ移り、ルートの検査で実行される。
- 既存の単体・契約・D1／DO境界・実時間統合テストを減らしていない。
- `pnpm check`と`pnpm test:integration`が成功し、開発データ・本番除外条件を維持する。
- カバレッジ計測、クラウド操作、実AI、依頼外の機能追加を行っていない。

## 画面テスト方式の参照先

- [React Testing Libraryのセットアップ](https://testing-library.com/docs/react-testing-library/setup/)：Vitestでの明示的なcleanupの扱い。
- [Vitestのテスト環境](https://main.vitest.dev/config/environment)：ファイル単位でjsdomを選択する方式。実装時は固定版5.0.5の型・動作でも確認する。

実装結果と検証範囲は各アプリとローカル接続検証のREADMEを参照する。
