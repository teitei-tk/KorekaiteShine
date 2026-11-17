import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkGuard } from '../../docs/check-guard.ts';
import type { CommandRunner } from '../../docs/check-guard.ts';

const runCommand: CommandRunner = (program, args) => {
  if (args[0] === 'install') {
    const result = spawnSync(program, args, { stdio: 'inherit', timeout: 600_000 });
    return { status: result.status, stdout: '', stderr: '' };
  }
  return spawnSync(program, args, { encoding: 'utf8', timeout: 30_000 });
};

export function installDependencies(run: CommandRunner = runCommand): void {
  checkGuard('registry', run);
  // storeだけを再利用する。metadataと過去の検証結果は毎回空の領域へ分離する。
  const directory = mkdtempSync(join(tmpdir(), 'ci-dependency-policy-'));
  try {
    const metadata = join(directory, 'metadata');
    const state = join(directory, 'state');
    mkdirSync(metadata);
    mkdirSync(state);
    const result = run('pnpm', [
      'install',
      '--frozen-lockfile',
      '--ignore-scripts',
      '--no-trust-lockfile',
      '--no-offline',
      '--no-prefer-offline',
      '--config.verify-store-integrity=true',
      `--config.cache-dir=${metadata}`,
      '--state-dir',
      state,
    ]);
    if (result.status !== 0) {
      throw new Error('依存の取得・検証に失敗しました。キャッシュのみでの続行はしません。');
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  installDependencies();
}
