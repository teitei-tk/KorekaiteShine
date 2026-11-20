import { isRecord, parseJson } from './json.ts';
import type { Plan, Result, Test, Shard, RunnerClass } from './types.ts';
export const runnerClasses: RunnerClass[] = ['node', 'worker', 'boundary', 'integration', 'e2e'];
const string = (value: unknown): value is string => typeof value === 'string';
const nullableString = (value: unknown): value is string | null => value === null || string(value);
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((value) => string(value));
const number = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const runner = (value: unknown): value is RunnerClass =>
  value === 'node' ||
  value === 'worker' ||
  value === 'boundary' ||
  value === 'integration' ||
  value === 'e2e';
const test = (value: unknown): value is Test =>
  isRecord(value) &&
  string(value.id) &&
  string(value.file) &&
  string(value.project) &&
  string(value.suite) &&
  runner(value.runnerClass);
const shard = (value: unknown): value is Shard =>
  isRecord(value) &&
  string(value.id) &&
  string(value.runner) &&
  runner(value.runnerClass) &&
  strings(value.tests) &&
  number(value.predictedMs);
export function isPlan(value: unknown): value is Plan {
  return (
    isRecord(value) &&
    value.schema === 1 &&
    string(value.sha) &&
    nullableString(value.baseSha) &&
    nullableString(value.headSha) &&
    (value.mode === 'all' || value.mode === 'affected') &&
    value.graphVersion === 1 &&
    nullableString(value.historyId) &&
    string(value.inventoryHash) &&
    strings(value.reasons) &&
    value.reasons.length > 0 &&
    Array.isArray(value.tests) &&
    value.tests.every((value) => test(value)) &&
    strings(value.selected) &&
    Array.isArray(value.shards) &&
    value.shards.every((value) => shard(value)) &&
    string(value.repository) &&
    string(value.workflow)
  );
}
const timings = (value: unknown) =>
  isRecord(value) &&
  number(value.prepareMs) &&
  number(value.collectMs) &&
  number(value.runMs) &&
  number(value.teardownMs);
const fileTimings = (value: unknown) =>
  isRecord(value) &&
  Object.values(value).every(
    (item) =>
      isRecord(item) &&
      number(item.prepareMs) &&
      number(item.collectMs) &&
      number(item.runMs) &&
      number(item.setupMs),
  );
export function isResult(value: unknown): value is Result {
  return (
    isRecord(value) &&
    value.schema === 1 &&
    string(value.sha) &&
    string(value.inventoryHash) &&
    string(value.shardId) &&
    (value.status === 'passed' || value.status === 'failed') &&
    strings(value.executed) &&
    isRecord(value.durations) &&
    Object.values(value.durations).every((value) => number(value)) &&
    number(value.elapsedMs) &&
    timings(value.timings) &&
    fileTimings(value.fileTimings) &&
    string(value.identity) &&
    (value.error === undefined || string(value.error))
  );
}
export function parsePlan(text: string): Plan {
  const value = parseJson(text);
  if (!isPlan(value)) {
    throw new Error('計画が不正です。');
  }
  return value;
}
export function parseResult(text: string): Result {
  const value = parseJson(text);
  if (!isResult(value)) {
    throw new Error('結果が不正です。');
  }
  return value;
}
