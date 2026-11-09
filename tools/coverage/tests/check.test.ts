import { expect, test, vi } from 'vitest';
import { createCoverageMap } from '@vitest/istanbul-lib-coverage';
import { checkCoverage } from '../src/check.ts';
import { mergeMeasurements } from '../src/merge.ts';
import { createMergeFixture } from './fixtures/measurement.ts';

test('表示が100%に丸められても網羅数が総数に足りなければ拒否する', () => {
  const { run, records, path } = createMergeFixture();
  const map = mergeMeasurements(run, records);
  const file = map.fileCoverageFor(path);
  const summary = file.toSummary();
  summary.data.functions = { total: 100000, covered: 99999, skipped: 0, pct: 100 };
  vi.spyOn(file, 'toSummary').mockReturnValue(summary);
  expect(summary.functions.pct).toBe(100);
  expect(() => checkCoverage(map)).toThrow('src/choose.ts (functions)');
});
test('1行だけ未実行の結果を拒否する', () => {
  const { run, records, path } = createMergeFixture();
  const map = mergeMeasurements(run, records);
  const file = map.fileCoverageFor(path);
  file.statementMap['999'] = { start: { line: 10, column: 0 }, end: { line: 10, column: 5 } };
  file.s['999'] = 0;
  expect(map.getCoverageSummary().lines.total - map.getCoverageSummary().lines.covered).toBe(1);
  expect(() => checkCoverage(map)).toThrow('src/choose.ts (lines, statements)');
});
test('同じ行の別文が実行済みでも未実行の文を拒否する', () => {
  const { run, records, path } = createMergeFixture();
  const map = mergeMeasurements(run, records);
  const file = map.fileCoverageFor(path);
  file.statementMap['999'] = structuredClone(file.statementMap['0']);
  file.s['999'] = 0;
  expect(() => checkCoverage(map)).toThrow('src/choose.ts (statements)');
});
test('1分岐だけ未実行でも100%を拒否する', () => {
  const { run, records, path } = createMergeFixture();
  const map = mergeMeasurements(run, records);
  map.fileCoverageFor(path).b['0'][1] = 0;
  expect(() => checkCoverage(map)).toThrow('src/choose.ts (branches)');
});

test('1関数だけ未実行でも100%を拒否する', () => {
  const { run, records, path } = createMergeFixture();
  const map = mergeMeasurements(run, records);
  map.fileCoverageFor(path).f['0'] = 0;
  expect(() => checkCoverage(map)).toThrow('src/choose.ts (functions)');
});

test('全ファイルの4指標を満たす結果だけを受理する', () => {
  const { run, records } = createMergeFixture();
  expect(() => checkCoverage(mergeMeasurements(run, records))).not.toThrow();
  const partial = mergeMeasurements({ ...run, requiredSuites: ['unit'] }, records.slice(0, 1));
  expect(() => checkCoverage(partial)).toThrow(
    'カバレッジ不足: src/choose.ts (lines, statements, branches)',
  );
});

test('空のレポートを100%と判定しない', () => {
  expect(() => checkCoverage(createCoverageMap({}))).toThrow('計測要素がありません');
  const { path, target } = createMergeFixture();
  const empty = {
    ...target.coverage,
    statementMap: {},
    fnMap: {},
    branchMap: {},
    s: {},
    f: {},
    b: {},
  };
  expect(() => checkCoverage(createCoverageMap({ [path]: empty }))).toThrow('計測要素がありません');
});
