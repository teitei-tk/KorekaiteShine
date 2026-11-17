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
