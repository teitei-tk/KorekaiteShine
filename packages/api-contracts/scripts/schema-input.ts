import { parseJson } from '../json.ts';

type SchemaValue = string | number | boolean | null | undefined | SchemaValue[] | SchemaObject;
export type SchemaObject = { [key: string]: SchemaValue };

/** 生成されたJSONでも、利用するコンテナの構造を境界で検査する。 */
export function objectAt(value: SchemaValue, ...path: string[]): SchemaObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Schemaのオブジェクト構造が不正です。');
  }
  if (path.length === 0) {
    return value;
  }
  const [key, ...rest] = path;
  return objectAt(value[key], ...rest);
}

export function parseObject(text: string): SchemaObject {
  return objectAt(parseJson(text));
}

export function schemaMap(value: SchemaValue): Record<string, SchemaObject> {
  return Object.fromEntries(
    Object.entries(objectAt(value)).map(([key, child]) => [key, objectAt(child)]),
  );
}

export function objectArray(value: SchemaValue): SchemaObject[] {
  if (!Array.isArray(value)) {
    throw new TypeError('Schemaの配列構造が不正です。');
  }
  return value.map((child) => objectAt(child));
}

export function stringValue(value: SchemaValue): string {
  if (typeof value !== 'string') {
    throw new TypeError('Schemaの文字列が不正です。');
  }
  return value;
}
