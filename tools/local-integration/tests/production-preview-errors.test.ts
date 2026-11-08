import { ChildProcess, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, expect, test, vi } from 'vitest';
import { startProductionPreview } from '../src/production.ts';
import { confirmHttpReady } from '../src/readiness.ts';
import { stopProcessGroup } from '../src/process.ts';
import { productionFixture } from './helpers/production-artifacts.ts';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));
vi.mock('../src/readiness.ts', () => ({ confirmHttpReady: vi.fn() }));
vi.mock('../src/process.ts', () => ({ stopProcessGroup: vi.fn(), runNodeCommand: vi.fn() }));
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

function previewChild(event: (child: ChildProcess) => void) {
  const child = new ChildProcess();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  vi.mocked(spawn).mockImplementation(() => {
    queueMicrotask(() => event(child));
    return child;
  });
  return child;
}

test('本番プレビューがURLを出す前に終了したら終了コードを返す', async () => {
  const fixture = await productionFixture();
  const child = previewChild((child) => child.emit('exit', 3));
  await expect(startProductionPreview(fixture.project)).rejects.toThrow('起動失敗（3）');
  expect(stopProcessGroup).toHaveBeenCalledWith(child);
});

test('URL検出後のHTTP到達確認に失敗したプレビューも停止する', async () => {
  const fixture = await productionFixture();
  const child = previewChild((child) => {
    child.stdout!.emit('data', Buffer.from('starting '));
    child.stderr!.emit('data', Buffer.from('http://127.0.0.1:1234'));
  });
  vi.mocked(confirmHttpReady).mockRejectedValue(new Error('not ready'));
  await expect(startProductionPreview(fixture.project)).rejects.toThrow('not ready');
  expect(stopProcessGroup).toHaveBeenCalledWith(child);
  expect(await readFile(join(fixture.project, 'preview.log'), 'utf8')).toContain(
    'starting http://127.0.0.1:1234',
  );
});

test('起動した本番プレビューはHTTP到達確認後に停止ハンドルを返す', async () => {
  const fixture = await productionFixture();
  const child = previewChild((child) =>
    child.stdout!.emit('data', Buffer.from('http://127.0.0.1:1234')),
  );
  const runtime = await startProductionPreview(fixture.project);
  expect(confirmHttpReady).toHaveBeenCalledWith(runtime.baseUrl);
  await runtime.stop();
  expect(stopProcessGroup).toHaveBeenCalledWith(child);
});

test('本番プレビューがURLを出さなければ45秒で停止する', async () => {
  vi.useFakeTimers();
  const fixture = await productionFixture();
  const child = previewChild(() => {});
  const outcome = expect(startProductionPreview(fixture.project)).rejects.toThrow('45秒以内');
  await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
  await vi.advanceTimersByTimeAsync(45_000);
  await outcome;
  expect(stopProcessGroup).toHaveBeenCalledWith(child);
  expect(vi.getTimerCount()).toBe(0);
});

test('本番プレビューの起動エラーでも停止を確認してログを保存する', async () => {
  const fixture = await productionFixture();
  const child = previewChild((process) => process.emit('error', new Error('preview failed')));
  await expect(startProductionPreview(fixture.project)).rejects.toThrow('preview failed');
  expect(stopProcessGroup).toHaveBeenCalledWith(child);
  expect(await readFile(join(fixture.project, 'preview.log'), 'utf8')).toBe('');
});
