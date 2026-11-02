# VoidとDrizzle ORMの連携調査

2026年11月2日確認。DBスキーマにDrizzle ORMを採用する利用者の判断を前提に、Void・TanStack Start・D1との接続方法を調査した記録です。以下は確認時点の公式資料に基づきます。固定版Void 1.4.0でのDB接続・マイグレーションの実動作は未検証です。

## 結論

VoidはDrizzle ORMを内蔵しており、組み合わせる方向は公式の想定に合います。D1用スキーマは`void/schema-d1`、クエリは`void/db`、テーブル参照は`@schema`を利用できます。共通のクエリ演算子も再公開され、基本利用のために`drizzle-orm`を別途追加する必要はありません。[Void Database](https://void.cloud/guide/database)

TanStack Start向け資料にも`void/db`の使用例があります。例はServer Functionsですが、本プロジェクトでは[ADR 0006](../adr/0006-typespec-api-contracts.md)に従い、通常のHTTP APIをServer Routesで実装します。DBスキーマをDrizzle、HTTP契約をTypeSpecで管理し、API境界で入出力を変換・検証する責務分担が適切と判断します。DB由来の検証スキーマをHTTP契約の別原本にはしません。[Void TanStack Start](https://void.cloud/integrations/frameworks/tanstack-start)

## Wranglerを直接操作しない運用

公式資料には、`void db generate`でSQLを生成し、`void db migrate`でローカルへ適用する流れがあります。生成SQLをレビューして管理し、`void db push`はマイグレーションファイルを残さない試作用途に限定するのが妥当です。[Void D1](https://void.cloud/guide/database/d1)、[Void Database CLI](https://void.cloud/reference/cli/database)

現行CLI資料では、直接Cloudflareへ配置するD1でも`void db migrate --remote`があり、バインディングの`migrations_dir`設定が必要です。D1のリモートStudioは未対応で、確認には`void db execute --remote`を使います。このため、通常のDB操作をVoid CLIへ寄せる見通しはあります。ただし、固定版で同じ操作が成立するかは別途確認が必要です。[Void Database CLI](https://void.cloud/reference/cli/database)

「Wranglerを直接操作しない」と「Void内部もWranglerを使用しない」は別の条件です。この調査は前者の運用を対象とし、後者を保証しません。クラウドへの適用・配置は実行していません。

## 固定版の静的確認

[npmのVoid 1.4.0配布情報](https://registry.npmjs.org/void/1.4.0)と配布コードを読み、次を確認しました。CLIやDB処理は実行していません。

- 依存宣言は`drizzle-orm ^0.45.4`と`drizzle-kit ^0.31.11`で、[共有ロックファイル](../../pnpm-lock.yaml)の解決版はそれぞれ0.45.4と0.31.11です。
- `dist/runtime/schema-d1.mjs`は`drizzle-orm/sqlite-core`を再公開し、`dist/runtime/db.mjs`は`drizzle-orm/d1`を使用します。
- `dist/db-Cdvr3zwG.mjs`の`runGenerate`はDrizzle Kitを呼び出します。リモートマイグレーションは`applyCloudflareD1Migrations`を経由し、`dist/cli/cloudflare-operation-process.mjs`で`runCf`へ委譲されます。利用者がWranglerコマンドを直接組み立てない運用を支える実装があります。

この確認は、最新資料の全機能や固定版での実動作を保証するものではありません。

## 導入前に確認する事項

- 固定版Void 1.4.0で、Server RoutesからD1への読み書き、スキーマの型推論、SQL生成・適用が成立するか。最新資料のAPIをそのまま使えるとは限りません。
- 開発サーバーとDB CLIが同じローカルDBを参照するか。現行資料ではバインディングID、`preview_database_id`、永続化先の設定が関係します。[Void D1](https://void.cloud/guide/database/d1)
- 生成SQLが既存データと外部キーを維持するか。現行CLIの新規DBに対する適用検査は、既存データの保持を保証しません。[Void Database CLI](https://void.cloud/reference/cli/database)
- 読み取りの整合性が要件に合うか。現行資料ではVoidのリクエストスコープを持たないフレームワークの処理は各DB操作をprimaryから開始し、リクエスト間のreplica遅延には別途注意が必要です。[Void D1](https://void.cloud/guide/database/d1)

Drizzle自体もD1・Workersをサポートし、`drizzle-orm/d1`からD1バインディングを直接渡す方法があります。ただし、確認時点のDrizzle資料は`@rc`の導入例を含むため、Void内蔵版と同一のAPIだとは扱いません。直接初期化する構成を選ぶ場合も、Voidとの依存・マイグレーション管理を一つに揃える検討が必要です。[Drizzle Cloudflare D1](https://orm.drizzle.team/docs/sqlite/connect-cloudflare-d1)

本調査は[ADR 0004](../adr/0004-tanstack-start-with-void.md)のStart・Voidの責務分担と、[MVPの設計基準](../spec/mvp.md#設計基準)を維持します。実装、依存追加、DB作成は行っていません。
