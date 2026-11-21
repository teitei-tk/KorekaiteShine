import type * as ChildProcessModule from 'node:child_process';
import type * as FileSystem from 'node:fs/promises';
import { ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { expect, test, vi } from 'vitest';
import { launchBrowser, launchBombadil, launchRuntime } from '../bombadil/processes.ts';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn<typeof ChildProcessModule.spawn>(),
  fork: vi.fn<typeof ChildProcessModule.fork>(),
  readFile: vi.fn<typeof FileSystem.readFile>(),
}));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof ChildProcessModule>()),
  spawn: mocks.spawn,
  fork: mocks.fork,
}));
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof FileSystem>()),
  readFile: mocks.readFile,
}));

test('所有プロセスのポート・終了通知・出力を検証し、起動や読み取りの失敗も回収する', async () => {
  const root = await mkdtemp(join(tmpdir(), 'exploration-process-boundaries-'));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const uid = Object.getOwnPropertyDescriptor(process, 'getuid');
  if (!platform || !uid) {
    throw new Error('POSIX環境が必要です。');
  }
  try {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    Object.defineProperty(process, 'getuid', { value: () => 1000, configurable: true });
    for (const scenario of [
      'port',
      'spawn-error',
      'exit',
      'stop',
      'timeout',
      'primitive',
      'plain-error',
      'denied',
      'missing-uid',
    ] as const) {
      mocks.readFile.mockReset();
      const child = new ChildProcess();
      mocks.spawn.mockReturnValueOnce(child);
      const error: NodeJS.ErrnoException = new Error('fixture read failed');
      if (scenario === 'denied') {
        error.code = 'EACCES';
      }
      if (scenario === 'primitive') {
        mocks.readFile.mockRejectedValueOnce('fixture rejection');
      } else if (scenario === 'plain-error' || scenario === 'denied') {
        mocks.readFile.mockRejectedValueOnce(error);
      } else {
        const missing: NodeJS.ErrnoException = new Error('not ready');
        missing.code = 'ENOENT';
        mocks.readFile.mockRejectedValueOnce(missing);
        for (const value of [
          'not-a-port',
          '0',
          '65536',
          '1.5',
          '65535\n/devtools/browser/fixture',
        ]) {
          mocks.readFile.mockResolvedValueOnce(value);
        }
      }
      if (scenario === 'missing-uid') {
        Object.defineProperty(process, 'getuid', { value: undefined, configurable: true });
      }
      const clock =
        scenario === 'timeout'
          ? vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(30_001)
          : undefined;
      const browser = launchBrowser({ chrome: '/fixture/chrome', temporaryDirectory: root });
      clock?.mockRestore();
      try {
        if (scenario === 'spawn-error') {
          child.emit('error', new Error('spawn failed'));
        }
        if (scenario === 'exit') {
          child.emit('exit', 1, null);
        }
        const stopping = scenario === 'stop' ? browser.stop() : undefined;
        if (scenario === 'port' || scenario === 'missing-uid') {
          await expect(browser.result).resolves.toBe('http://127.0.0.1:65535');
          expect(mocks.spawn.mock.lastCall?.[1]).not.toContain('--no-sandbox');
        } else if (scenario === 'primitive') {
          await expect(browser.result).rejects.toBe('fixture rejection');
        } else if (scenario === 'plain-error' || scenario === 'denied') {
          await expect(browser.result).rejects.toBe(error);
        } else {
          await expect(browser.result).rejects.toThrow('探索用ブラウザを起動できませんでした。');
        }
        await stopping;
      } finally {
        await browser.stop();
      }
    }
    for (const event of ['error', 'close'] as const) {
      const child = new ChildProcess();
      mocks.fork.mockReturnValueOnce(child);
      const runtime = launchRuntime({ fixturePath: '/fixture.json', temporaryDirectory: root });
      try {
        const failed = expect(runtime.result).rejects.toThrow(
          event === 'error' ? 'fixture spawn' : '探索用ランタイムが終了しました。',
        );
        if (event === 'error') {
          child.emit('error', new Error('fixture spawn'));
        } else {
          child.emit('close', 1, null);
        }
        await failed;
      } finally {
        await runtime.stop();
      }
    }
    for (const event of ['error', 'close'] as const) {
      const child = new ChildProcess();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      child.stdout = stdout;
      child.stderr = stderr;
      mocks.spawn.mockReturnValueOnce(child);
      const outputDirectory = join(root, event);
      const engine = launchBombadil({
        binary: '/fixture/bombadil',
        remoteDebugger: 'http://127.0.0.1:9222',
        specPath: '/fixture.spec.ts',
        url: 'http://127.0.0.1:4321',
        seconds: 60,
        outputDirectory,
      });
      try {
        expect(mocks.spawn.mock.lastCall?.[1]).toContain('--time-limit');
        expect(mocks.spawn.mock.lastCall?.[1]).toContain('60s');
        if (event === 'error') {
          const failed = expect(engine.result).rejects.toThrow('fixture engine spawn');
          child.emit('error', new Error('fixture engine spawn'));
          await failed;
        } else {
          stdout.write('a'.repeat(1_048_580));
          stderr.write('b');
          child.emit('close', 0, null);
          const outcome = await engine.result;
          expect(outcome).toEqual({
            exitCode: 0,
            signal: null,
            stdout: `${'a'.repeat(1_048_575)}b`,
          });
          const actual = await vi.importActual<typeof FileSystem>('node:fs/promises');
          expect(await actual.readFile(join(outputDirectory, 'engine.log'), 'utf8')).toBe(
            outcome.stdout,
          );
        }
      } finally {
        await engine.stop();
        stdout.destroy();
        stderr.destroy();
      }
    }
  } finally {
    Object.defineProperty(process, 'platform', platform);
    Object.defineProperty(process, 'getuid', uid);
    await rm(root, { recursive: true, force: true });
  }
});
