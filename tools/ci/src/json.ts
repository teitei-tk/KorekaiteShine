/* eslint-disable typescript/no-restricted-types -- JSON境界はunknownで受け、実行時検証後にのみ公開する。 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue | undefined };
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function isJsonValue(value: unknown): value is JsonValue {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    (Array.isArray(value) && value.every((value) => isJsonValue(value))) ||
    (isRecord(value) && Object.values(value).every((value) => isJsonValue(value)))
  );
}
export function parseJson(text: string): JsonValue {
  const value: unknown = JSON.parse(text);
  if (!isJsonValue(value)) {
    throw new Error('JSON値が不正です。');
  }
  return value;
}
