import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readCaptures } from './capture.ts';
import { checkCoverage } from './check.ts';
import { mergeMeasurements, type CoverageRun } from './merge.ts';
import { prepareRun } from './prepare.ts';
import { writeReports } from './report.ts';

export async function verifySavedCoverage(
  root: string,
  paths: readonly string[],
  revision: string,
) {
  const saved: { run: CoverageRun; directory: string } = JSON.parse(
    readFileSync(join(root, 'coverage', 'run.json'), 'utf8'),
  );
  const current = prepareRun(root, paths, revision, saved.run.requiredSuites).run;
  const identities = (run: CoverageRun) =>
    run.targets.map(({ path, sourceHash, instrumentationHash }) => ({
      path,
      sourceHash,
      instrumentationHash,
    }));
  if (
    saved.run.revision !== revision ||
    !isDeepStrictEqual(identities(current), identities(saved.run))
  ) {
    throw new Error('台帳が現在のソースと一致しません。再計測してください。');
  }
  const combined = mergeMeasurements(saved.run, readCaptures(saved.directory));
  const coverage = await writeReports(combined, join(root, 'coverage', 'combined'), root);
  checkCoverage(coverage);
  return coverage;
}
