import { createHash } from 'node:crypto';
import { relative, resolve } from 'node:path';
import { instrumentSource } from './instrument.ts';
import type { CoverageRun } from './merge.ts';

/** Nodeと同じ原本を、Viteの構文変換より前に計測する。 */
export function coveragePlugin(
  root: string,
  run: CoverageRun,
  aliases: readonly { from: string; to: string }[] = [],
) {
  const targets = new Map(run.targets.map((target) => [target.path, target]));
  return {
    name: 'korekaite-test-coverage',
    enforce: 'pre' as const,
    transform(source: string, id: string) {
      const [file, query] = id.split('?');
      if (new URLSearchParams(query).has('url')) {
        return;
      }
      const alias = aliases.find(({ from }) => file.startsWith(from + '/'));
      const path = relative(root, alias ? resolve(alias.to, relative(alias.from, file)) : file);
      const target = targets.get(path);
      if (!target) {
        return;
      }
      const hash = (text: string) => createHash('sha256').update(text).digest('hex');
      if (alias && hash(source) !== target.sourceHash) {
        return;
      }
      const result = instrumentSource(path, source);
      if (hash(source) !== target.sourceHash || hash(result.code) !== target.instrumentationHash) {
        throw new Error(`計測対象が変更されています: ${path}`);
      }
      return {
        code: result.code,
        map: { ...result.map, sources: result.map.sources.map((source) => resolve(root, source!)) },
      };
    },
  };
}
