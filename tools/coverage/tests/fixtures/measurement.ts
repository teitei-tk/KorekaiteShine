import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import type { FileCoverageData } from '@vitest/istanbul-lib-coverage';
import { instrumentSource } from '../../src/instrument.ts';
import type { Measurement, CoverageRun } from '../../src/merge.ts';

export function createMergeFixture() {
  const path = 'src/choose.ts';
  const source = [
    'function choose(value: boolean): number {',
    '  if (value) { return 1; }',
    '  return 2;',
    '}',
  ].join('\n');
  const { code, coverage } = instrumentSource(path, source);
  const target = {
    path,
    sourceHash: createHash('sha256').update(source).digest('hex'),
    instrumentationHash: createHash('sha256').update(code).digest('hex'),
    coverage,
  };
  const run: CoverageRun = {
    runId: 'run-a',
    revision: 'a'.repeat(40),
    requiredSuites: ['unit', 'worker'],
    targets: [target],
  };
  const records: Measurement[] = [true, false].map((value, index) => {
    const executed: FileCoverageData = runInNewContext(
      code + `\nchoose(${value}); globalThis.__coverage__['src/choose.ts'];`,
    );
    return {
      formatVersion: 1,
      captureId: `capture-${index}`,
      runId: run.runId,
      revision: run.revision,
      suite: run.requiredSuites[index],
      status: 'complete',
      files: [{ ...target, coverage: executed }],
    };
  });

  return { path, target, run, records };
}
