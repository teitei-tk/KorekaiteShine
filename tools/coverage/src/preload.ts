import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { instrumentSource } from './instrument.ts';
import type { CoverageRun } from './merge.ts';

/** 起動前に必要なローダーだけを生成し、原本のマップで自己計測する。 */
export function createNodePreload(root: string, run: CoverageRun, directory: string): string {
  const original = new URL('./node-loader.ts', import.meta.url);
  const path = relative(root, fileURLToPath(original));
  if (!run.targets.some((target) => target.path === path)) {
    return original.href;
  }
  const generated = pathToFileURL(join(directory, 'node-loader.mjs'));
  writeFileSync(generated, instrumentSource(path, readFileSync(original, 'utf8')).code);
  const bootstrap = pathToFileURL(join(directory, 'node-preload.mjs'));
  writeFileSync(
    bootstrap,
    `
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
const config = JSON.parse(readFileSync(process.env.KOREKAITE_COVERAGE_RUN, 'utf8'));
const original = ${JSON.stringify(original.href)};
const generated = ${JSON.stringify(generated.href)};
if (config.run.targets.some(target => target.path === ${JSON.stringify(path)})) {
  registerHooks({ resolve(specifier, context, nextResolve) {
    return nextResolve(specifier, context.parentURL === generated ? { ...context, parentURL: original } : context);
  }});
  await import(generated);
} else { await import(original); }
`,
  );
  return bootstrap.href;
}
