import { createNodePreload } from './preload.ts';
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startCapture, readCaptures } from './capture.ts';
import { mergeMeasurements } from './merge.ts';
import { prepareRun } from './prepare.ts';
import { writeReports } from './report.ts';

export interface CoverageCommand {
  suite: string;
  command: string;
  args: readonly string[];
}

export async function collectCoverage(options: {
  root: string;
  paths: readonly string[];
  revision: string;
  commands: readonly CoverageCommand[];
}) {
  const { root, paths, revision, commands } = options;
  const { run, entries } = prepareRun(root, paths, revision, [
    'inventory',
    ...commands.map((command) => command.suite),
  ]);
  const directory = join(root, 'coverage', 'runs', run.runId, 'records');
  mkdirSync(directory, { recursive: true });
  const config = join(root, 'coverage', 'run.json');
  writeFileSync(config, JSON.stringify({ root, directory, run, entries }));
  startCapture(run, 'inventory', directory).finish(
    Object.fromEntries(run.targets.map((target) => [target.path, target.coverage])),
    'complete',
  );
  const preload = createNodePreload(root, run, join(root, 'coverage', 'runs', run.runId));
  for (const command of commands) {
    const capture = startCapture(run, command.suite, directory);
    const logPath = join(root, 'coverage', 'runs', run.runId, `${command.suite}.log`);
    const output = openSync(logPath, 'w');
    let status: number | null;
    try {
      status = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(command.command, [...command.args], {
          cwd: root,
          stdio: ['ignore', output, output],
          env: {
            ...process.env,
            KOREKAITE_COVERAGE_RUN: config,
            KOREKAITE_COVERAGE_SUITE: command.suite,
            NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(preload)}`,
          },
        });
        child.once('error', reject);
        child.once('close', resolve);
      });
    } finally {
      closeSync(output);
    }
    capture.finish({}, status === 0 ? 'complete' : 'failed');
    if (status !== 0) {
      throw new Error(`計測suiteが失敗しました: ${command.suite} (${logPath})`);
    }
  }
  const records = readCaptures(directory);
  return writeReports(mergeMeasurements(run, records), join(root, 'coverage', 'combined'), root);
}
