import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRuntimeCapture } from '../src/runtime-capture.ts';
import { findWorkerdInspector } from '../src/workerd-inspector.ts';
import { readWorkerCoverage } from '../src/worker.ts';
import { readCaptures } from '../src/capture.ts';
import { createMergeFixture } from './fixtures/measurement.ts';

vi.mock('../src/workerd-inspector.ts', () => ({ findWorkerdInspector: vi.fn() }));
vi.mock('../src/worker.ts', () => ({ readWorkerCoverage: vi.fn() }));
let root: string;
test('Error以外の収集失敗もfailedとして保存する', async () => {
  const stop = await startRuntimeCapture(12345, 'http://fixture', ['worker']);
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw 'fixture failure';
  });
  await stop();
  expect(readCaptures(directory)[0]).toMatchObject({
    status: 'failed',
    failure: 'worker: fixture failure',
  });
});
test('親PIDの権限エラーをプロセス終了と誤判定せず失敗記録を残す', async () => {
  const stop = await startRuntimeCapture(12345, 'http://fixture', ['worker']);
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('permission'), { code: 'EPERM' });
  });
  await stop();
  expect(readCaptures(directory)[0]).toMatchObject({
    status: 'failed',
    failure: 'worker: permission',
  });
});
let directory: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'capture-failures-'));
  directory = join(root, 'records');
  const { run } = createMergeFixture();
  const config = join(root, 'run.json');
  writeFileSync(config, JSON.stringify({ run, directory }));
  vi.stubEnv('KOREKAITE_COVERAGE_RUN', config);
  vi.stubEnv('KOREKAITE_COVERAGE_SUITE', 'unit');
  vi.mocked(findWorkerdInspector).mockResolvedValue([
    { id: 'core:user:worker', webSocketDebuggerUrl: 'ws://direct/worker' },
  ]);
  vi.mocked(readWorkerCoverage).mockResolvedValue({});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) =>
      String(url).endsWith('/__debug')
        ? new Response('ws=localhost%3A43210%2F')
        : Response.json([{ id: 'worker', webSocketDebuggerUrl: 'ws://proxy/worker' }]),
    ),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

test('Inspectorプロキシの所在が不明なら計測開始を拒否する', async () => {
  vi.mocked(fetch).mockResolvedValue(new Response('missing'));
  await expect(startRuntimeCapture(12345, 'http://fixture', ['worker'])).rejects.toThrow(
    'Inspectorプロキシが見つかりません',
  );
  expect(readWorkerCoverage).not.toHaveBeenCalled();
});

test('親の終了後は直接Inspectorから回収し完了記録を残す', async () => {
  const stop = await startRuntimeCapture(12345, 'http://fixture', ['worker']);
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('gone'), { code: 'ESRCH' });
  });
  await stop();
  expect(readWorkerCoverage).toHaveBeenLastCalledWith('ws://direct/worker', {
    value: expect.any(String),
  });
  expect(readCaptures(directory)[0].status).toBe('complete');
});

test('親が生存している間はプロキシ経由で回収する', async () => {
  const stop = await startRuntimeCapture(12345, 'http://fixture', ['worker']);
  vi.spyOn(process, 'kill').mockReturnValue(true);
  await stop();
  expect(readWorkerCoverage).toHaveBeenLastCalledWith('ws://proxy/worker', {
    value: expect.any(String),
  });
  expect(readCaptures(directory)[0].status).toBe('complete');
});
