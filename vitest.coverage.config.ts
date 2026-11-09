import { vitestCoverageConfig } from './tools/coverage/src/vitest-config.ts';

export default vitestCoverageConfig(process.env.KOREKAITE_COVERAGE_RUN!, [
  'apps/evaluation',
  'apps/web',
  'packages/api-contracts',
  'packages/runtime-config',
  'tools/ai-review',
  'tools/docs',
  'tools/coverage',
  'tools/local-integration',
]);
