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

function exclusionReason(path: string): string | undefined {
  const parts = path.split('/');
  const name = parts.at(-1)!;
  if (!/\.[cm]?[jt]sx?$/u.test(name)) {
    return '対象言語外';
  } else if (/\.d\.[cm]?ts$/u.test(name)) {
    return '型宣言';
  } else if (/\.gen\.[cm]?[jt]sx?$/u.test(name)) {
    return '生成物';
  } else if (
    /\.(test|spec)\.[cm]?[jt]sx?$/u.test(name) ||
    /^vitest(?:\..+)?\.config\.[cm]?[jt]s$/u.test(name)
  ) {
    return 'テスト専用コード';
  } else {
    const excludedPart = parts.find(
      (part, index) =>
        directoryReasons.has(part) ||
        (part === 'coverage' && !(index === 1 && parts[0] === 'tools')),
    );
    return excludedPart === 'coverage'
      ? '作業用ファイル'
      : directoryReasons.get(excludedPart ?? '');
  }
}

/** 対象外も理由付きで保存し、対象集合をレビュー可能にする。 */
export function describeTargets(paths: readonly string[]): TargetEntry[] {
  return [...new Set(paths)].sort().map((path) => {
    const reason = exclusionReason(path);
    return {
      path,
      included: reason === undefined,
      reason: reason ?? '手書きTS/JS',
    };
  });
}

/** Gitが列挙した相対パスから、未importも含む手書き実行コードを選ぶ。 */
export function selectTargets(paths: readonly string[]): string[] {
  return describeTargets(paths)
    .filter((entry) => entry.included)
    .map((entry) => entry.path);
}
