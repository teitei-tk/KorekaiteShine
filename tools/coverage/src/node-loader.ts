import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SourceCoverageData } from '@vitest/istanbul-lib-instrument';
import { createCounterJournal } from './journal.ts';
import { startCapture } from './capture.ts';
import { instrumentSource } from './instrument.ts';
import type { CoverageRun } from './merge.ts';

const config = process.env.KOREKAITE_COVERAGE_RUN;
if (config) {
  const { root, directory, run }: { root: string; directory: string; run: CoverageRun } =
    JSON.parse(readFileSync(config, 'utf8'));
  const suite = process.env.KOREKAITE_COVERAGE_SUITE!;
  const capture = startCapture(run, suite, directory);
  const global = globalThis as typeof globalThis & {
    __coverage__?: Record<string, SourceCoverageData>;
  };
  const initial = global.__coverage__ ?? {};
  global.__coverage__ = createCounterJournal(`${capture.path}.events`, run.targets);
  for (const [path, counters] of Object.entries(initial)) {
    global.__coverage__[path] = counters;
  }
  const targets = new Map(run.targets.map((target) => [target.path, target]));
  registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      if (!url.startsWith('file:')) {
        return loaded;
      }
      const path = relative(root, fileURLToPath(url));
      const target = targets.get(path);
      if (!target) {
        return loaded;
      }
      const source = readFileSync(fileURLToPath(url), 'utf8');
      const result = instrumentSource(path, source);
      const hash = (text: string) => createHash('sha256').update(text).digest('hex');
      if (hash(source) !== target.sourceHash || hash(result.code) !== target.instrumentationHash) {
        throw new Error(`計測対象が変更されています: ${path}`);
      }
      return {
        ...loaded,
        format:
          loaded.format === 'commonjs' || loaded.format === 'commonjs-typescript'
            ? 'commonjs'
            : 'module',
        source: result.code,
      };
    },
  });
  process.once('exit', () => {
    const data =
      (globalThis as typeof globalThis & { __coverage__?: Record<string, SourceCoverageData> })
        .__coverage__ ?? {};
    // 失敗終了を期待するテストもあるため、suiteの成否は収集側で別に判定する。
    capture.finish(data, 'complete');
  });
}
