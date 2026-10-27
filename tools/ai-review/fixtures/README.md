# PR #30の固定資料

`pr30-material.json.gz` は公開リポジトリのGit読み取り結果を固定した回帰テスト資料です。モデル応答・認証情報は含みません。gzip内のJSONは `pr`（対象SHA）と `replies`（Git引数のJSON文字列をキーとする応答）のみです。

- base: `7005f99cd129d122723616ad3c1b53b476e2757e`
- head: `07dd1ccf484a61de6436c4d510078b55018df474`
- 元PR: <https://github.com/teitei-tk/KorekaiteShine/pull/30>

`collectFromGit`に渡す読み取り関数で `git` の実応答を記録しています。30ファイルの差分、関連ファイルのbase/head/ancestor本文を含みます。CIのshallow cloneやネットワークに依存しません。テストはこの資料を現行の収集・分割処理へ通すため、過去の分割結果を正解として固定していません。

`large-review.test.ts`は計数・モデル応答だけを模擬し、費用台帳、出力検証、成果物保存・再読み込み、行スレッド投稿を通します。実トークン数・実費用・モデルの判断品質は実PRで別途確認します。
