import { parseJson, isRecord } from './json.ts';
export function validateJobs(input: string): void {
  const jobs = parseJson(input);
  if (!isRecord(jobs)) {
    throw new Error('ジョブ結果が不正です。');
  }
  for (const name of [
    'verify-lockfile',
    'docs',
    'lint-format',
    'typecheck',
    'build',
    'test-plan',
  ]) {
    const job = jobs[name];
    if (!isRecord(job) || job.result !== 'success') {
      throw new Error(`必須ジョブが成功していません: ${name}`);
    }
  }
  const plan = jobs['test-plan'];
  const planned = isRecord(plan) && isRecord(plan.outputs) ? plan.outputs.has_tests : null;
  const { tests } = jobs;
  const status = isRecord(tests) ? tests.result : null;
  if (
    !((planned === 'true' && status === 'success') || (planned === 'false' && status === 'skipped'))
  ) {
    throw new Error('テストジョブの状態が計画と一致しません。');
  }
}
if (import.meta.main) {
  try {
    validateJobs(process.env.NEEDS_JSON ?? '');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
