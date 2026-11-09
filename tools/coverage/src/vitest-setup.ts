import { readFileSync } from 'node:fs';
import { afterAll } from 'vitest';
import type { SourceCoverageData } from '@vitest/istanbul-lib-instrument';
import { startCapture } from './capture.ts';
import type { CoverageRun } from './merge.ts';

const { directory, run }: { directory: string; run: CoverageRun } = JSON.parse(
  readFileSync(process.env.KOREKAITE_COVERAGE_RUN!, 'utf8'),
);
const capture = startCapture(run, process.env.KOREKAITE_COVERAGE_SUITE!, directory);
const host = globalThis as typeof globalThis & {
  __coverage__?: Record<string, SourceCoverageData>;
};
// Vitest はファイルごとに終了フックで回収する。Node 子プロセスの強制終了用
// journal と同じカウンターに書くと、PCM の各サンプル処理まで同期 I/O になる。
const inherited = host.__coverage__;
host.__coverage__ = {};
afterAll(() => {
  try {
    capture.finish(host.__coverage__ ?? {}, 'complete');
  } finally {
    host.__coverage__ = inherited;
  }
});
