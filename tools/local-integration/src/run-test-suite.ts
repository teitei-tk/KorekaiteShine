import { boundaryTestFile, createBoundaryBundle } from './boundary-bundle.ts';
import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { realpathSync } from 'node:fs';
import { relative } from 'node:path';
import { createVitest } from 'vitest/node';
import { fileURLToPath } from 'node:url';
import { selectTestFiles, validateTestFiles } from './test-suites.ts';
import { stopProcessGroup } from './process.ts';

export async function runTestProcess(
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv = {},
): Promise<number> {
  const child = spawn(process.execPath, [...args], {
    cwd,
    env: { ...process.env, ...environment },
    stdio: 'inherit',
    detached: true,
  });
  const interruptedState = { interrupted: undefined as NodeJS.Signals | undefined };
  const interrupt = (signal: NodeJS.Signals) => {
    interruptedState.interrupted = signal;
    child.kill(signal);
  };
  const sigint = () => {
    interrupt('SIGINT');
  };
  const sigterm = () => {
    interrupt('SIGTERM');
  };
  process.on('SIGINT', sigint);
  process.on('SIGTERM', sigterm);
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        const cause = interruptedState.interrupted ?? signal;
        resolve(cause ? 128 + constants.signals[cause] : (code ?? 1));
      });
    });
  } finally {
    process.off('SIGINT', sigint);
    process.off('SIGTERM', sigterm);
    await stopProcessGroup(child);
  }
}

export async function discoverTestFiles(cwd: string): Promise<string[]> {
  const root = realpathSync(cwd);
  const context = await createVitest({ root, watch: false });
  try {
    return (await context.globTestSpecifications()).map((spec) =>
      relative(root, spec.moduleId).replaceAll('\\', '/'),
    );
  } finally {
    await context.close();
  }
}

async function main() {
  const [suite = '', ...extra] = process.argv.slice(2);
  const shard =
    extra.at(0) !== undefined && !extra[0].startsWith('-') ? Number(extra.shift()) : undefined;
  const cwd = fileURLToPath(new URL('../', import.meta.url));
  validateTestFiles(await discoverTestFiles(cwd));
  const files = selectTestFiles(suite, shard);
  const list = extra.indexOf('--list');
  if (list !== -1) {
    extra.splice(list, 1);
  }
  const vitest = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));
  const bundle =
    list === -1 &&
    files.some((file) => boundaryTestFile(file)) &&
    !process.env.KOREKAITE_BOUNDARY_BUNDLE
      ? await createBoundaryBundle()
      : undefined;
  try {
    return await runTestProcess(
      [vitest, list === -1 ? 'run' : 'list', ...files, ...extra],
      cwd,
      bundle ? { KOREKAITE_BOUNDARY_BUNDLE: bundle.directory } : {},
    );
  } finally {
    await bundle?.dispose();
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
