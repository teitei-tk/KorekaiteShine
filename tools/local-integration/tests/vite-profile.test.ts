import { HookResult } from './helpers/hook-result.ts';
import { ChildProcess } from 'node:child_process';
import { expect, test, vi } from 'vitest';
import { requestViteSnapshot } from '../src/vite-profile-host.ts';
import { createViteProfiler, summarizeViteSpans } from '../src/vite-profile.mjs';

test('入れ子のWorker待ちと変換を区間へ切り分け、時間を二重計上しない', () => {
  const spans = [
    { name: 'cloudflare', hook: 'configureServer', category: 'plugin', start: 10, end: 90 },
    { name: 'ssr', hook: 'initRunner', category: 'worker', start: 20, end: 80 },
    { name: 'vite', hook: 'transform', category: 'module', start: 40, end: 60 },
    { name: 'vite', hook: 'load', category: 'module', start: 45, end: 55 },
  ];
  expect(summarizeViteSpans(spans, 0, 50)).toMatchObject({
    totalMs: 50,
    pluginOnlyMs: 10,
    workerOnlyMs: 20,
    moduleOnlyMs: 0,
    workerAndModuleMs: 10,
    otherMs: 10,
  });
  expect(summarizeViteSpans(spans, 50, 100)).toMatchObject({
    totalMs: 50,
    pluginOnlyMs: 10,
    workerOnlyMs: 20,
    moduleOnlyMs: 0,
    workerAndModuleMs: 10,
    otherMs: 10,
  });
});

test('フックのthis・同期値・例外・非同期値とfilterを保持する', async () => {
  const profiler = createViteProfiler();
  const failure = new Error('failure');
  const plugin = profiler.instrument({
    name: 'fixture',
    config(this: { name: string }) {
      return { base: this.name };
    },
    load: {
      filter: { id: /fixture/u },
      handler() {
        throw failure;
      },
    },
    async transform() {
      return { code: 'ok' };
    },
  });
  expect(plugin.config()).toStrictEqual({ base: 'fixture' });
  expect(plugin.load.filter.id.test('fixture')).toBe(true);
  expect(() => plugin.load.handler()).toThrow(failure);
  await expect(plugin.transform()).resolves.toStrictEqual({ code: 'ok' });
  expect(profiler.snapshot(0, Number.MAX_SAFE_INTEGER).hooks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: 'fixture', hook: 'config', count: 1 }),
      expect.objectContaining({ name: 'fixture', hook: 'load', count: 1 }),
      expect.objectContaining({ name: 'fixture', hook: 'transform', count: 1 }),
    ]),
  );
});

test('Workerの初期化とMiniflareの準備待ちを別に記録し停止後は増えない', async () => {
  const profiler = createViteProfiler();
  class Runtime {
    readonly value = 'ready';
    get ready() {
      return Promise.resolve(this.value);
    }
    async setOptions() {
      return `${this.value}-updated`;
    }
    dispatchFetch = async () => this.value;
  }
  const environment = {
    name: 'ssr',
    plugins: [],
    async initRunner(runtime: Runtime) {
      return runtime.ready;
    },
  };
  profiler.instrumentEnvironment(environment);
  profiler.instrumentEnvironment(environment);
  const runtime = new Runtime();
  await expect(environment.initRunner(runtime)).resolves.toBe('ready');
  await expect(runtime.setOptions()).resolves.toBe('ready-updated');
  await expect(runtime.dispatchFetch()).resolves.toBe('ready');
  const before = profiler.snapshot(0, Number.MAX_SAFE_INTEGER);
  expect(before.hooks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: 'ssr', hook: 'initRunner', count: 1 }),
      expect.objectContaining({ name: 'miniflare', hook: 'ready', count: 1 }),
      expect.objectContaining({ name: 'miniflare', hook: 'setOptions', count: 1 }),
      expect.objectContaining({ name: 'miniflare', hook: 'dispatchFetch', count: 1 }),
    ]),
  );
  profiler.stop();
  await environment.initRunner(runtime);
  expect(profiler.snapshot(0, Number.MAX_SAFE_INTEGER)).toStrictEqual(before);
});

test('IPC保存の完了・中断・終了・期限超過でリスナーを解放する', async () => {
  vi.useFakeTimers();
  try {
    for (const outcome of ['saved', 'abort', 'exit', 'timeout'] as const) {
      const child = new ChildProcess();
      Object.defineProperty(child, 'connected', { value: true });
      const send = vi.fn(() => true);
      child.send = send;
      const controller = new AbortController();
      const pending = requestViteSnapshot(child, 1, 2, 3, controller.signal);
      const assertion =
        outcome === 'saved'
          ? expect(pending).resolves.toBeUndefined()
          : expect(pending).rejects.toThrow();
      if (outcome === 'saved') {
        child.emit('message', 'vite-startup-snapshot-saved');
      }
      if (outcome === 'abort') {
        controller.abort();
      }
      if (outcome === 'exit') {
        child.emit('exit', 1);
      }
      if (outcome === 'timeout') {
        await vi.advanceTimersByTimeAsync(10_000);
      }
      await assertion;
      expect(send).toHaveBeenCalledWith(
        { type: 'vite-startup-snapshot', start: 1, url: 2, end: 3 },
        expect.any(Function),
      );
      expect(child.listenerCount('message')).toBe(0);
      expect(child.listenerCount('exit')).toBe(0);
      expect(child.listenerCount('error')).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    }
    const stopped = new ChildProcess();
    await expect(requestViteSnapshot(stopped, 1, 2, 3)).rejects.toThrow();
    const aborted = new AbortController();
    aborted.abort();
    await expect(requestViteSnapshot(stopped, 1, 2, 3, aborted.signal)).rejects.toThrow();
  } finally {
    vi.useRealTimers();
  }
});

test('finallyを持たないawait可能な戻り値も元の成功値と失敗を保つ', async () => {
  const profiler = createViteProfiler();
  const failure = new Error('thenable failure');
  const plugin = profiler.instrument({
    name: 'thenable-fixture',
    load() {
      const result = new HookResult((resolve) => {
        resolve('loaded');
      });
      void Object.defineProperty(result, 'finally', { value: undefined });
      return result;
    },
    transform() {
      const result = new HookResult((_resolve, reject) => {
        reject(failure);
      });
      void Object.defineProperty(result, 'finally', { value: undefined });
      return result;
    },
  });
  await expect(Promise.resolve(plugin.load())).resolves.toBe('loaded');
  await expect(Promise.resolve(plugin.transform())).rejects.toThrow(failure);
});
