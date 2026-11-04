// CI改名の移行期間と過去の実行履歴だけを許可する。
export function isSourceCi(path: string | undefined): boolean {
  return path === '.github/workflows/docs.yml' || path === '.github/workflows/ci.yml';
}
