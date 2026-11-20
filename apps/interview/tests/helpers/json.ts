import { parseJson } from '@korekaite/api-contracts/json';
import type { JsonValue } from '@korekaite/api-contracts/json';

export function jsonObject(value: JsonValue): Record<string, JsonValue> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('テストのJSON値はオブジェクトである必要があります。');
  }
  return value;
}

export function parseObject(text: string): Record<string, JsonValue> {
  return jsonObject(parseJson(text));
}
