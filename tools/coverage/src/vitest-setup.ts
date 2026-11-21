import { readFileSync } from 'node:fs';
import { afterAll } from 'vitest';
import type { SourceCoverageData } from '@vitest/istanbul-lib-instrument';

const host = globalThis as typeof globalThis & {
  __coverage__?: Record<string, SourceCoverageData>;
};
// 台帳検証を含め、Vitestでは同期journalを使わず終了フックで回収する。
// 計測済みモジュールは初期化時のカウンターを保持するため、importより先に切り替える。
const inherited = host.__coverage__;
host.__coverage__ = {};
const { readCoverageConfig, required } = await import('./schema.ts');
const { startCapture } = await import('./capture.ts');

const settings = readCoverageConfig(
  readFileSync(required(process.env.KOREKAITE_COVERAGE_RUN, 'KOREKAITE_COVERAGE_RUN'), 'utf8'),
);
const { run } = settings;
const directory = required(settings.directory, 'directory');
const capture = startCapture(
  run,
  required(process.env.KOREKAITE_COVERAGE_SUITE, 'KOREKAITE_COVERAGE_SUITE'),
  directory,
);

afterAll(() => {
  try {
    capture.finish(host.__coverage__ ?? {}, 'complete');
  } finally {
    host.__coverage__ = inherited;
  }
});
