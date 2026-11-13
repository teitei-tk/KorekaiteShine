import { SystemError } from '../../testing/system-error.mts';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, onTestFinished, test, vi } from 'vitest';
import { lockEnvironment } from '../src/lock.ts';
import { runDatabaseCommand } from '../src/database.ts';

const location = vi.hoisted(() => ({ root: '' }));
vi.mock('@korekaite/runtime-config', async (importOriginal) => {
  const original = await importOriginal<typeof import('@korekaite/runtime-config')>();
  return {
    ...original,
    resolveRuntime: (input: Parameters<typeof original.resolveRuntime>[0]) =>
      original.resolveRuntime({ ...input, repositoryRoot: location.root }),
  };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, writeFile: vi.fn(original.writeFile) };
});
vi.mock('../src/lock.ts', () => ({ lockEnvironment: vi.fn() }));
vi.mock('../src/database.ts', () => ({ runDatabaseCommand: vi.fn() }));
vi.mock('../src/development-snapshot.ts', () => ({ readDevelopmentSnapshot: vi.fn() }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

async function preparationFixture() {
  location.root = await mkdtemp(join(tmpdir(), 'prepare-boundary-'));
  const root = location.root;
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, '.local/development/artifacts');
  await mkdir(directory, { recursive: true });
  const output = join(directory, 'isolation-output.txt');
  const release = vi.fn();
  vi.mocked(lockEnvironment).mockResolvedValue(release);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const run = async (args: string[] = []) => {
    vi.resetModules();
    const channel = { argv: ['node', 'prepare-integration.ts', ...args], exitCode: 0 };
    vi.stubGlobal('process', channel);
    await import('../src/prepare-integration.ts');
    await vi.waitFor(() =>
      expect(log.mock.calls.length + error.mock.calls.length).toBeGreaterThan(0),
    );
    return channel;
  };
  return { output, release, log, error, run };
}

test('統合準備は保持確認ファイルを作りDB初期化を要求しない', async () => {
  const fixture = await preparationFixture();
  expect((await fixture.run()).exitCode).toBe(0);
  expect(await readFile(fixture.output, 'utf8')).toBe('development-retained-v1');
  expect(vi.mocked(runDatabaseCommand).mock.calls.map(([, args]) => args[0])).toEqual([
    'migrate',
    'execute',
  ]);
  expect(fixture.release).toHaveBeenCalledTimes(1);
});

test('既存の保持確認ファイルを上書きせず内容を確認して成功する', async () => {
  const fixture = await preparationFixture();
  await writeFile(fixture.output, 'development-retained-v1');
  expect((await fixture.run()).exitCode).toBe(0);
  expect(await readFile(fixture.output, 'utf8')).toBe('development-retained-v1');
});

test('保持確認ファイルの作成拒否を隠さずロックを解放する', async () => {
  const fixture = await preparationFixture();
  vi.mocked(writeFile).mockRejectedValueOnce(new SystemError('denied', 'EACCES'));
  expect((await fixture.run()).exitCode).toBe(1);
  expect(fixture.error).toHaveBeenCalledWith('denied');
  expect(fixture.release).toHaveBeenCalledTimes(1);
});

test('統合準備コマンドの追加引数はDB操作前に拒否する', async () => {
  const fixture = await preparationFixture();
  expect((await fixture.run(['--reset'])).exitCode).toBe(1);
  expect(runDatabaseCommand).not.toHaveBeenCalled();
});
