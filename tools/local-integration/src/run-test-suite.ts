import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { realpathSync } from 'node:fs';
import { relative } from 'node:path';
import { createVitest } from 'vitest/node';
import { fileURLToPath } from 'node:url';
import { selectTestFiles, validateTestFiles } from './test-suites.ts';
import { stopProcessGroup } from './process.ts';

export async function runTestProcess(args: readonly string[], cwd: string): Promise<number> {
  const child = spawn(process.execPath, [...args], { cwd, stdio: 'inherit', detached: true });
  let interrupted: NodeJS.Signals | undefined;
  const interrupt = (signal: NodeJS.Signals) => {
    interrupted = signal;
    child.kill(signal);
  };
  const sigint = () => interrupt('SIGINT');
  const sigterm = () => interrupt('SIGTERM');
  process.on('SIGINT', sigint);
  process.on('SIGTERM', sigterm);
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        const cause = interrupted ?? signal;
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
  const vitest = await createVitest({ root, watch: false });
  try {
    return (await vitest.globTestSpecifications()).map((spec) =>
      relative(root, spec.moduleId).replaceAll('\\', '/'),
    );
  } finally {
    await vitest.close();
  }
}

async function main() {
  const [suite = '', ...extra] = process.argv.slice(2);
  const shard =
    extra[0] !== undefined && !extra[0].startsWith('-') ? Number(extra.shift()) : undefined;
  const cwd = fileURLToPath(new URL('../', import.meta.url));
  validateTestFiles(await discoverTestFiles(cwd));
  const files = selectTestFiles(suite, shard);
  const list = extra.indexOf('--list');
  if (list >= 0) {
    extra.splice(list, 1);
  }
  const vitest = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));
  return runTestProcess([vitest, list >= 0 ? 'list' : 'run', ...files, ...extra], cwd);
}

if (import.meta.main) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: Error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
