const directoryReasons = new Map([
  ['node_modules', '依存パッケージ'],
  ['generated', '生成物'],
  ['dist', '生成物'],
  ['.git', '作業用ファイル'],
  ['.local', '作業用ファイル'],
  ['.wrangler', '作業用ファイル'],
  ['.cloudflare', '作業用ファイル'],
  ['.void', '作業用ファイル'],
  ['.tanstack', '作業用ファイル'],
  ['tests', 'テスト専用コード'],
  ['fixtures', 'テスト専用コード'],
  ['testing', 'テスト専用コード'],
]);

export interface TargetEntry {
  path: string;
  included: boolean;
  reason: string;
}

/** 対象外も理由付きで保存し、対象集合をレビュー可能にする。 */
export function describeTargets(paths: readonly string[]): TargetEntry[] {
  return [...new Set(paths)].sort().map((path) => {
    const parts = path.split('/');
    const name = parts.at(-1)!;
    let reason: string | undefined;
    if (!/\.[cm]?[jt]sx?$/u.test(name)) {
      reason = '対象言語外';
    } else if (/\.d\.[cm]?ts$/u.test(name)) {
      reason = '型宣言';
    } else if (/\.gen\.[cm]?[jt]sx?$/u.test(name)) {
      reason = '生成物';
    } else if (
      /\.(test|spec)\.[cm]?[jt]sx?$/u.test(name) ||
      /^vitest(?:\..+)?\.config\.[cm]?[jt]s$/u.test(name)
    ) {
      reason = 'テスト専用コード';
    } else {
      const excludedPart = parts.find(
        (part, index) =>
          directoryReasons.has(part) ||
          (part === 'coverage' && !(index === 1 && parts[0] === 'tools')),
      );
      reason =
        excludedPart === 'coverage' ? '作業用ファイル' : directoryReasons.get(excludedPart ?? '');
    }
    return { path, included: reason === undefined, reason: reason ?? '手書きTS/JS' };
  });
}

/** Gitが列挙した相対パスから、未importも含む手書き実行コードを選ぶ。 */
export function selectTargets(paths: readonly string[]): string[] {
  return describeTargets(paths)
    .filter((entry) => entry.included)
    .map((entry) => entry.path);
}
