import { parseJson } from '@korekaite/api-contracts/json';
import type { JsonValue } from '@korekaite/api-contracts/json';

/** fixtureがDBへ保存したJSONでも、読取時はobjectの実体を確認する。 */
export function readFixtureObject(text: string): Record<string, JsonValue | undefined> {
  const value = parseJson(text);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('fixtureの保存JSONが不正です。');
  }
  return value;
}
