import { expect, test } from 'vitest';
import { readMeasurement, readCoverageConfig, readCoverageData } from '../src/schema.ts';
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
  expect(() => readMeasurement('{"formatVersion":1}')).toThrow(/計測/u);
  expect(() => readCoverageConfig('{"run":{}}')).toThrow(/台帳/u);
});
