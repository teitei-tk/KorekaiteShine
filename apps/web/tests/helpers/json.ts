import { parseJson } from '@korekaite/api-contracts/json';
import type { JsonValue } from '@korekaite/api-contracts/json';

export function jsonObject(value: JsonValue): Record<string, JsonValue> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('テストのJSON値はオブジェクトである必要があります。');
  }
  return value;
}

export function parseObject(text: string | ArrayBuffer): Record<string, JsonValue> {
  if (typeof text !== 'string') {
    throw new TypeError('JSONテスト値は文字列である必要があります。');
  }
  return jsonObject(parseJson(text));
}
