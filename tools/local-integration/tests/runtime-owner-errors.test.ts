import { ChildProcess, fork } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { resolveRuntime } from '@korekaite/runtime-config';
import { afterEach, expect, test, vi } from 'vitest';
import {
  connectLocalRuntime,
  startOwnedRuntime,
  type RuntimeOwnerRequest,
} from '../src/runtime-owner.ts';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  fork: vi.fn(),
}));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

function ownerFixture() {
  const config = resolveRuntime({
    repositoryRoot: '/tmp/owner-boundary',
    appEnv: 'test',
    runId: 'owner',
    parallelIndex: 0,
  });
  const child = new ChildProcess();
  child.stderr = new PassThrough();
  Object.defineProperty(child, 'connected', { value: true, configurable: true });
  const send = vi.fn((request: RuntimeOwnerRequest, callback: (error: Error | null) => void) => {
    callback(null);
    queueMicrotask(() => {
      if (request.type === 'start') {
        child.emit('message', { type: 'ready', baseUrl: 'http://owner.invalid' });
      } else {
        child.emit('close', 0);
      }
    });
    return true;
  });
  Object.defineProperty(child, 'send', { value: send });
  vi.mocked(fork).mockReturnValue(child);
  return { child, send, start: () => startOwnedRuntime(config, 'dev', {}) };
}

test('管理プロセスから通知された起動エラーを保持して停止する', async () => {
  const fixture = ownerFixture();
  fixture.send.mockImplementation((request, callback) => {
    callback(null);
    queueMicrotask(() => {
      if (request.type === 'start') {
        fixture.child.emit('message', { type: 'error', message: 'start rejected' });
      } else {
        fixture.child.emit('close', 1);
      }
    });
    return true;
  });
  await expect(fixture.start()).rejects.toThrow('start rejected');
});

test('IPC送信失敗を起動成功にせず管理プロセスを停止する', async () => {
  const fixture = ownerFixture();
  fixture.send.mockImplementation((request, callback) => {
    if (request.type === 'start') {
      callback(new Error('send failed'));
    } else {
      callback(null);
      queueMicrotask(() => fixture.child.emit('close', 0));
    }
    return false;
  });
  await expect(fixture.start()).rejects.toThrow('send failed');
});

test('ready前の終了は起動失敗として終了コードを返す', async () => {
  const fixture = ownerFixture();
  fixture.send.mockImplementation((_request, callback) => {
    callback(null);
    queueMicrotask(() => {
      Object.defineProperty(fixture.child, 'connected', { value: false, configurable: true });
      fixture.child.emit('close', 7);
    });
    return true;
  });
  await expect(fixture.start()).rejects.toThrow('起動前に終了しました（7）');
  expect(fixture.send).toHaveBeenCalledTimes(1);
});

test('停止要求前の正常終了も予期しない終了として通知する', async () => {
  const fixture = ownerFixture();
  const runtime = await fixture.start();
  Object.defineProperty(fixture.child, 'connected', { value: false, configurable: true });
  fixture.child.emit('close', 0);
  await expect(runtime.closed).resolves.toEqual({ exitCode: 1 });
  await runtime.stop();
  expect(fixture.send).toHaveBeenCalledTimes(1);
});

test('停止時の異常終了コードを成功扱いしない', async () => {
  const fixture = ownerFixture();
  const runtime = await fixture.start();
  fixture.send.mockImplementation((_request, callback) => {
    callback(null);
    queueMicrotask(() => fixture.child.emit('close', 8));
    return true;
  });
  await expect(runtime.stop()).rejects.toThrow('異常終了しました（8）');
  await expect(runtime.closed).resolves.toEqual({ exitCode: 1 });
});

test('停止応答が来なければ15秒で失敗し停止要求を再送しない', async () => {
  vi.useFakeTimers();
  const fixture = ownerFixture();
  const runtime = await fixture.start();
  fixture.send.mockImplementation((_request, callback) => {
    callback(null);
    return true;
  });
  const result = expect(runtime.stop()).rejects.toThrow('停止確認が期限');
  await vi.advanceTimersByTimeAsync(15_000);
  await result;
  expect(vi.getTimerCount()).toBe(0);
});

test('readyが来なければ120秒で起動を中断し停止を確認する', async () => {
  vi.useFakeTimers();
  const fixture = ownerFixture();
  fixture.send.mockImplementation((request, callback) => {
    callback(null);
    if (request.type === 'stop') {
      queueMicrotask(() => fixture.child.emit('close', 0));
    }
    return true;
  });
  const result = expect(fixture.start()).rejects.toThrow('120秒以内');
  await vi.advanceTimersByTimeAsync(120_000);
  await result;
  expect(vi.getTimerCount()).toBe(0);
});

test('scheduled応答がHTTP成功でも結果がok以外なら失敗する', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(Response.json({ result: { outcome: 'exception' } })),
  );
  const runtime = connectLocalRuntime(
    'http://owner.invalid',
    async () => {},
    'evaluation',
    Promise.resolve({ exitCode: 0 }),
  );
  await expect(runtime.runScheduled()).rejects.toThrow('scheduledイベント失敗');
});

test('scheduledの成功応答を受理し対象Workerとcronを送る', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ result: { outcome: 'ok' } }));
  vi.stubGlobal('fetch', fetcher);
  const runtime = connectLocalRuntime(
    'http://owner.invalid',
    async () => {},
    'evaluation',
    Promise.resolve({ exitCode: 0 }),
  );
  await runtime.runScheduled();
  const [url, options] = fetcher.mock.calls[0]!;
  expect(String(url)).toContain('worker=evaluation');
  expect(options.body).toBe(JSON.stringify({ cron: '* * * * *' }));
});

test('ready以外の未知のIPCメッセージを起動成功として扱わない', async () => {
  const fixture = ownerFixture();
  fixture.send.mockImplementation((request, callback) => {
    callback(null);
    queueMicrotask(() => {
      if (request.type === 'start') {
        fixture.child.emit('message', { type: 'unexpected' });
        fixture.child.emit('message', { type: 'ready', baseUrl: 'http://owner.invalid' });
      } else {
        fixture.child.emit('close', 0);
      }
    });
    return true;
  });
  const runtime = await fixture.start();
  expect(runtime.baseUrl).toBe('http://owner.invalid');
  await runtime.stop();
});

test('停止要求は一度だけ送り管理プロセスの正常終了を共有する', async () => {
  const fixture = ownerFixture();
  const runtime = await fixture.start();
  const first = runtime.stop();
  expect(runtime.stop()).toBe(first);
  await first;
  await expect(runtime.closed).resolves.toEqual({ exitCode: 0 });
  expect(fixture.send.mock.calls.map(([request]) => request.type)).toEqual(['start', 'stop']);
});
