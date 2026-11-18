import { vitestCoverageConfig } from './tools/coverage/src/vitest-config.ts';

const runPath = process.env.KOREKAITE_COVERAGE_RUN;
if (!runPath) {
  throw new Error('coverageの実行計画が必要です。');
}
export default vitestCoverageConfig(runPath, [
  'apps/evaluation',
  'apps/interview',
  'apps/web',
  'packages/api-contracts',
  'packages/runtime-config',
  'tools/ai-review',
  'tools/docs',
  'tools/e2e',
  'tools/coverage',
  'tools/ci',
  'tools/local-integration',
]);
