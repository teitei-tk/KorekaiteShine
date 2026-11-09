import { expect, test } from 'vitest';
import { describeTargets, selectTargets } from '../src/targets.ts';

test('未importの実行ファイルと生成処理を残し、生成物・宣言・テスト用コードを除外する', () => {
  expect(
    selectTargets([
      'apps/web/src/not-imported.ts',
      'packages/api-contracts/scripts/generate-messages.ts',
      'tools/coverage/src/targets.ts',
      'apps/web/vite.config.ts',
      'apps/web/src/view.tsx',
      'apps/web/src/routeTree.gen.ts',
      'packages/api-contracts/generated/http/validators.mjs',
      'packages/api-contracts/generated/http/api.d.ts',
      'packages/example/types.d.mts',
      'apps/web/tests/helpers/dom.ts',
      'tools/local-integration/fixtures/evaluation.ts',
      'packages/database/testing/database.ts',
      'tools/docs/check.test.ts',
      'apps/web/vitest.config.ts',
      'node_modules/dependency/index.js',
      'apps/web/dist/index.js',
      'apps/web/.wrangler/tmp/worker.js',
      'coverage/audit/block-navigation.js',
      'docs/README.md',
    ]),
  ).toEqual([
    'apps/web/src/not-imported.ts',
    'apps/web/src/view.tsx',
    'apps/web/vite.config.ts',
    'packages/api-contracts/scripts/generate-messages.ts',
    'tools/coverage/src/targets.ts',
  ]);
});

test('対象台帳に採否と理由を残し、同じパスを二重に数えない', () => {
  expect(
    describeTargets([
      'src/main.ts',
      'src/main.ts',
      'generated/api.js',
      'types/api.d.ts',
      'tests/main.test.ts',
      'node_modules/dependency/index.js',
      'coverage/report.js',
      'README.md',
    ]),
  ).toEqual([
    { path: 'README.md', included: false, reason: '対象言語外' },
    { path: 'coverage/report.js', included: false, reason: '作業用ファイル' },
    { path: 'generated/api.js', included: false, reason: '生成物' },
    { path: 'node_modules/dependency/index.js', included: false, reason: '依存パッケージ' },
    { path: 'src/main.ts', included: true, reason: '手書きTS/JS' },
    { path: 'tests/main.test.ts', included: false, reason: 'テスト専用コード' },
    { path: 'types/api.d.ts', included: false, reason: '型宣言' },
  ]);
});
