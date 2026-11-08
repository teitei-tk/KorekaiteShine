import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { coveragePlugin } from './vite-plugin.ts';
import type { CoverageRun } from './merge.ts';

export function vitestCoverageConfig(config: string, projects: readonly string[]) {
  const { root, run }: { root: string; run: CoverageRun } = JSON.parse(
    readFileSync(config, 'utf8'),
  );
  return {
    root,
    plugins: [coveragePlugin(root, run)],
    test: {
      maxWorkers: 4,
      fileParallelism: true,
      reporters: ['verbose'],
      setupFiles: [fileURLToPath(new URL('./vitest-setup.ts', import.meta.url))],
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
