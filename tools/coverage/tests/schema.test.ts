import { expect, test } from 'vitest';
import {
  readMeasurement,
  readCoverageConfig,
  readCoverageData,
  readSourceMap,
  readCoverageDictionary,
  readTarget,
  required,
  readObject,
  readArray,
  readEndpoints,
} from '../src/schema.ts';
import { createMergeFixture } from './fixtures/measurement.ts';
test('計測の境界は壊れたカウンター・台帳・記録を拒否する', () => {
  const { run, records } = createMergeFixture();
  expect(JSON.stringify(readMeasurement(JSON.stringify(records[0])))).toBe(
    JSON.stringify(records[0]),
  );
  expect(
    JSON.stringify(readCoverageConfig(JSON.stringify({ run, directory: 'records' })).run),
  ).toBe(JSON.stringify(run));
  for (const value of [null, {}, { path: 'x', s: { '0': 'bad' } }]) {
    expect(() => readCoverageData(value)).toThrow(/計測/u);
  }
  expect(readCoverageConfig(JSON.stringify({ run }))).toEqual({ run });
  expect(() => readMeasurement('{"formatVersion":1}')).toThrow(/計測/u);
  expect(() => readCoverageConfig('{"run":{}}')).toThrow(/台帳/u);
});

test('source mapの任意フィールドとnullのsourceを検証する', () => {
  const valid = {
    version: 3,
    names: [],
    sources: [null, 'x.ts'],
    mappings: '',
    file: 'x.js',
    sourceRoot: '/src',
    sourcesContent: [null, 'const x = 1;'],
  };
  expect(readSourceMap(valid)).toEqual(valid);
  for (const value of [
    null,
    { ...valid, file: 1 },
    { ...valid, sourceRoot: 1 },
    { ...valid, sourcesContent: [1] },
  ]) {
    expect(() => readSourceMap(value)).toThrow('source map');
  }
});

test('補助カウンターと全体フラグの形式を検証する', () => {
  const { target } = createMergeFixture();
  const valid = { ...target.coverage, bT: { '0': [0, 1] }, all: true };
  expect(readCoverageData(valid)).toEqual(valid);
  for (const value of [
    { ...valid, bT: { '0': [false] } },
    { ...valid, all: 1 },
  ]) {
    expect(() => readCoverageData(value)).toThrow('カウンター');
  }
});

test('外部JSONの基本形と必須設定を拒否する', () => {
  expect(() => readCoverageDictionary([])).toThrow('辞書');
  expect(() => readTarget({})).toThrow('計測対象');
  expect(() => required('', 'fixture')).toThrow('fixture');
  expect(() => readObject(null)).toThrow('JSONオブジェクト');
  expect(() => readArray({})).toThrow('JSON配列');
  for (const value of [null, [{}], [{ id: 'x', webSocketDebuggerUrl: 1 }]]) {
    expect(() => readEndpoints(value)).toThrow('Inspector一覧');
  }
  expect(readEndpoints([{ id: 'x', webSocketDebuggerUrl: 'ws://localhost' }])).toEqual([
    { id: 'x', webSocketDebuggerUrl: 'ws://localhost' },
  ]);
});
