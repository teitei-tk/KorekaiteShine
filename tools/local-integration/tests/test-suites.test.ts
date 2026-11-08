import { expect, test } from 'vitest';
import { selectTestFiles } from '../src/test-suites.ts';

test('PR結合から長時間だけを除き、全結合と排他的に対応させる', () => {
  const short = selectTestFiles('integration-pr');
  const long = selectTestFiles('realtime');
  expect(short).toHaveLength(10);
  expect(short).toContain('tests/voice-interview.test.ts');
  expect(short).toContain('tests/interview-evaluation-worker.test.ts');
  expect(long).toEqual(['tests/realtime-retries.test.ts']);
  expect(short.filter((file) => long.includes(file)).length).toBe(0);
  expect(new Set(selectTestFiles('integration-all'))).toEqual(new Set([...short, ...long]));
});

test('境界4分割と結合3分割は元の集合を重複なく覆い、不正な指定を拒否する', () => {
  for (const [suite, count] of [
    ['boundary', 4],
    ['integration-pr', 3],
  ] as const) {
    const shards = Array.from({ length: count }, (_, i) => selectTestFiles(suite, i + 1));
    expect(shards.every((files) => files.length > 0)).toBe(true);
    expect(new Set(shards.flat()).size).toBe(shards.flat().length);
    expect(new Set(shards.flat())).toEqual(new Set(selectTestFiles(suite)));
    for (const bad of [0, -1, count + 1, 1.5, NaN]) {
      expect(() => selectTestFiles(suite, bad)).toThrow();
    }
  }
  expect(selectTestFiles('boundary')).toContain('tests/http-contract.test.ts');
  expect(selectTestFiles('integration-all')).not.toContain('tests/http-contract.test.ts');
  expect(() => selectTestFiles('unknown')).toThrow();
  expect(() => selectTestFiles('realtime', 1)).toThrow();
});

test('新規・削除されたテストの分類漏れを失敗させ、実ファイルの全件を覆う', async () => {
  const { discoverTestFiles } = await import('../src/run-test-suite.ts');
  const { fileURLToPath } = await import('node:url');
  const { validateTestFiles } = await import('../src/test-suites.ts');
  const files = await discoverTestFiles(fileURLToPath(new URL('../', import.meta.url)));
  expect(() => validateTestFiles(files)).not.toThrow();
  expect(() => validateTestFiles([...files, 'tests/forgotten.test.ts'])).toThrow();
  expect(() => validateTestFiles(files.slice(1))).toThrow();
  expect(() => validateTestFiles([])).toThrow();
  expect(() => validateTestFiles([...files, files[0]!])).toThrow();
});
