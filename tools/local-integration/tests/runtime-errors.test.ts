import { ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { resolveRuntime } from '@korekaite/runtime-config';
import { afterEach, expect, onTestFinished, test, vi } from 'vitest';
import { PendingRuntimeCleanup, buildRuntime, startRuntimeInProcess } from '../src/runtime.ts';
import { lockEnvironment } from '../src/lock.ts';
import { stopProcessGroup, runNodeCommand } from '../src/process.ts';
import { confirmHttpReady } from '../src/readiness.ts';
import { startRuntimeCapture } from '../../coverage/src/runtime-capture.ts';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, symlink: vi.fn(original.symlink) };
});
vi.mock('../src/database.ts', () => ({ runDatabaseCommand: vi.fn() }));
vi.mock('../src/lock.ts', () => ({ lockEnvironment: vi.fn() }));
vi.mock('../src/process.ts', () => ({ stopProcessGroup: vi.fn(), runNodeCommand: vi.fn() }));
vi.mock('../src/readiness.ts', () => ({ confirmHttpReady: vi.fn() }));
vi.mock('../../coverage/src/runtime-capture.ts', () => ({ startRuntimeCapture: vi.fn() }));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

async function runtimeFixture(environment: 'development' | 'test' | 'production' = 'test') {
  vi.stubEnv('KOREKAITE_COVERAGE_RUN', '');
  const root = await mkdtemp(join(tmpdir(), 'runtime-boundary-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const config = resolveRuntime({
    repositoryRoot: root,
    appEnv: environment,
    ...(environment === 'test' ? { runId: 'runtime', parallelIndex: 0 } : {}),
  });
  const release = vi.fn();
  vi.mocked(lockEnvironment).mockResolvedValue(release);
  const child = new ChildProcess();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  vi.mocked(spawn).mockImplementation(() => {
    queueMicrotask(() => child.stdout!.emit('data', Buffer.from('http://127.0.0.1:1234')));
    return child;
  });
  vi.mocked(stopProcessGroup).mockImplementation(async () => {
    child.emit('exit', 0);
  });
  return { root, config, child, release };
}

test('開発環境で障害注入用オプションを有効にできない', async () => {
  const fixture = await runtimeFixture('development');
  await expect(
    startRuntimeInProcess(fixture.config, 'dev', { manualDiagnostics: true }),
  ).rejects.toThrow('独立test環境だけ');
  expect(fixture.release).toHaveBeenCalledTimes(1);
});

test('本番設定でローカルランタイムを起動しない', async () => {
  const fixture = await runtimeFixture('production');
  await expect(startRuntimeInProcess(fixture.config)).rejects.toThrow('ローカル環境だけ');
  expect(spawn).not.toHaveBeenCalled();
});

test('previewには障害注入用オプションを渡せない', async () => {
  const fixture = await runtimeFixture();
  await expect(
    startRuntimeInProcess(fixture.config, 'preview', { stopAfterResultBeforeAck: true }),
  ).rejects.toThrow('自動初期化');
  expect(lockEnvironment).not.toHaveBeenCalled();
});

test('依存へのシンボリックリンク作成が拒否されたらロックを解放する', async () => {
  const fixture = await runtimeFixture();
  vi.mocked(symlink).mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
  await expect(startRuntimeInProcess(fixture.config)).rejects.toThrow('denied');
  expect(fixture.release).toHaveBeenCalledTimes(1);
});

test('起動時のerrorイベントで失敗し停止確認後にロックを解放する', async () => {
  const fixture = await runtimeFixture();
  vi.mocked(spawn).mockImplementation(() => {
    queueMicrotask(() => fixture.child.emit('error', new Error('spawn failed')));
    return fixture.child;
  });
  await expect(startRuntimeInProcess(fixture.config)).rejects.toThrow('spawn failed');
  expect(fixture.release).toHaveBeenCalledTimes(1);
});

test('URL出力前の終了を起動成功として扱わない', async () => {
  const fixture = await runtimeFixture();
  vi.mocked(spawn).mockImplementation(() => {
    queueMicrotask(() => fixture.child.emit('exit', 2));
    return fixture.child;
  });
  await expect(startRuntimeInProcess(fixture.config)).rejects.toThrow('起動失敗（2）');
  expect(fixture.release).toHaveBeenCalledTimes(1);
});

test('HTTP到達確認中に終了した子プロセスを起動成功として返さない', async () => {
  const fixture = await runtimeFixture();
  vi.mocked(confirmHttpReady).mockImplementation(async () => {
    Object.defineProperty(fixture.child, 'exitCode', { value: 1 });
  });
  await expect(startRuntimeInProcess(fixture.config)).rejects.toThrow('起動確認中に終了');
  expect(fixture.release).toHaveBeenCalledTimes(1);
});

