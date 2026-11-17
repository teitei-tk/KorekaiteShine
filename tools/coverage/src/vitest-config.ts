import { readCoverageConfig, required } from './schema.ts';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { coveragePlugin } from './vite-plugin.ts';

export function vitestCoverageConfig(config: string, projects: readonly string[]) {
  const settings = readCoverageConfig(readFileSync(config, 'utf8'));
  const { run } = settings;
  const root = required(settings.root, 'root');
  return {
    root,
    plugins: [coveragePlugin(root, run)],
    test: {
      maxWorkers: 2,
      // CLI の子プロセス起動と同期計測を含む検査にも実行時間を確保する。
      testTimeout: 30_000,
      fileParallelism: true,
      reporters: ['verbose'],
      setupFiles: [fileURLToPath(new URL('vitest-setup.ts', import.meta.url))],
      projects: projects.map((project) => ({
        extends: true,
        test: {
          name: project,
          root: resolve(root, project),
          include: ['**/*.{test,spec}.?(c|m)[jt]s?(x)'],
          exclude: ['**/node_modules/**', '**/.git/**', '**/.local/**'],
        },
      })),
    },
  };
}
