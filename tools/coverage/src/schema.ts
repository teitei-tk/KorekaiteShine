import type { SourceCoverageData, SourceMap } from '@vitest/istanbul-lib-instrument';
import type { CoverageRun, CoverageTarget, Measurement } from './merge.ts';
export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function parse(text: string): unknown {
  const value: unknown = JSON.parse(text);
  return value;
}
const string = (value: unknown): value is string => typeof value === 'string';
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => string(item));
const number = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const position = (value: unknown) => object(value) && number(value.line) && number(value.column);
const range = (value: unknown) => object(value) && position(value.start) && position(value.end);
// Istanbulの暗黙elseはstart/endが空。公開Range型との差異はこの既知形状だけを認める。
const branchRange = (value: unknown) =>
  range(value) ||
  (object(value) &&
    object(value.start) &&
    Object.entries(value.start).every(
      ([key, entry]) => (key === 'line' || key === 'column') && entry === undefined,
    ) &&
    object(value.end) &&
    Object.entries(value.end).every(
      ([key, entry]) => (key === 'line' || key === 'column') && entry === undefined,
    ));
const map = (value: unknown, validate: (value: unknown) => boolean) =>
  object(value) && Object.values(value).every((item) => validate(item));
function sourceMap(value: unknown): value is SourceMap {
  return (
    object(value) &&
    value.version === 3 &&
    strings(value.names) &&
    Array.isArray(value.sources) &&
    value.sources.every((item: unknown) => item === null || string(item)) &&
    string(value.mappings) &&
    (value.file === undefined || string(value.file)) &&
    (value.sourceRoot === undefined || string(value.sourceRoot)) &&
    (value.sourcesContent === undefined ||
      (Array.isArray(value.sourcesContent) &&
        value.sourcesContent.every((item: unknown) => item === null || string(item))))
  );
}
export function readSourceMap(value: unknown): SourceMap {
  if (!sourceMap(value)) {
    throw new Error('計測source mapが不正です。');
  }
  return value;
}
function coverage(value: unknown): value is SourceCoverageData {
  return (
    object(value) &&
    string(value.path) &&
    map(value.statementMap, range) &&
    map(
      value.fnMap,
      (item) =>
        object(item) &&
        string(item.name) &&
        range(item.decl) &&
        range(item.loc) &&
        number(item.line),
    ) &&
    map(
      value.branchMap,
      (item) =>
        object(item) &&
        string(item.type) &&
        range(item.loc) &&
        number(item.line) &&
        Array.isArray(item.locations) &&
        item.locations.every((entry: unknown) => branchRange(entry)),
    ) &&
    map(value.s, number) &&
    map(value.f, number) &&
    map(value.b, (item) => Array.isArray(item) && item.every((entry: unknown) => number(entry))) &&
    (value.inputSourceMap === undefined || sourceMap(value.inputSourceMap)) &&
    (value.bT === undefined ||
      map(
        value.bT,
        (item) => Array.isArray(item) && item.every((entry: unknown) => number(entry)),
      )) &&
    (value.all === undefined || typeof value.all === 'boolean')
  );
}
export function readCoverageData(value: unknown): SourceCoverageData {
  if (!coverage(value)) {
    throw new Error('計測カウンターが不正です。');
  }
  return value;
}
export function readCoverageDictionary(value: unknown): Record<string, SourceCoverageData> {
  if (!object(value)) {
    throw new Error('計測カウンター辞書が不正です。');
  }
  return Object.fromEntries(
    Object.entries(value).map(([path, data]) => [path, readCoverageData(data)]),
  );
}
function target(value: unknown): value is CoverageTarget {
  return (
    object(value) &&
    string(value.path) &&
    string(value.sourceHash) &&
    string(value.instrumentationHash) &&
    coverage(value.coverage)
  );
}
function run(value: unknown): value is CoverageRun {
  return (
    object(value) &&
    string(value.runId) &&
    string(value.revision) &&
    strings(value.requiredSuites) &&
    Array.isArray(value.targets) &&
    value.targets.every((item: unknown) => target(item))
  );
}
export function readTarget(value: unknown): CoverageTarget {
  if (!target(value)) {
    throw new Error('計測対象が不正です。');
  }
  return value;
}
export function readMeasurement(text: string): Measurement {
  const value = parse(text);
  if (
    !object(value) ||
    value.formatVersion !== 1 ||
    !string(value.captureId) ||
    !string(value.runId) ||
    !string(value.revision) ||
    !string(value.suite) ||
    (value.status !== 'complete' && value.status !== 'failed' && value.status !== 'incomplete') ||
    (value.failure !== undefined && !string(value.failure)) ||
    !Array.isArray(value.files) ||
    !value.files.every((item: unknown) => target(item))
  ) {
    throw new Error('計測記録が不正です。');
  }
  return {
    formatVersion: 1,
    captureId: value.captureId,
    runId: value.runId,
    revision: value.revision,
    suite: value.suite,
    status: value.status,
    ...(value.failure === undefined ? {} : { failure: value.failure }),
    files: value.files,
  };
}
export function readCoverageConfig(text: string): {
  run: CoverageRun;
  root?: string;
  directory?: string;
} {
  const value = parse(text);
  if (
    !object(value) ||
    !run(value.run) ||
    (value.root !== undefined && !string(value.root)) ||
    (value.directory !== undefined && !string(value.directory))
  ) {
    throw new Error('計測台帳が不正です。');
  }
  return {
    run: value.run,
    ...(typeof value.root === 'string' ? { root: value.root } : {}),
    ...(typeof value.directory === 'string' ? { directory: value.directory } : {}),
  };
}
export function required(value: string | undefined, name: string): string {
  if (value === undefined || value === '') {
    throw new Error(`計測設定がありません: ${name}`);
  }
  return value;
}
export type InspectorEndpoint = { id: string; webSocketDebuggerUrl: string };
export function readEndpoints(value: unknown): InspectorEndpoint[] {
  if (
    !Array.isArray(value) ||
    !value.every(
      (entry: unknown) => object(entry) && string(entry.id) && string(entry.webSocketDebuggerUrl),
    )
  ) {
    throw new Error('Inspector一覧が不正です。');
  }
  return value.map((entry: unknown) => {
    if (!object(entry) || !string(entry.id) || !string(entry.webSocketDebuggerUrl)) {
      throw new Error('Inspector一覧が不正です。');
    }
    return { id: entry.id, webSocketDebuggerUrl: entry.webSocketDebuggerUrl };
  });
}
export function readObject(value: unknown): Record<string, unknown> {
  if (!object(value)) {
    throw new TypeError('JSONオブジェクトが不正です。');
  }
  return value;
}
export function readArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError('JSON配列が不正です。');
  }
  return value;
}
