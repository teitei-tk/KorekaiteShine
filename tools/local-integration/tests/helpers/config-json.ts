import { parseJson } from '@korekaite/api-contracts/json';

type ConfigValue = string | number | boolean | null | undefined | ConfigValue[] | ConfigObject;
export type ConfigObject = { [key: string]: ConfigValue };

export function objectAt(value: ConfigValue, ...path: string[]): ConfigObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('検査対象のJSONオブジェクトが不正です。');
  }
  if (path.length === 0) {
    return value;
  }
  const [key, ...rest] = path;
  return objectAt(value[key], ...rest);
}

export function parseObject(text: string): ConfigObject {
  return objectAt(parseJson(text));
}

export function objectArray(value: ConfigValue): ConfigObject[] {
  if (!Array.isArray(value)) {
    throw new TypeError('検査対象のJSON配列が不正です。');
  }
  return value.map((item) => objectAt(item));
}

export function stringValue(value: ConfigValue): string {
  if (typeof value !== 'string') {
    throw new TypeError('検査対象のJSON文字列が不正です。');
  }
  return value;
}

export function stringArray(value: ConfigValue): string[] {
  if (!Array.isArray(value)) {
    throw new TypeError('検査対象のJSON配列が不正です。');
  }
  return value.map((item) => stringValue(item));
}
