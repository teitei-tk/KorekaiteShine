import { defineConfig } from 'vitest/config';
import { selectTestFiles } from './tools/local-integration/src/test-suites.ts';

// 通常の pnpm test と同じテスト群を、リポジトリ全体の分母で計測する。
export default defineConfig({
  test: {
    projects: [
      'packages/api-contracts',
      'packages/runtime-config',
      'tools/ai-review',
      'tools/docs',
      'apps/evaluation',
      'apps/web',
      'tools/local-integration',
    ].map((root, groupOrder) => ({
      root,
      configFile: false,
      test: {
        name: root,
        include:
          root === 'tools/local-integration'
            ? [...selectTestFiles('boundary')]
            : ['**/*.test.{ts,tsx}'],
        exclude: ['**/node_modules/**', '**/fixtures/**'],
        sequence: { groupOrder },
        // Worker起動を含む既存テストへの計測負荷を抑える。
        maxWorkers: 2,
      },
    })),
    coverage: {
      provider: 'v8',
      include: [
        'apps/*/src/**/*.{ts,tsx}',
        'apps/*/scripts/**/*.ts',
        'packages/*/{src,db,scripts}/**/*.ts',
        'tools/**/*.ts',
      ],
      exclude: [
        '**/node_modules/**',
        '**/generated/**',
        '**/*.d.ts',
        '**/*.test.{ts,tsx}',
        '**/tests/**',
        '**/fixtures/**',
        '**/dist/**',
        '**/*.config.ts',
        '**/routeTree.gen.ts',
      ],
      reportsDirectory: './coverage',
      reporter: ['text-summary', 'html', 'json', 'json-summary', 'lcov'],
      // 失敗した実行の部分的な数値を基準値として保存しない。
      reportOnFailure: false,
    },
  },
});
