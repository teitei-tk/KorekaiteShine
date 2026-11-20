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

test('後処理・重複登録・保留中のフックと記録上限を保持する', async () => {
  const profiler = createViteProfiler();
  expect(Reflect.apply(profiler.instrument, profiler, [null])).toBeNull();
  const pending = Promise.withResolvers<string>();
  const plugin = profiler.instrument({
    name: 'lifecycle',
    configureServer: () => () => 'post',
    load: () => pending.promise,
    config: () => undefined,
  });
  expect(profiler.instrument(plugin)).toBe(plugin);
  expect(plugin.configureServer()()).toBe('post');
  const loading = plugin.load();
  expect(profiler.snapshot(0, Number.MAX_SAFE_INTEGER).pending).toBe(1);
  pending.resolve('loaded');
  await expect(loading).resolves.toBe('loaded');
  Array.from({ length: 100_001 }, () => plugin.config());
  expect(profiler.snapshot(0, Number.MAX_SAFE_INTEGER)).toMatchObject({ pending: 0, dropped: 4 });
});

test('環境の取得・依存最適化とプラグイン登録を計測する', () => {
  const profiler = createViteProfiler();
  const plugin = { name: 'environment-plugin', load: () => 'module' };
  const optimizer = { init: () => 'initialized', run: false };
  const environment = {
    name: 'client',
    plugins: [plugin],
    depsOptimizer: optimizer,
    fetchWorkerExportTypes: () => 'types',
    fetchModule: () => 'module',
  };
  const configHook = profiler.plugin.configResolved;
  const serverHook = profiler.plugin.configureServer;
  if (
    !configHook ||
    typeof configHook === 'function' ||
    !serverHook ||
    typeof serverHook === 'function'
  ) {
    throw new Error('object hooks missing');
  }
  Reflect.apply(configHook.handler, profiler.plugin, [{ plugins: [plugin] }]);
  Reflect.apply(serverHook.handler, profiler.plugin, [{ environments: { client: environment } }]);
  const other = { name: 'other', plugins: [], depsOptimizer: optimizer };
  profiler.instrumentEnvironment(other);
  expect(environment.fetchWorkerExportTypes()).toBe('types');
  expect(environment.fetchModule()).toBe('module');
  expect(optimizer.init()).toBe('initialized');
  expect(plugin.load()).toBe('module');
  expect(profiler.snapshot(0, Number.MAX_SAFE_INTEGER).hooks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ hook: 'fetchWorkerExportTypes', category: 'worker' }),
      expect.objectContaining({ hook: 'fetchModule', category: 'module' }),
      expect.objectContaining({ hook: 'depsOptimizer:init' }),
    ]),
  );
});

test('Miniflareの計測点が欠けた環境を拒否し、同じインスタンスは再ラップしない', () => {
  for (const mode of ['missing-ready', 'fixed-ready', 'missing-fetch', 'valid'] as const) {
    const profiler = createViteProfiler();
    const prototype = {};
    if (mode !== 'missing-ready') {
      Object.defineProperty(prototype, 'ready', {
        configurable: mode !== 'fixed-ready',
        get: () => 'ready',
      });
    }
    const runtime: { dispatchFetch?: () => string } = {};
    Object.setPrototypeOf(runtime, prototype);
    if (mode === 'valid') {
      runtime.dispatchFetch = () => 'response';
    }
    const environment = { name: 'ssr', plugins: [], initRunner: () => 'initialized' };
    profiler.instrumentEnvironment(environment);
    if (mode === 'valid') {
      expect(Reflect.apply(environment.initRunner, environment, [runtime])).toBe('initialized');
      const fetch = runtime.dispatchFetch;
      expect(Reflect.apply(environment.initRunner, environment, [runtime])).toBe('initialized');
      expect(runtime.dispatchFetch).toBe(fetch);
    } else {
      expect(() => {
        Reflect.apply(environment.initRunner, environment, [runtime]);
      }).toThrow(/計測点/u);
    }
  }
});

test('IPCの通知以外を無視し、送信失敗とプロセスエラーで終了する', async () => {
  for (const failure of [false, true]) {
    const child = new ChildProcess();
    Object.defineProperty(child, 'connected', { value: true });
    const error = new Error('ipc failure');
    Object.defineProperty(child, 'send', {
      value: vi.fn((_message: object, callback: (error: Error | null) => void) => {
        callback(failure ? error : null);
        return true;
      }),
    });
    const pending = requestViteSnapshot(child, 1, 2, 3);
    const rejected = expect(pending).rejects.toThrow(error);
    child.emit('message', 'unrelated');
    if (!failure) {
      child.emit('error', error);
    }
    await rejected;
    expect(child.listenerCount('message')).toBe(0);
  }
});

test('計測要求を検証し、入れ子の非同期プラグインと二つの区間を保存する', async () => {
  const { profileVitePlugins } = await import('../src/vite-profile.mjs');
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'vite-profile-'));
  const original = Object.getOwnPropertyDescriptor(process, 'send');
  const send = vi.fn();
  Object.defineProperty(process, 'send', { configurable: true, value: send });
  const before = new Set(process.listeners('message'));
  try {
    const plugin = { name: 'async-plugin', load: () => 'ok' };
    const result = await profileVitePlugins(
      [Promise.resolve([plugin]), false],
      join(directory, 'result.json'),
    );
    expect(result[0]).toMatchObject({ name: 'korekaite-startup-profile' });
    expect(plugin.load()).toBe('ok');
    const listener = process.listeners('message').find((entry) => !before.has(entry));
    expect(listener).toBeTypeOf('function');
    if (!listener) {
      throw new Error('snapshot listener missing');
    }
    Reflect.apply(listener, process, [{ type: 'other' }]);
    for (const [start, url, end] of [
      [Number.NaN, 2, 3],
      [3, 2, 4],
      [1, 4, 3],
    ]) {
      expect(() => {
        Reflect.apply(listener, process, [{ type: 'vite-startup-snapshot', start, url, end }]);
      }).toThrow('計測区間');
    }
    Reflect.apply(listener, process, [{ type: 'vite-startup-snapshot', start: 0, url: 1, end: 2 }]);
    expect(await readFile(join(directory, 'result.json'), 'utf8')).toContain('"totalMs":1');
    expect(send).toHaveBeenCalledWith('vite-startup-snapshot-saved');
    expect(process.listeners('message')).not.toContain(listener);
  } finally {
    for (const listener of process.listeners('message')) {
      if (!before.has(listener)) {
        process.off('message', listener);
      }
    }
    if (original) {
      Object.defineProperty(process, 'send', original);
    } else {
      Reflect.deleteProperty(process, 'send');
    }
    await rm(directory, { recursive: true, force: true });
  }
});
