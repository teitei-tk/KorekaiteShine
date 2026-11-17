import { readCoverageConfig, required } from './schema.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { coveragePlugin } from './vite-plugin.ts';

/** test環境の生成Vite設定からだけ読み込む。 */
export function runtimeCoveragePlugin(project: string) {
  const settings = readCoverageConfig(
    readFileSync(required(process.env.KOREKAITE_COVERAGE_RUN, 'KOREKAITE_COVERAGE_RUN'), 'utf8'),
  );
  const { run } = settings;
  const root = required(settings.root, 'root');
  return coveragePlugin(root, run, [
    { from: join(project, 'src'), to: join(root, 'apps/web/src') },
  ]);
}
