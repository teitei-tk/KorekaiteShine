/** 固定fixtureやDOMから取得した必須値を実行時にも検査する。 */
export function requireValue<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error('探索に必要な値がありません。');
  }
  return value;
}
