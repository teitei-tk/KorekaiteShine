/** 検証済みの必須値を使う箇所でも、型だけのnon-null断定に依存しない。 */
export function requireValue<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new TypeError('検証済みの必須値がありません。');
  }
  return value;
}
