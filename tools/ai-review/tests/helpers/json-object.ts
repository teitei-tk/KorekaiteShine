import { isJsonObject, parseJson } from '../../json.ts';
import type { JsonInput } from '../../json.ts';

export function readJsonObject(text: string): Record<string, JsonInput> {
  const value = parseJson(text);
  if (!isJsonObject(value)) {
    throw new TypeError('試験のJSON記録はオブジェクトである必要があります。');
  }
  return value;
}
