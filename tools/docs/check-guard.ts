import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type CommandResult = { status: number | null; stdout: string; stderr: string };
export type CommandRunner = (
  program: 'npm' | 'pnpm',
  args: string[],
  cwd?: string,
) => CommandResult;

const runCommand: CommandRunner = (program, args, cwd) =>
  spawnSync(program, args, { cwd, encoding: 'utf8', timeout: 120_000 });

export function checkGuard(mode: 'registry' | 'download', run: CommandRunner = runCommand): void {
  for (const program of ['npm', 'pnpm'] as const) {
    const result = run(program, ['config', 'get', 'registry']);
    if (result.status !== 0 || result.stdout.trim() !== 'https://npm.flatt.tech/') {
      throw new Error(`${program}のregistryがTakumi Guardではありません`);
    }
  }
  if (mode === 'registry') {
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), 'korekaite-guard-'));
  try {
    const pack = (name: string) =>
      run(
        'npm',
        [
          'pack',
          name,
          '--ignore-scripts',
          '--json',
          '--cache',
          join(directory, 'cache'),
          '--fetch-retries=0',
          '--fetch-timeout=30000',
        ],
        directory,
      );
    if (pack('is-number@7.0.0').status !== 0) {
      throw new Error('正常なパッケージを取得できません');
    }
    const blocked = pack('@panda-guard/test-malicious');
    if (blocked.status === 0) {
      throw new Error('遮断確認用パッケージを取得できてしまいました');
    }
    if (
      blocked.status === null ||
      !/^npm (?:error|ERR!) 403 403 Forbidden - GET https:\/\/npm\.flatt\.tech\/@panda-guard%2ftest-malicious - Package blocked by security policy\r?$/im.test(
        blocked.stderr,
      )
    ) {
      throw new Error('Guardによる拒否を確認できません（通信・応答形式を確認してください）');
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== '--registry-only')) {
      throw new Error('引数は--registry-onlyのみ指定できます');
    }
    const mode = args.length === 1 ? 'registry' : 'download';
    checkGuard(mode);
    console.log(
      mode === 'registry'
        ? 'npmとpnpmのGuard registry設定を確認しました'
        : 'Guardの正常取得・悪性パッケージ遮断を確認しました',
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Guard確認に失敗しました');
    process.exitCode = 1;
  }
}
