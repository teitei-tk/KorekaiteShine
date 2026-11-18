import { execFileSync } from 'node:child_process';
import { writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectCoverage } from './src/collect.ts';
import { mergeSavedShards } from './src/shards.ts';
import { verifySavedCoverage } from './src/verify.ts';

export async function main(
  args: readonly string[],
  root = fileURLToPath(new URL('../../', import.meta.url)),
) {
  const shard = /^--shard=[1-4]\/4$/u.test(args[0] ?? '');
  if (
    args.length > 1 ||
    (args.length === 1 && args[0] !== '--check' && args[0] !== '--merge-shards' && !shard)
  ) {
    throw new Error('使い方: node tools/coverage/run.ts [--check] | --shard=N/4 | --merge-shards');
  }
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  const paths = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    .split('\0')
    .filter(Boolean);
  const revision = git(['rev-parse', 'HEAD']).trim();
  if (args[0] === '--merge-shards') {
    return mergeSavedShards(root, paths, revision);
  }
  if (args[0] === '--check') {
    return verifySavedCoverage(root, paths, revision);
  }
  const require = createRequire(import.meta.url);
  const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
  return collectCoverage({
    root,
    paths,
    revision,
    ...(shard ? { shard: Number(args[0].slice(8, 9)) } : {}),
    commands: [
      {
        suite: 'generate',
        command: 'pnpm',
        args: ['--filter', '@korekaite/api-contracts', 'generate'],
      },
      {
        suite: 'api-codegen',
        command: 'pnpm',
        args: ['--filter', 'korekaite-shine-api-codegen', 'test'],
      },
      {
        suite: 'prepare',
        command: 'pnpm',
        args: ['prepare:integration'],
      },
      {
        suite: 'web-build',
        command: 'pnpm',
        args: ['--dir', 'apps/web', 'build:app'],
      },
      {
        suite: 'tests',
        command: process.execPath,
        args: [
          vitest,
          'run',
          '--config',
          join(root, 'vitest.coverage.config.ts'),
          ...(shard ? [args[0]] : []),
        ],
      },
    ],
  });
}

export async function cli(args: readonly string[]) {
  try {
    const coverage = await main(args);
    writeSync(1, `${JSON.stringify(coverage.getCoverageSummary().toJSON(), null, 2)}\n`);
  } catch (error) {
    writeSync(2, `${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await cli(process.argv.slice(2));
}
