import { required } from './schema.ts';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { instrumentSource } from './instrument.ts';
import type { CoverageRun } from './merge.ts';

/** Nodeと同じ原本を、Viteの構文変換より前に計測する。 */
export function coveragePlugin(
  root: string,
  run: CoverageRun,
  aliases: readonly { from: string; to: string }[] = [],
) {
  // Viteが解決した実パスに合わせる。仮想ディレクトリの対応付けも維持する。
  const physical = (path: string) => (existsSync(path) ? realpathSync(path) : resolve(path));
  const physicalRoot = physical(root);
  const physicalAliases = aliases.map(({ from, to }) => ({
    from: physical(from),
    to: physical(to),
  }));
  const targets = new Map(run.targets.map((target) => [target.path, target]));
  return {
    name: 'korekaite-test-coverage',
    enforce: 'pre' as const,
    transform(source: string, id: string) {
      const [file, query] = id.split('?');
      if (new URLSearchParams(query).has('url')) {
        return undefined;
      }
      const alias = physicalAliases.find(({ from }) => file.startsWith(`${from}/`));
      const path = relative(
        physicalRoot,
        alias ? resolve(alias.to, relative(alias.from, file)) : file,
      );
      const target = targets.get(path);
      if (!target) {
        return undefined;
      }
      const hash = (text: string) => createHash('sha256').update(text).digest('hex');
      if (alias && hash(source) !== target.sourceHash) {
        return undefined;
      }
      const result = instrumentSource(path, source);
      if (hash(source) !== target.sourceHash || hash(result.code) !== target.instrumentationHash) {
        throw new Error(`計測対象が変更されています: ${path}`);
      }
      return {
        code: result.code,
        map: {
          ...result.map,
          sources: result.map.sources.map((source) =>
            resolve(root, required(source ?? undefined, 'source map source')),
          ),
        },
      };
    },
  };
}
