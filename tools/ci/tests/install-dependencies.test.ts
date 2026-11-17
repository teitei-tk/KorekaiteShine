import { existsSync } from 'node:fs';
import { expect, test } from 'vitest';
import { installDependencies } from '../src/install-dependencies.ts';
import type { CommandRunner } from '../../docs/check-guard.ts';

const allowed = { status: 0, stdout: 'https://npm.flatt.tech/\n', stderr: '' };

test('Guard以外のregistryではstoreの再利用前に停止する', () => {
  const calls: string[][] = [];
  const run: CommandRunner = (_program, args) => {
    calls.push(args);
    return { ...allowed, stdout: 'https://registry.npmjs.org/\n' };
  };
  expect(() => installDependencies(run)).toThrow(/registry/u);
  expect(calls.some((args) => args.includes('install'))).toBe(false);
});

test('再実行でもメタデータと検証状態は共有せず、失敗時も一時領域を削除する', () => {
  const metadataPaths: string[] = [];
  const run: CommandRunner = (_program, args) => {
    if (!args.includes('install')) {
      return allowed;
    }
    const cache = args.find((arg) => arg.startsWith('--config.cache-dir='));
    if (!cache) {
      throw new Error('新しいmetadata cacheが指定されていません');
    }
    const directory = cache.slice('--config.cache-dir='.length);
    metadataPaths.push(directory);
    expect(existsSync(directory)).toBe(true);
    expect(args).toContain('--frozen-lockfile');
    expect(args).toContain('--ignore-scripts');
    expect(args).toContain('--no-trust-lockfile');
    expect(args).toContain('--no-prefer-offline');
    expect(args).toContain('--no-offline');
    expect(args).not.toContain('--offline');
    return { status: 1, stdout: '', stderr: 'registry unavailable' };
  };
  expect(() => installDependencies(run)).toThrow(/依存/u);
  expect(() => installDependencies(run)).toThrow(/依存/u);
  expect(new Set(metadataPaths).size).toBe(2);
  expect(metadataPaths.every((directory) => !existsSync(directory))).toBe(true);
});
