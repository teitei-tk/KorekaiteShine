# Takumi GuardのCI導入検証

2026年11月7日確認。CIに匿名モードを組み込み、Shisho CloudへのOIDC連携は後続とします。[導入設計](../superpowers/specs/2026-11-07-takumi-guard-design.md)と[実装計画](../superpowers/plans/2026-11-07-takumi-guard.md)に従います。

## 固定版と取得経路

| 対象                          | 確認した動作                                                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| setup-takumi-guard-npm v1.4.0 | 匿名モードではOIDC交換を行わず、`NPM_CONFIG_USERCONFIG`・`NPM_CONFIG_REGISTRY`・`pnpm_config_registry`で後続ステップの取得先を設定する                                    |
| pnpm/action-setup v6.1.1      | `npm ci`で固定ロック付きのbootstrapを準備し、必要なら`pnpm self-update`を実行する。環境変数を引き継ぐため、このActionより前にGuardを配置する。storeキャッシュは既定で無効 |
| actions/setup-node v7.1.0     | `cache: pnpm`を外し、`package-manager-cache: false`で自動キャッシュも無効にする                                                                                           |
| openai/codex-action v1.13     | `npm install -g`でCodex CLIとResponses API proxyを取得する。registryを明示的に変更せず、ジョブの設定を引き継ぐ。資格情報隔離の方式は変更しない                            |

Guardの固定SHAは`14f07d0cbc739b42a1b7c70a04c2b84cd1318ddd`です。既存のgh-actions-lock v0.4.0で取得元情報とともにロックを生成しました。取得経路の静的確認と、Linux runner上の実行確認は区別します。

リポジトリ内には`.npmrc`とscope別registryの指定がなく、共有ロックファイルにも直接tarball URL・Git取得の指定はありませんでした。将来追加する場合は取得元を再確認します。Guardの環境変数はscope別registryを上書きしません。

## ローカルで確認した動作

Node.js 26.12.1、pnpm 12.15.0、macOSで確認しました。ネットワーク制限のあるサンドボックス外で、コマンド単位のregistry環境変数を設定しました。開発者の永続的なregistry設定は変更していません。

- Git管理済みファイルを一時ディレクトリへ展開し、空のstoreを指定して`pnpm install --frozen-lockfile --ignore-scripts`を実行しました。約46秒で成功し、ロックファイルのSHA-256は実行前後で一致しました。既存の公開後24時間の待機・信頼情報・依存ビルド保護は維持しています。この時間はmacOSでの1回の観測値で、CIの所要時間を保証しません。
- 公式の確認用パッケージ`@panda-guard/test-malicious`を、一時ディレクトリ・空のnpmキャッシュ・スクリプト無効で取得しました。GuardのメタデータURLから`403 Forbidden`と`Package blocked by security policy`が返り、npmは失敗終了しました。プロジェクトの依存には追加していません。
- `tools/docs/check-guard.ts`の実通信では、npmとpnpmの有効registry、`is-number@7.0.0`の正常取得、確認用パッケージの明示的な拒否を確認しました。成功時・失敗時の一時領域削除、通信障害・一般的な403・取得成功・設定不備の扱いは単体テストで確認します。

遮断確認は、固定したGuardホスト・確認用パッケージ・拒否理由を含むnpmのエラー行を確認します。npmまたはGuardの応答形式が変わった場合は失敗として扱い、実測後に判定とテストを更新します。通信障害を遮断成功に読み替えません。

## 通常検査

今回の変更だけを含むworktreeで`pnpm check`が成功しました。Node.js設定、Lint、整形、型検査、Vitest 551件、Markdown 72件を確認しました。追加したGuard確認の単体テストは7件です。`gh actions-lock --verify`も6 Workflowすべて成功しました。

commitフックの再検査では、既存の`recovery.test.ts`の「評価失敗直後に遅延通知を送り、scheduledを待たずに2回目を実行する」が1回失敗しました。8秒の確認時点でジョブは`pending`・実行回数0、初期化通知は未送信でした。実装・時間上限を変更せず単独再実行したところ成功しました。原因は未確定で、修正済みとは扱いません。その後、commit・push前フックの全件再実行はいずれも成功しました。

## CIと後続の確認

[PR #82](https://github.com/teitei-tk/KorekaiteShine/pull/82)の実装SHA `decb3575e099032debc859c40d1bbc345636cf7e`で、次を確認しました。CI変更はこのSHAで確定し、以降の変更は検証結果の文書更新です。

| 検査               | 結果と証拠                                                                                                                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 通常CI             | [実行42343354744](https://github.com/teitei-tk/KorekaiteShine/actions/runs/42343354744)の13ジョブが成功。Worker境界4分割・結合3分割、Guardの正常取得・遮断、Lint・整形・文書・型・単体・Actionsロックを確認 |
| Worker実時間検査   | [実行42343354794](https://github.com/teitei-tk/KorekaiteShine/actions/runs/42343354794)の3ジョブが成功。30・120・300秒の実時間再試行とDLQ配送を確認                                                         |
| 隔離受入の手動実行 | [実行42343385591](https://github.com/teitei-tk/KorekaiteShine/actions/runs/42343385591)の正常完了・拒否の2ケースが成功。公式Actionのnpm取得を含む経路と既存の隔離を確認                                     |

通常CIの12ジョブで依存インストールが成功し、ステップの所要時間は23〜104秒でした。この1回の並列実行では匿名モードのレート制限による失敗は観測していません。今後の応答時間やレート制限を保証する値ではありません。

PRと隔離受入の手動実行を実runnerで検証しました。main push・夜間実行・fork PR・Dependabotは実行していません。Workflowの同じジョブへGuardを組み込んでいることを静的に確認し、未検証のイベントを成功扱いにしていません。

Shisho Cloudの組織・Bot・信頼条件は作成していません。実AI、Cloudflareのクラウド、外部通知の設定も今回の対象外です。Guardは既知の悪性依存の取得を拒否する層であり、未知の攻撃やレジストリ外の取得まで防ぐものではありません。

## 公式資料

- [npm導入ガイド](https://shisho.dev/docs/ja/t/guard/quickstart/npm/)：匿名設定、pnpmのロック互換性、OIDC連携
- [Guard v1.4.0の実装](https://github.com/flatt-security/setup-takumi-guard-npm/blob/v1.4.0/action.yml)
- [pnpm v6.1.1の導入処理](https://github.com/pnpm/action-setup/blob/v6.1.1/src/install-pnpm/run.ts)
- [setup-node v7.1.0の入力](https://github.com/actions/setup-node/blob/v7.1.0/action.yml)
- [Codex Action v1.13の取得処理](https://github.com/openai/codex-action/blob/v1.13/action.yml)
