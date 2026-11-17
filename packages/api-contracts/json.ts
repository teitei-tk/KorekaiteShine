export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** JSON文法だけを保証する。APIの構造検証は呼び出し側の生成validatorで行う。 */
export function parseJson(text: string): JsonValue {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON.parseの成功結果はJSON値。業務型への断定は行わない。
  return JSON.parse(text) as JsonValue;
}
