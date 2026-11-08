import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { coveragePlugin } from './vite-plugin.ts';
import type { CoverageRun } from './merge.ts';

/** test環境の生成Vite設定からだけ読み込む。 */
export function runtimeCoveragePlugin(project: string) {
  const { root, run }: { root: string; run: CoverageRun } = JSON.parse(
    readFileSync(process.env.KOREKAITE_COVERAGE_RUN!, 'utf8'),
  );
  return coveragePlugin(root, run, [
    { from: join(project, 'src'), to: join(root, 'apps/web/src') },
  ]);
}
