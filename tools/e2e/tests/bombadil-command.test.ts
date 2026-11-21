import { expect, test, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  localProcessEnvironment,
  coverageEnvironment,
} from '../../local-integration/src/local-environment.ts';
import { parseExplorationOptions } from '../bombadil/options.ts';
import { executeCommand } from '../bombadil/run.ts';
import type { ExplorationOptions, ExplorationResult } from '../bombadil/types.ts';

test('コマンドは結果を終了コードへ変換し、停止信号を渡し、再現元欠落を起動前に拒否する', async () => {
  const stdout = vi.spyOn(console, 'log').mockImplementation(() => {
    /* この経路では追加の処理を行わない。 */
  });
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {
    /* この経路では追加の処理を行わない。 */
  });
  const previousInt = process.listeners('SIGINT');
  const previousTerm = process.listeners('SIGTERM');
  const codes: [ExplorationResult['status'], number][] = [
    ['passed', 0],
    ['violated', 2],
    ['incomplete', 3],
    ['infrastructure_error', 1],
  ];
  try {
    for (const [status, code] of codes) {
      const execute = vi.fn(async (options: ExplorationOptions, signal?: AbortSignal) => {
        expect(options).toEqual({ target: 'history', seconds: 60 });
        if (status === 'incomplete') {
          for (const [name, previous] of [
            ['SIGINT', previousInt],
            ['SIGTERM', previousTerm],
          ] as const) {
            const handler = process
              .listeners(name)
              .find((listener) => !previous.includes(listener));
            expect(handler).toBeDefined();
            handler?.(name);
          }
          expect(signal?.aborted).toBe(true);
        }
        return {
          status,
          actions: 1,
          reached: [],
          artifactDirectory: '/fixture/result',
        };
      });
      expect(await executeCommand(['--target', 'history', '--seconds', '60'], execute)).toBe(code);
      expect(execute).toHaveBeenCalledOnce();
      expect(process.listeners('SIGINT')).toEqual(previousInt);
      expect(process.listeners('SIGTERM')).toEqual(previousTerm);
    }
    const execute = vi.fn(async () => ({
      status: 'passed' as const,
      actions: 1,
      reached: [],
      artifactDirectory: '/fixture/result',
    }));
    expect(await executeCommand(['reproduce'], execute)).toBe(1);
    expect(execute).not.toHaveBeenCalled();
    expect(await executeCommand(['reproduce', '--reproduce', 'previous'], execute)).toBe(0);
    expect(execute).toHaveBeenCalledWith(
      { target: 'preparation', seconds: 120, reproduce: 'previous' },
      expect.any(AbortSignal),
    );
    expect(stdout).toHaveBeenCalled();
    expect(stderr).toHaveBeenCalled();
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
});
test('CLIのオプション終端は既定値を保ち、不正な対象は実際の入口でも起動前に終了コード1で拒否する', () => {
  expect(parseExplorationOptions(['--'])).toEqual({ target: 'preparation', seconds: 120 });
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('../bombadil/run.ts', import.meta.url)), '--target', 'other'],
    {
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        ...localProcessEnvironment(),
        ...coverageEnvironment('test'),
        NODE_OPTIONS: process.env.NODE_OPTIONS ?? '',
      },
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('探索を開始できませんでした。');
}, 25_000);
