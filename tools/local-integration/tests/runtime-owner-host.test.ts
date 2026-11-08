import { EventEmitter } from 'node:events';
import { resolveRuntime } from '@korekaite/runtime-config';
import { afterEach, expect, test, vi } from 'vitest';
import { PendingRuntimeCleanup, startRuntimeInProcess, type LocalRuntime } from '../src/runtime.ts';

vi.mock('../src/runtime.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/runtime.ts')>()),
  startRuntimeInProcess: vi.fn(),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.resetAllMocks();
});

async function hostFixture() {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const events = new EventEmitter();
  const channel = {
    connected: true,
    exitCode: 0,
    send: vi.fn((_message: object, callback: () => void) => callback()),
    disconnect: vi.fn(() => {
      channel.connected = false;
    }),
    on: events.on.bind(events),
    once: events.once.bind(events),
  };
  const runtime: LocalRuntime = {
    baseUrl: 'http://host.invalid',
    closed: new Promise(() => {}),
    stop: vi.fn(async () => {}),
    runScheduled: vi.fn(async () => {}),
  };
  vi.mocked(startRuntimeInProcess).mockResolvedValue(runtime);
  vi.stubGlobal('process', channel);
  await import('../src/runtime-owner-host.ts');
  const config = resolveRuntime({
    repositoryRoot: '/tmp/host-boundary',
    appEnv: 'test',
    runId: 'host',
    parallelIndex: 0,
  });
  const settle = () => vi.advanceTimersByTimeAsync(0);
  return {
    events,
    channel,
    runtime,
    settle,
    start: () => events.emit('message', { type: 'start', config, mode: 'dev', options: {} }),
  };
}

test('起動前の停止後は遅れて届く開始要求を受け付けない', async () => {
  const fixture = await hostFixture();
  fixture.events.emit('SIGTERM');
  fixture.start();
  await fixture.settle();
  expect(startRuntimeInProcess).not.toHaveBeenCalled();
  expect(fixture.channel.disconnect).toHaveBeenCalledTimes(1);
});

test('起動中に切断されたらreadyを送らず起動完了後に停止する', async () => {
  const fixture = await hostFixture();
  let complete!: (runtime: LocalRuntime) => void;
  vi.mocked(startRuntimeInProcess).mockReturnValue(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  fixture.start();
  fixture.channel.connected = false;
  fixture.events.emit('disconnect');
  complete(fixture.runtime);
  await fixture.settle();
  expect(fixture.channel.send).not.toHaveBeenCalled();
  expect(fixture.runtime.stop).toHaveBeenCalledTimes(1);
  expect(fixture.channel.disconnect).not.toHaveBeenCalled();
});

test('起動の非Error例外を定型文で通知して失敗終了にする', async () => {
  const fixture = await hostFixture();
  vi.mocked(startRuntimeInProcess).mockRejectedValue('private details');
  fixture.start();
  await fixture.settle();
  expect(fixture.channel.exitCode).toBe(1);
  expect(fixture.channel.send).toHaveBeenCalledWith(
    { type: 'error', message: 'ランタイムを起動できませんでした。' },
    expect.any(Function),
  );
  expect(fixture.channel.disconnect).toHaveBeenCalledTimes(1);
});

test('起動失敗後の保留された後処理を確認してから切断する', async () => {
  const fixture = await hostFixture();
  const cleanup = vi.fn(async () => {});
  vi.mocked(startRuntimeInProcess).mockRejectedValue(new PendingRuntimeCleanup(cleanup));
  fixture.start();
  await fixture.settle();
  expect(cleanup).toHaveBeenCalledTimes(1);
  expect(fixture.channel.disconnect).toHaveBeenCalledTimes(1);
  expect(fixture.channel.exitCode).toBe(1);
});

test('停止失敗時はIPCを保持し1秒後に再試行して確認する', async () => {
  const fixture = await hostFixture();
  vi.mocked(fixture.runtime.stop).mockRejectedValueOnce(new Error('stop failed'));
  fixture.start();
  await fixture.settle();
  fixture.events.emit('SIGINT');
  await fixture.settle();
  expect(fixture.channel.disconnect).not.toHaveBeenCalled();
  expect(fixture.channel.send).toHaveBeenCalledWith(
    { type: 'error', message: 'stop failed' },
    expect.any(Function),
  );
  await vi.advanceTimersByTimeAsync(1000);
  expect(fixture.runtime.stop).toHaveBeenCalledTimes(2);
  expect(fixture.channel.disconnect).toHaveBeenCalledTimes(1);
});

test('停止の非Error例外を定型文へ変換して再試行する', async () => {
  const fixture = await hostFixture();
  vi.mocked(fixture.runtime.stop).mockRejectedValueOnce('private details');
  fixture.start();
  await fixture.settle();
  fixture.events.emit('SIGTERM');
  await fixture.settle();
  expect(fixture.channel.send).toHaveBeenCalledWith(
    { type: 'error', message: 'ランタイム停止の確認に失敗しました。' },
    expect.any(Function),
  );
  await vi.advanceTimersByTimeAsync(1000);
  expect(fixture.channel.disconnect).toHaveBeenCalledTimes(1);
});

test('子ランタイムの予期しない終了を通知して後処理する', async () => {
  const fixture = await hostFixture();
  fixture.runtime.closed = Promise.resolve({ exitCode: 1 });
  fixture.start();
  await fixture.settle();
  expect(fixture.channel.send).toHaveBeenCalledWith(
    { type: 'error', message: 'ローカルランタイムが予期せず終了しました。' },
    expect.any(Function),
  );
  expect(fixture.runtime.stop).toHaveBeenCalledTimes(1);
});

test('切断済みの起動失敗では送信せず失敗状態を保持する', async () => {
  const fixture = await hostFixture();
  fixture.channel.connected = false;
  vi.mocked(startRuntimeInProcess).mockRejectedValue(new Error('start failed'));
  fixture.start();
  await fixture.settle();
  expect(fixture.channel.exitCode).toBe(1);
  expect(fixture.channel.send).not.toHaveBeenCalled();
});

test('子ランタイムの正常終了を異常終了として通知しない', async () => {
  const fixture = await hostFixture();
  fixture.runtime.closed = Promise.resolve({ exitCode: 0 });
  fixture.start();
  await fixture.settle();
  expect(fixture.channel.exitCode).toBe(0);
  expect(fixture.runtime.stop).not.toHaveBeenCalled();
  fixture.events.emit('message', { type: 'stop' });
  await fixture.settle();
});

test('管理ホストは起動を一度だけ受け付け停止を確認してIPCを切断する', async () => {
  const fixture = await hostFixture();
  fixture.start();
  fixture.start();
  await fixture.settle();
  expect(startRuntimeInProcess).toHaveBeenCalledTimes(1);
  expect(fixture.channel.send).toHaveBeenCalledWith(
    { type: 'ready', baseUrl: fixture.runtime.baseUrl },
    expect.any(Function),
  );
  fixture.events.emit('message', { type: 'stop' });
  fixture.events.emit('message', { type: 'stop' });
  await fixture.settle();
  expect(fixture.runtime.stop).toHaveBeenCalledTimes(1);
  expect(fixture.channel.disconnect).toHaveBeenCalledTimes(1);
});
