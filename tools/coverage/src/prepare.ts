import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { instrumentSource } from './instrument.ts';
import { describeTargets } from './targets.ts';
import type { CoverageRun } from './merge.ts';

export function prepareRun(
  root: string,
  paths: readonly string[],
  revision: string,
  requiredSuites: readonly string[],
) {
  const entries = describeTargets(paths);
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const targets = entries
    .filter((entry) => entry.included)
    .map(({ path }) => {
      const source = readFileSync(join(root, path), 'utf8');
      const result = instrumentSource(path, source);
      return {
        path,
        sourceHash: hash(source),
        instrumentationHash: hash(result.code),
        coverage: result.coverage,
      };
    });
  const run: CoverageRun = { runId: randomUUID(), revision, requiredSuites, targets };
  return { run, entries };
}
