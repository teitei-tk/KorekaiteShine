import { expect, test } from 'vitest';
import { validateJobs } from '../src/job-result.ts';
const jobs = () =>
  Object.fromEntries(
    ['verify-lockfile', 'docs', 'lint-format', 'typecheck', 'build', 'test-plan', 'tests'].map(
      (key) => [
        key,
        { result: 'success', ...(key === 'test-plan' ? { outputs: { has_tests: 'true' } } : {}) },
      ],
    ),
  );

test('必須ジョブ成功と、計画による意図した空集合だけを成功とする', () => {
  expect(() => validateJobs(JSON.stringify(jobs()))).not.toThrow(/./u);
  const empty = jobs();
  empty['test-plan'] = { result: 'success', outputs: { has_tests: 'false' } };
  empty.tests = { result: 'skipped' };
  expect(() => validateJobs(JSON.stringify(empty))).not.toThrow(/./u);
});

test('失敗、cancel、不明skip、計画欠損、不正JSONは失敗する', () => {
  for (const key of Object.keys(jobs())) {
    for (const state of ['failure', 'cancelled', 'skipped']) {
      const input = jobs();
      input[key] = { ...input[key], result: state };
      expect(() => validateJobs(JSON.stringify(input))).toThrow(/./u);
    }
  }
  for (const input of [
    '',
    '{}',
    'null',
    '[]',
    JSON.stringify({ ...jobs(), 'test-plan': { result: 'success' } }),
  ]) {
    expect(() => validateJobs(input)).toThrow(/./u);
  }
  const missing = jobs();
  delete missing.build;
  expect(() => validateJobs(JSON.stringify(missing))).toThrow(/./u);
});

test('testsの欠落とCLI環境の欠落を失敗にする', async () => {
  const { spawnSync } = await import('node:child_process');
  const missing = jobs();
  delete missing.tests;
  expect(() => validateJobs(JSON.stringify(missing))).toThrow('テストジョブ');
  for (const needs of [undefined, JSON.stringify(jobs()), 'invalid']) {
    const env = { ...process.env };
    delete env.NEEDS_JSON;
    if (needs !== undefined) {
      env.NEEDS_JSON = needs;
    }
    const result = spawnSync(
      process.execPath,
      [new URL('../src/job-result.ts', import.meta.url).pathname],
      { env, encoding: 'utf8' },
    );
    expect(result.status).toBe(needs === JSON.stringify(jobs()) ? 0 : 1);
  }
});
