export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** JSON文法だけを保証する。APIの構造検証は呼び出し側の生成validatorで行う。 */
export function parseJson(text: string): JsonValue {
  return JSON.parse(text) as JsonValue;
}
