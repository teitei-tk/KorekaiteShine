import { EventEmitter } from 'node:events';
import { afterEach, expect, test, vi } from 'vitest';
import {
  buildRuntime,
  runDatabaseCommand,
  startRuntime,
  type LocalRuntime,
} from '../src/runtime.ts';

vi.mock('../src/runtime.ts', () => ({
  buildRuntime: vi.fn(),
  runDatabaseCommand: vi.fn(),
  startRuntime: vi.fn(),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

async function cliFixture(args: string[], env: NodeJS.ProcessEnv = {}) {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const events = new EventEmitter();
  const channel = {
    argv: ['node', 'run.ts', ...args],
    env,
    exitCode: 0,
    once: events.once.bind(events),
    removeListener: events.removeListener.bind(events),
  };
  const { promise: closed, resolve: close } = Promise.withResolvers<{ exitCode: 0 | 1 }>();
  const runtime: LocalRuntime = {
    baseUrl: 'http://cli.invalid',
    closed,
    stop: vi.fn(async () => {
      close({ exitCode: 0 });
    }),
    runScheduled: vi.fn(async () => {}),
  };
  vi.mocked(startRuntime).mockResolvedValue(runtime);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('process', channel);
  await import('../src/run.ts');
  await vi.advanceTimersByTimeAsync(0);
  return { events, channel, runtime, close, log, error };
}

test('操作名を省略した場合は利用方法を出して失敗する', async () => {
  const fixture = await cliFixture([]);
  expect(fixture.channel.exitCode).toBe(1);
  expect(fixture.error).toHaveBeenCalledWith(expect.stringContaining('操作を指定'));
  expect(startRuntime).not.toHaveBeenCalled();
});

test('ビルド操作は既定の開発環境へ解決してビルドのみ実行する', async () => {
  const fixture = await cliFixture(['build']);
  expect(buildRuntime).toHaveBeenCalledWith(
    expect.objectContaining({ environment: 'development' }),
  );
  expect(startRuntime).not.toHaveBeenCalled();
  expect(fixture.channel.exitCode).toBe(0);
});

test('DB初期化は独立test環境の識別子を引き継ぐ', async () => {
  await cliFixture(['db:reset-seed'], {
    APP_ENV: 'test',
    LOCAL_TEST_RUN_ID: 'boundary',
    LOCAL_TEST_SLOT: '2',
  });
  expect(runDatabaseCommand).toHaveBeenCalledWith(
    expect.objectContaining({ environment: 'test' }),
    ['reset-seed'],
  );
});

test('DBスキーマ生成をgenerateへ振り分ける', async () => {
  await cliFixture(['db:generate']);
  expect(runDatabaseCommand).toHaveBeenCalledWith(
    expect.objectContaining({ environment: 'development' }),
    ['generate'],
  );
});

test('DBマイグレーションをmigrateへ振り分ける', async () => {
  await cliFixture(['db:migrate']);
  expect(runDatabaseCommand).toHaveBeenCalledWith(
    expect.objectContaining({ environment: 'development' }),
    ['migrate'],
  );
});

test('previewを起動し二度の終了シグナルでも停止処理は一度だけ行う', async () => {
  const fixture = await cliFixture(['preview']);
  expect(startRuntime).toHaveBeenCalledWith(expect.any(Object), 'preview', { port: 0 });
  fixture.events.emit('SIGTERM');
  fixture.events.emit('SIGINT');
  await vi.advanceTimersByTimeAsync(0);
  expect(fixture.runtime.stop).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  expect(fixture.events.listenerCount('SIGTERM')).toBe(0);
});

test('周期回復が長引いても重複実行せず完了後の周期で再開する', async () => {
  const fixture = await cliFixture(['dev']);
  const scheduled = Promise.withResolvers<void>();
  vi.mocked(fixture.runtime.runScheduled).mockReturnValueOnce(scheduled.promise);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(fixture.runtime.runScheduled).toHaveBeenCalledTimes(1);
  scheduled.resolve();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fixture.runtime.runScheduled).toHaveBeenCalledTimes(2);
  fixture.events.emit('SIGINT');
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
});

test('周期回復の一時失敗を報告し次の周期で再試行する', async () => {
  const fixture = await cliFixture(['dev']);
  vi.mocked(fixture.runtime.runScheduled).mockRejectedValueOnce(new Error('private details'));
  await vi.advanceTimersByTimeAsync(120_000);
  expect(fixture.runtime.runScheduled).toHaveBeenCalledTimes(2);
  expect(fixture.error).toHaveBeenCalledWith('定期回復に失敗しました。次の周期で再試行します。');
  fixture.events.emit('SIGINT');
  await vi.advanceTimersByTimeAsync(0);
});

test('停止に伴う周期回復の中断は一時失敗として報告しない', async () => {
  const fixture = await cliFixture(['dev']);
  vi.mocked(fixture.runtime.runScheduled).mockImplementation(
    (signal) =>
      new Promise((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
  );
  await vi.advanceTimersByTimeAsync(60_000);
  fixture.events.emit('SIGTERM');
  await vi.advanceTimersByTimeAsync(0);
  expect(fixture.error).not.toHaveBeenCalled();
  expect(fixture.runtime.stop).toHaveBeenCalledTimes(1);
});

test('ランタイムの異常終了をCLIの失敗へ反映しタイマーを解除する', async () => {
  const fixture = await cliFixture(['dev']);
  fixture.close({ exitCode: 1 });
  await vi.advanceTimersByTimeAsync(0);
  expect(fixture.channel.exitCode).toBe(1);
  expect(fixture.error).toHaveBeenCalledWith('ローカルランタイムが予期せず終了しました。');
  expect(vi.getTimerCount()).toBe(0);
});

test('ランタイム停止失敗をCLIの終了コードへ反映する', async () => {
  const fixture = await cliFixture(['dev']);
  vi.mocked(fixture.runtime.stop).mockRejectedValue(new Error('stop failed'));
  fixture.events.emit('SIGTERM');
  await vi.advanceTimersByTimeAsync(0);
  expect(fixture.channel.exitCode).toBe(1);
  expect(fixture.error).toHaveBeenCalledWith('stop failed');
  fixture.close({ exitCode: 0 });
  await vi.advanceTimersByTimeAsync(0);
});

test('追加引数をローカル操作へ渡さず拒否する', async () => {
  const fixture = await cliFixture(['dev', '--remote']);
  expect(fixture.channel.exitCode).toBe(1);
  expect(fixture.error).toHaveBeenCalledWith(expect.stringContaining('追加引数'));
  expect(startRuntime).not.toHaveBeenCalled();
});
