import { ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, expect, onTestFinished, test, vi } from 'vitest';
import { runNodeCommand } from '../src/process.ts';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());

test('正常終了の出力もclose後に保存して成功を返す', async () => {
  const input = await command();
  vi.mocked(spawn).mockImplementation(() => {
    const child = childProcess();
    queueMicrotask(() => {
      child.stdout!.emit('data', Buffer.from('completed'));
      child.emit('exit', 0);
      child.emit('close', 0);
    });
    return child;
  });
  await expect(runNodeCommand(input)).resolves.toBeUndefined();
  expect(await readFile(input.logPath, 'utf8')).toBe('completed');
});

test('生成失敗イベントでもcloseを待ち空のログを保存する', async () => {
  const input = await command();
  const failure = new Error('spawn failed');
  vi.mocked(spawn).mockImplementation(() => {
    const child = childProcess();
    queueMicrotask(() => {
      child.emit('error', failure);
      child.emit('close', -1);
    });
    return child;
  });
  await expect(runNodeCommand(input)).rejects.toBe(failure);
  expect(await readFile(input.logPath, 'utf8')).toBe('');
});

test('非ゼロ終了でも標準出力と標準エラーを停止後のログに保存する', async () => {
  const input = await command();
  vi.mocked(spawn).mockImplementation(() => {
    const child = childProcess();
    queueMicrotask(() => {
      child.stdout!.emit('data', Buffer.from('out'));
      child.stderr!.emit('data', Buffer.from('err'));
      child.emit('exit', 2);
      child.emit('close', 2);
    });
    return child;
  });
  await expect(runNodeCommand(input)).rejects.toThrow('失敗（2）');
  expect(await readFile(input.logPath, 'utf8')).toBe('outerr');
});

function childProcess() {
  const child = new ChildProcess();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

async function command() {
  const cwd = await mkdtemp(join(tmpdir(), 'command-boundary-'));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  return {
    cwd,
    args: [],
    env: process.env,
    logPath: join(cwd, 'command.log'),
    label: '境界検証',
    timeoutMs: 1000,
  };
}

test('開始前に中断済みなら子プロセスを生成しない', async () => {
  await expect(
    runNodeCommand({ ...(await command()), signal: AbortSignal.abort() }),
  ).rejects.toThrow('中断');
  expect(spawn).not.toHaveBeenCalled();
});

test('生成直後の中断も取りこぼさずcloseを確認してログを保存する', async () => {
  const input = await command();
  const controller = new AbortController();
  vi.mocked(spawn).mockImplementation(() => {
    const child = childProcess();
    controller.abort();
    queueMicrotask(() => child.emit('close', null));
    return child;
  });
  await expect(runNodeCommand({ ...input, signal: controller.signal })).rejects.toThrow('中断');
  expect(await readFile(input.logPath, 'utf8')).toBe('');
});
