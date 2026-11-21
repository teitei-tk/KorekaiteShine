import { parseJson } from '@korekaite/api-contracts/json';
import type { JsonValue } from '@korekaite/api-contracts/json';

export function jsonObject(value: JsonValue | undefined): Record<string, JsonValue> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('テストのJSONオブジェクトが不正です。');
  }
  return value;
}

export function readJsonObject(text: string): Record<string, JsonValue> {
  return jsonObject(parseJson(text));
}

export function requestUrl(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}
