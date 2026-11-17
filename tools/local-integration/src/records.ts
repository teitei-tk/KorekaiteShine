import type { BuildAudit } from './build-audit.ts';
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function readObject(value: unknown): Record<string, unknown> {
  if (!isObject(value)) {
    throw new TypeError('JSONオブジェクトが不正です。');
  }
  return value;
}
const string = (value: unknown): value is string => typeof value === 'string';
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item: unknown) => string(item));
function audit(value: unknown): value is BuildAudit {
  return (
    isObject(value) &&
    string(value.environment) &&
    string(value.outputDirectory) &&
    Array.isArray(value.modules) &&
    value.modules.every(
      (item: unknown) =>
        isObject(item) &&
        string(item.id) &&
        strings(item.imports) &&
        strings(item.dynamicImports) &&
        typeof item.isEntry === 'boolean',
    ) &&
    Array.isArray(value.outputs) &&
    value.outputs.every(
      (item: unknown) =>
        isObject(item) && string(item.fileName) && string(item.sha256) && strings(item.modules),
    )
  );
}
export function readBuildAudit(value: unknown): BuildAudit {
  if (!audit(value)) {
    throw new Error('ビルド監査情報が不正です。');
  }
  return value;
}
export type WorkerBinding = {
  type: string;
  name?: string;
  id?: string;
  value?: string;
  worker?: string;
  exportName?: string;
};
export type WorkerConfig = {
  name: string;
  workersDev?: boolean;
  previewUrls?: boolean;
  env: Partial<Record<string, WorkerBinding>>;
  triggers?: { type: string; name: string; deadLetterQueue?: string }[];
};
function binding(value: unknown): value is WorkerBinding {
  return (
    isObject(value) &&
    string(value.type) &&
    ['name', 'id', 'value', 'worker', 'exportName'].every(
      (key) => value[key] === undefined || string(value[key]),
    )
  );
}
function config(value: unknown): value is WorkerConfig {
  return (
    isObject(value) &&
    string(value.name) &&
    (value.workersDev === undefined || typeof value.workersDev === 'boolean') &&
    (value.previewUrls === undefined || typeof value.previewUrls === 'boolean') &&
    isObject(value.env) &&
    Object.values(value.env).every((item) => binding(item)) &&
    (value.triggers === undefined ||
      (Array.isArray(value.triggers) &&
        value.triggers.every(
          (item: unknown) =>
            isObject(item) &&
            string(item.type) &&
            string(item.name) &&
            (item.deadLetterQueue === undefined || string(item.deadLetterQueue)),
        )))
  );
}
export function readWorkerConfig(value: unknown): WorkerConfig {
  if (!config(value)) {
    throw new Error('本番Worker設定が不正です。');
  }
  return value;
}