test('起動後処理が失敗したらロックを保持し後処理の再試行後に解放する', async () => {
  const fixture = await runtimeFixture();
  vi.mocked(confirmHttpReady).mockRejectedValue(new Error('not ready'));
  vi.mocked(stopProcessGroup).mockRejectedValueOnce(new Error('still alive'));
  const failure = await startRuntimeInProcess(fixture.config).then(
    () => null,
    (error: Error) => error,
  );
  expect(failure).toBeInstanceOf(PendingRuntimeCleanup);
  expect(fixture.release).not.toHaveBeenCalled();
  await (failure as PendingRuntimeCleanup).cleanup();
  expect(fixture.release).toHaveBeenCalledTimes(1);
});

test('子プロセス生成直後の中断を取りこぼさず停止する', async () => {
  const fixture = await runtimeFixture();
  const controller = new AbortController();
  vi.mocked(spawn).mockImplementation(() => {
    controller.abort();
    return fixture.child;
  });
  await expect(startRuntimeInProcess(fixture.config, 'dev', {}, controller.signal)).rejects.toThrow(
    '中断',
  );
  expect(fixture.release).toHaveBeenCalledTimes(1);
});

test('起動ログが出なければ45秒で停止しロックを解放する', async () => {
  const fixture = await runtimeFixture();
  vi.useFakeTimers();
  vi.mocked(spawn).mockReturnValue(fixture.child);
  const result = expect(startRuntimeInProcess(fixture.config)).rejects.toThrow('45秒以内');
  await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
  await vi.advanceTimersByTimeAsync(45_000);
  await result;
  expect(fixture.release).toHaveBeenCalledTimes(1);
});

test('計測有効時は収集完了を待ってから子プロセスを停止する', async () => {
  const fixture = await runtimeFixture();
  vi.stubEnv('KOREKAITE_COVERAGE_RUN', '/tmp/controlled-run.json');
  const finish = vi.fn(async () => {
    expect(stopProcessGroup).not.toHaveBeenCalled();
  });
  vi.mocked(startRuntimeCapture).mockResolvedValue(finish);
  const runtime = await startRuntimeInProcess(fixture.config);
  await runtime.stop();
  expect(finish).toHaveBeenCalledTimes(1);
  expect(stopProcessGroup).toHaveBeenCalledTimes(1);
});

test('ビルドが失敗しても環境ロックを解放する', async () => {
  const fixture = await runtimeFixture('development');
  vi.mocked(runNodeCommand).mockRejectedValue(new Error('build failed'));
  await expect(buildRuntime(fixture.config)).rejects.toThrow('build failed');
  expect(fixture.release).toHaveBeenCalledTimes(1);
  expect(
    await readFile(join(fixture.config.artifactDirectory, 'web/vite.config.ts'), 'utf8'),
  ).not.toContain('runtimeCoveragePlugin');
});

test('再準備で依存リンクが別の場所へ差し替わっていれば拒否する', async () => {
  const fixture = await runtimeFixture();
  await buildRuntime(fixture.config);
  const link = join(fixture.config.artifactDirectory, 'web/node_modules');
  await rm(link);
  await symlink(fixture.root, link, 'dir');
  await expect(buildRuntime(fixture.config)).rejects.toThrow('参照先が一致しません');
  expect(fixture.release).toHaveBeenCalledTimes(2);
});

test('同じ依存リンクを持つ環境の再ビルドを許可する', async () => {
  const fixture = await runtimeFixture();
  await buildRuntime(fixture.config);
  await buildRuntime(fixture.config);
  expect(runNodeCommand).toHaveBeenCalledTimes(2);
  expect(fixture.release).toHaveBeenCalledTimes(2);
});

test('診断Queueのない不整合なローカル設定を起動しない', async () => {
  const fixture = await runtimeFixture();
  await expect(
    startRuntimeInProcess({
      ...fixture.config,
      queues: { evaluation: fixture.config.queues.evaluation },
    }),
  ).rejects.toThrow('診断Queueが未設定');
  expect(spawn).not.toHaveBeenCalled();
});

test('URLがまだ含まれない起動ログを保持して続くURLでHTTPを確認する', async () => {
  const fixture = await runtimeFixture();
  vi.mocked(spawn).mockImplementation(() => {
    queueMicrotask(() => {
      fixture.child.stdout!.emit('data', Buffer.from('starting '));
      fixture.child.stderr!.emit('data', Buffer.from('http://127.0.0.1:1234'));
    });
    return fixture.child;
  });
  const runtime = await startRuntimeInProcess(fixture.config, 'preview');
  await runtime.stop();
  expect(await readFile(join(fixture.config.artifactDirectory, 'runtime.log'), 'utf8')).toContain(
    'starting http://127.0.0.1:1234',
  );
});

test('HTTP到達確認後に起動し停止確認後にだけ環境ロックを解放する', async () => {
  const fixture = await runtimeFixture();
  const runtime = await startRuntimeInProcess(fixture.config);
  expect(confirmHttpReady).toHaveBeenCalledWith(runtime.baseUrl, 45_000, undefined);
  expect(fixture.release).not.toHaveBeenCalled();
  await runtime.stop();
  expect(fixture.release).toHaveBeenCalledTimes(1);
  await expect(runtime.closed).resolves.toEqual({ exitCode: 0 });
});
