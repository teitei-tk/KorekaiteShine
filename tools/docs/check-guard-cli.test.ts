import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, onTestFinished, test } from 'vitest';
function execute(args: string[], failure = false) {
  const root = mkdtempSync(join(tmpdir(), 'guard-cli-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const bootstrap = join(root, 'bootstrap.mjs');
  writeFileSync(
    bootstrap,
    `import cp from 'node:child_process'; import { syncBuiltinESMExports } from 'node:module';
cp.spawnSync = (program, args) => {
 if (${failure}) throw 'private fixture';
 if (!['npm','pnpm'].includes(program)) throw new Error('unexpected command');
 if (args.join(' ') === 'config get registry') return { status: 0, stdout: 'https://npm.flatt.tech/\\n', stderr: '' };
 if (program === 'npm' && args[0] === 'pack' && args[1] === 'is-number@7.0.0') return { status: 0, stdout: '[]', stderr: '' };
 if (program === 'npm' && args[0] === 'pack' && args[1] === '@panda-guard/test-malicious') return { status: 1, stdout: '', stderr: 'npm error 403 403 Forbidden - GET https://npm.flatt.tech/@panda-guard%2ftest-malicious - Package blocked by security policy' };
 throw new Error('unexpected arguments');
}; syncBuiltinESMExports();`,
  );
  return spawnSync(
    process.execPath,
    ['--import', bootstrap, fileURLToPath(new URL('./check-guard.ts', import.meta.url)), ...args],
    { encoding: 'utf8', timeout: 10000 },
  );
}
test('Guard CLIは既定で正常取得と明示的遮断の両方を確認する', () => {
  const result = execute([]);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('正常取得・悪性パッケージ遮断');
});
test('registry-onlyでは設定確認だけで正常終了する', () => {
  const result = execute(['--registry-only']);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('registry設定を確認');
});
test('未知の引数または余分な引数では失敗する', () => {
  for (const args of [['--other'], ['--registry-only', 'extra']]) {
    const result = execute(args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('引数は--registry-onlyのみ');
  }
});
test('Error以外の失敗も固定文言で報告し内部値を出力しない', () => {
  const result = execute([], true);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Guard確認に失敗しました');
  expect(result.stderr).not.toContain('private fixture');
});
