import { expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { checkGuard, type CommandRunner } from './check-guard.ts';

// 外部npm/pnpmコマンドだけを置き換え、判定・一時領域の管理は実装を通す。
const registry = 'https://npm.flatt.tech/';
const blocked =
  'npm error 403 403 Forbidden - GET https://npm.flatt.tech/@panda-guard%2ftest-malicious - Package blocked by security policy';
const runner: CommandRunner = (program, args) => {
  if (args.join(' ') === 'config get registry') {
    return { status: 0, stdout: `${registry}\n`, stderr: '' };
  }
  if (program === 'npm' && args[0] === 'pack' && args.includes('--ignore-scripts')) {
    return args[1] === 'is-number@7.0.0'
      ? { status: 0, stdout: '[]', stderr: '' }
      : { status: 1, stdout: '', stderr: blocked };
  }
  throw new Error('想定外のコマンド');
};

it('正常なパッケージを取得でき、Guardが明示的に拒否した場合だけ遮断確認を成功にする', () => {
  expect(() => checkGuard('download', runner)).not.toThrow();
});

it('正常なパッケージも取得できない場合は遮断確認を成功にしない', () => {
  const unavailable: CommandRunner = (program, args, cwd) =>
    args[0] === 'pack' && args[1] === 'is-number@7.0.0'
      ? { status: 1, stdout: '', stderr: 'npm error code ENOTFOUND' }
      : runner(program, args, cwd);
  expect(() => checkGuard('download', unavailable)).toThrow('正常なパッケージを取得できません');
});

it('遮断確認用パッケージを取得できた場合は失敗する', () => {
  const allowed: CommandRunner = (program, args, cwd) =>
    args[0] === 'pack' && args[1] === '@panda-guard/test-malicious'
      ? { status: 0, stdout: '[]', stderr: '' }
      : runner(program, args, cwd);
  expect(() => checkGuard('download', allowed)).toThrow(
    '遮断確認用パッケージを取得できてしまいました',
  );
});

it('通信障害や一般的な403をGuardの明示的な拒否と区別する', () => {
  for (const result of [
    { status: 1, stdout: '', stderr: 'npm error code ENOTFOUND' },
    { status: 1, stdout: '', stderr: 'npm error code E403\nnpm error 403 Forbidden' },
    { status: null, stdout: '', stderr: blocked },
    { status: 1, stdout: '', stderr: blocked.replace('npm.flatt.tech', 'registry.npmjs.org') },
    { status: 1, stdout: blocked, stderr: '' },
  ]) {
    const unavailable: CommandRunner = (program, args, cwd) =>
      args[0] === 'pack' && args[1] === '@panda-guard/test-malicious'
        ? result
        : runner(program, args, cwd);
    expect(() => checkGuard('download', unavailable)).toThrow('Guardによる拒否を確認できません');
  }
});

it('npmまたはpnpmのregistryが異なる場合や設定確認に失敗した場合は停止する', () => {
  for (const program of ['npm', 'pnpm'] as const) {
    for (const result of [
      { status: 0, stdout: 'https://registry.npmjs.org/\n', stderr: '' },
      { status: 1, stdout: registry, stderr: 'config failed' },
      { status: null, stdout: registry, stderr: '' },
    ]) {
      const wrongRegistry: CommandRunner = (command, args, cwd) =>
        command === program ? result : runner(command, args, cwd);
      expect(() => checkGuard('registry', wrongRegistry)).toThrow(`${program}のregistry`);
    }
  }
});

it('registryだけの確認ではパッケージを取得しない', () => {
  const configOnly: CommandRunner = (program, args, cwd) => {
    if (args[0] !== 'config') {
      throw new Error('取得を実行しました');
    }
    return runner(program, args, cwd);
  };
  expect(() => checkGuard('registry', configOnly)).not.toThrow();
});

it('確認用の取得場所と空のキャッシュは成功時も失敗時も削除する', () => {
  for (const fail of [false, true]) {
    const directoryState = { directory: '' };
    const probe: CommandRunner = (program, args, cwd) => {
      if (args[0] === 'pack') {
        directoryState.directory = cwd ?? '';
        expect(existsSync(directoryState.directory)).toBe(true);
        expect(args).toContain(`${directoryState.directory}/cache`);
        if (fail) {
          throw new Error('command failed');
        }
      }
      return runner(program, args, cwd);
    };
    if (fail) {
      expect(() => checkGuard('download', probe)).toThrow('command failed');
    } else {
      checkGuard('download', probe);
    }
    expect(directoryState.directory).not.toBe('');
    expect(existsSync(directoryState.directory)).toBe(false);
  }
});
