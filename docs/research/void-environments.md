# Voidの環境切替と複数Workerの調査

2026年11月2日確認。開発者が環境分離の実装前に参照する調査記録です。Void 1.4.0の配布物と現行公式資料を区別します。既存仕様の更新や構成全体の動作検証は行っていません。[設計基準](../spec/mvp.md#設計基準)、[面接DOのADR](../adr/0001-server-relayed-interviews.md)、[評価QueueのADR](../adr/0002-queued-evaluation.md)、[Void採用のADR](../adr/0004-tanstack-start-with-void.md)を前提とします。

## 環境を選ぶ方法

Void 1.4.0には、Rails.envに相当するアプリの環境選択を任せられるCLIオプションは確認できません。配布物の`dist/cli/cli.mjs`の`parseDeployArgs`と`parseDbArgs`は`strict: true`で引数を解析し、`--env`を定義していません。現行の[deployリファレンス](https://void.cloud/reference/cli/deploy)も同様です。`--platform`は配置基盤、`--project`はVoid platform上のプロジェクトを選びます。

独自変数`APP_ENV`を`development`・`test`・`production`の必須列挙値として検証し、共通の`packages/runtime-config`から各Workerの名前・binding・状態保存先を決める案が考えられます。`NODE_ENV`とは独立させます。1.4.0の`dist/project-paths-DGu_QZ_Q.mjs`にある`loadTypedVoidConfigFile`はjitiでTypeScript設定を評価するため、shellから渡した`process.env.APP_ENV`を設定計算に使えます。これは独自の規約であり、Void標準の環境機能ではありません。

Worker実行時にはVoid設定の`cloudflare.vars.APP_ENV`を渡します。固定版の実行確認で、raw binding設定は`cloudflare`配下へ置く必要があることを確認しました。同名を`env.ts`のserver keyにも登録すると、plaintext varsとsecretの扱いが競合するため避けます。現行資料ではルートの`.env`だけをローカル値として読み、shell値を優先します。`.env.production`や`.env.local`は非対応で、production buildは`.env`を読みません。[環境変数](https://void.cloud/guide/env-vars)、[設定](https://void.cloud/reference/config)

`VOID_REMOTE`はローカルコードから配備済みD1・KV・R2を使う切替であり、環境名ではありません。Void platform側のstageや配置方式も、アプリ側の環境名と同一視しません。現行の`deploy.cloudflare.mode: 'staged'`は公開前検証の方式です。1.4.0のplatform stageの詳細は未確認です。[Remote Development](https://void.cloud/guide/remote-dev)、[配置設定](https://void.cloud/reference/config#deploy-cloudflare-mode)

## 3 Workersへの適用案

相談上の前提は`apps/web`・`apps/interview`・`apps/evaluation`の3 Workers、Void経由のDrizzle利用、`packages/database`への唯一のD1 schemaとmigrationsの集約です。developmentとtestはローカル、productionはCloudflareに置く案です。

- D1は同一環境の3 Workersで1個を共有し、環境間では分離します。migrationの適用責任もdatabase側に集約します。
- 面接DOはinterviewが所有し、webから参照するbindingには所有Workerの`script_name`を指定します。同じクラス名だけでは別WorkerのDOを指せません。[DO設定](https://developers.cloudflare.com/workers/wrangler/configuration/#durable-objects)
- 評価Queueはwebとinterviewがproducer、evaluationがconsumerとなり、同じQueue名を明示します。DLQとそのconsumerもevaluation側で扱う案です。Voidの自動Queue生成だけでは、別Workerへの共有やDLQ設定は完結しません。[Void Queues](https://void.cloud/guide/queues)、[Queue設定](https://developers.cloudflare.com/queues/configuration/configure-queues/)

Cloudflare公式は、cross-Worker DOと分離Queueに複数設定を渡す単一devコマンド、またはViteの`auxiliaryWorkers`を案内しています。共通のlocal state保存先だけでDO・Queueの通信まで成立するとは判断できません。[複数Workerの開発](https://developers.cloudflare.com/workers/local-development/multi-workers/)、[Queueのローカル開発](https://developers.cloudflare.com/queues/configuration/local-development/)

Void 1.4.0の`dist/index.d.mts`では`voidPlugin`のオプションに`persistTo`と`auxiliaryWorkers`があります。単一dev runtimeを組む候補ですが、固定するCloudflare Viteプラグイン1.64.0とTanStack Startを含めた実連携は未検証です。

## 実装前に確認する範囲

1. 3 WorkersのDO呼び出し、Queue送信からconsumer・DLQまでの自動実行、D1共有を固定版の組み合わせで確認します。現行公式資料の対応をVoid独自runtimeの検証済み事実として扱いません。
2. database専用projectのDB CLIと開発サーバーが同じD1を参照する方法を確認します。開発サーバーが各projectへ保存するpersist情報と、database側の情報を同期する方法は未解決です。
3. 並列テストでは実行IDと並列slotごとに状態保存先・生成config・build出力を隔離します。同一テスト内の3 Workersは共有し、別テストやdevelopmentの状態には接続しないことを検証します。
4. 環境を切り替えた際に`.void`の生成物や`void.lock.json`のresource IDが別環境へ流用されない管理方法を確認します。`APP_ENV`の変更だけで安全に切り替わるとは扱いません。

配布物の確認対象はnpmの`void@1.4.0`です。確認時は`/tmp/korekaite-void-inspect/package`へ展開しました。一時パスは証拠の恒久保存先ではないため、再確認時は同じ版の配布物から上記ファイルと関数を参照してください。

## 2026年11月2日のローカル実行確認

上記の未検証項目のうち、[接続検証](../../tools/local-integration/README.md)で次を確認しました。Queue配送と診断ジョブ全体は後続タスクです。

- `auxiliaryWorkers`でWeb・Interview DO・Evaluationを同時に起動し、DO呼び出しと3 Workersの共有D1が成立しました。ビルド済み成果物のpreviewでも同じ接続を確認しました。
- DB CLIは環境別作業先から実行し、スキーマ・SQL・固定データはdatabaseパッケージの原本へリンクします。WebとCLIが生成した`.void/local-d1.json`のprojectRootとpersistRootが、環境別作業先と同じ状態保存先を示すことを検査しました。
- developmentと同一テスト実行の2つの並列番号を同時起動し、同じ主キーの別値とViteキャッシュが混ざらないことを確認しました。デバッグポートの競合は固定版Voidの`VOID_INSPECTOR_PORT=false`で回避します。
- EvaluationのscheduledイベントはCloudflare ViteのLocal Explorer APIで対象Workerを指定して起動し、応答のoutcomeとD1保存を確認しました。アプリの公開HTTP入口は追加していません。
- reset・seedは明示操作に限定し、起動・ビルドと排他します。ローカル操作のロックはNode.js内蔵SQLiteで保持し、アプリのD1とは別の生成先に置きます。別プロセスの競合拒否と、保持プロセス強制終了後の再取得を検証しました。

共有HTTP契約は環境識別子を含まない生成物です。ルートのテストではapi-contractsの生成を先行させ、後続パッケージから二重生成しません。型検査は既存の単独実行との互換性を保って順次実行します。契約生成物のない状態からも全テストが成功しました。
