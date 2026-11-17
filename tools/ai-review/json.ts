// 隔離環境へ単独配置するため、外部workspaceを実行時importしない。
// 辞書のundefinedは、存在しないJSON objectのプロパティ読取りを表す。
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue | undefined };

/** JSON文法だけを保証し、業務の構造検証は既存validatorへ委譲する。 */
export function parseJson(text: string): JsonValue {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON.parse成功値のJSON文法にだけ型を付ける。業務型へ断定しない。
  return JSON.parse(text) as JsonValue;
}

// validatorは、未指定プロパティをundefinedで表す既存のローカル呼出しも受け取る。
export type JsonInput =
  | string
  | number
  | boolean
  | null
  | undefined
  | JsonInput[]
  | { [key: string]: JsonInput };

export function isJsonObject(value: JsonInput): value is Record<string, JsonInput> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
