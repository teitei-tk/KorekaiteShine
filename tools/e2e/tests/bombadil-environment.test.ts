import type * as ChildProcess from 'node:child_process';
import type * as FileSystem from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { describeEnvironment, repositoryRoot } from '../bombadil/environment.ts';

const mocks = vi.hoisted(() => ({
  execute:
    vi.fn<
      (
        file: string,
        args: string[],
        options: { env: NodeJS.ProcessEnv; signal: AbortSignal },
      ) => Promise<{ stdout: string }>
    >(),
  readFile: vi.fn<(path: string) => Promise<Buffer>>(),
}));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof ChildProcess>();
  const { promisify } = await import('node:util');
  const execFile = () => {
    throw new Error('promisify経由で実行してください');
  };
  Object.defineProperty(execFile, promisify.custom, { value: mocks.execute });
  return { ...actual, execFile };
});
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof FileSystem>()),
  readFile: mocks.readFile,
}));
vi.mock('playwright', () => ({ chromium: { executablePath: () => '/fixture/chromium' } }));

test('再現識別情報は実行版と作業ツリーを照合し、出力先だけを除いて削除済みファイルも識別する', async () => {
  const { signal } = new AbortController();
  vi.stubEnv('E2E_CHROME_PATH', '');
  vi.stubEnv('OPENAI_API_KEY', 'fixture-not-for-child');
  try {
    mocks.execute.mockImplementation(async (file, args, options) => {
      expect(options.signal).toBe(signal);
      expect(options.env.OPENAI_API_KEY).toBeUndefined();
      if (file === 'git') {
        return {
          stdout:
            args[0] === 'rev-parse'
              ? 'a'.repeat(40)
              : 'src/a.ts\0src/deleted.ts\0out/result.json\0out/..notes\0outside.ts\0src/a.ts\0',
        };
      }
      return { stdout: file === '/fixture/chromium' ? 'Chromium fixture' : 'bombadil 0.7.10' };
    });
    mocks.readFile.mockImplementation(async (path) => {
      if (path.endsWith('/src/deleted.ts')) {
        const error: NodeJS.ErrnoException = new Error('deleted');
        error.code = 'ENOENT';
        throw error;
      }
      if (path.endsWith('/src/a.ts')) {
        return Buffer.from('A');
      }
      if (path.endsWith('/outside.ts')) {
        return Buffer.from('O');
      }
      if (path.endsWith('/history.spec.ts')) {
        return Buffer.from('spec');
      }
      if (path === '/fixture/chromium') {
        return Buffer.from('browser');
      }
      if (path.includes('/binaries/bombadil-')) {
        return Buffer.from('engine');
      }
      throw new Error(`除外した出力を読みました: ${path}`);
    });
    const result = await describeEnvironment('history', signal, [join(repositoryRoot, 'out')]);
    const hash = (text: string) => createHash('sha256').update(text).digest('hex');
    expect(result.identity).toEqual({
      gitSha: 'a'.repeat(40),
      sourceHash: hash('outside.ts\0O\0src/a.ts\0A\0src/deleted.ts\0<deleted>\0'),
      specHash: hash('spec'),
      bombadil: { version: 'bombadil 0.7.10', sha256: hash('engine') },
      browser: { version: 'Chromium fixture', sha256: hash('browser') },
    });
    expect(result.chrome).toBe('/fixture/chromium');
  } finally {
    vi.unstubAllEnvs();
  }
});

test('対応外・版不一致・読取障害・中断では識別情報を成功として返さない', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  if (!platform) {
    throw new Error('platformの定義がありません。');
  }
  const controller = new AbortController();
  const state = {
    version: 'bombadil invalid',
    abortAfterListing: false,
  };
  mocks.execute.mockReset();
  mocks.readFile.mockReset();
  mocks.execute.mockImplementation(async (file, args) => {
    if (file === 'git') {
      if (args[0] === 'rev-parse') {
        return { stdout: 'a'.repeat(40) };
      }
      if (state.abortAfterListing) {
        controller.abort(new Error('fixture interrupted'));
      }
      return { stdout: 'src/a.ts\0' };
    }
    return { stdout: file.includes('/binaries/') ? state.version : 'Chromium fixture' };
  });
  mocks.readFile.mockResolvedValue(Buffer.from('fixture'));
  try {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    await expect(describeEnvironment('preparation', controller.signal, [])).rejects.toThrow(
      '対応外',
    );
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.readFile).not.toHaveBeenCalled();
    Object.defineProperty(process, 'platform', platform);
    vi.stubEnv('E2E_CHROME_PATH', undefined);
    await expect(describeEnvironment('preparation', controller.signal, [])).rejects.toThrow(
      '固定版',
    );
    state.version = 'bombadil 0.7.10';
    vi.stubEnv('E2E_CHROME_PATH', '/fixture/custom-browser');
    const denied: NodeJS.ErrnoException = new Error('denied');
    denied.code = 'EACCES';
    for (const failure of [new Error('read failure'), denied, 'non-error rejection']) {
      mocks.readFile.mockRejectedValueOnce(failure);
      await expect(describeEnvironment('preparation', controller.signal, [])).rejects.toBe(failure);
    }
    state.abortAfterListing = true;
    await expect(describeEnvironment('preparation', controller.signal, [])).rejects.toThrow(
      'fixture interrupted',
    );
  } finally {
    Object.defineProperty(process, 'platform', platform);
    vi.unstubAllEnvs();
  }
});
