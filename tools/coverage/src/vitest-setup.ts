import { readFileSync } from 'node:fs';
import { afterAll } from 'vitest';
import type { SourceCoverageData } from '@vitest/istanbul-lib-instrument';
import { startCapture } from './capture.ts';
import type { CoverageRun } from './merge.ts';

const { directory, run }: { directory: string; run: CoverageRun } = JSON.parse(
  readFileSync(process.env.KOREKAITE_COVERAGE_RUN!, 'utf8'),
);
const capture = startCapture(run, process.env.KOREKAITE_COVERAGE_SUITE!, directory);
afterAll(() => {
  const data =
    (globalThis as typeof globalThis & { __coverage__?: Record<string, SourceCoverageData> })
      .__coverage__ ?? {};
  capture.finish(data, 'complete');
});
