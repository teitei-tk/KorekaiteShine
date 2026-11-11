import { afterEach, expect, it, vi } from 'vitest';
import { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { readFileSync, rmSync } from 'node:fs';
import { authenticateProxy, wifProxyArgs } from './wif.ts';

vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  readFileSync: vi.fn(),
  rmSync: vi.fn(),
  chmodSync: vi.fn(),
}));
vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn(async () => {}) }));

const env = {
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fixture',
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.invalid',
  OPENAI_WIF_AUDIENCE: 'audience',
  OPENAI_IDENTITY_PROVIDER_ID: 'idp',
  OPENAI_SERVICE_ACCOUNT_ID: 'account',
};
it('隔離検査中にプロキシが終了した場合は初期交換成功で終わらせない', async () => {
  const child = createChild();
  await expect(
    authenticateProxy(
      env,
      '/fixture/info',
      () => {
        Object.defineProperty(child, 'exitCode', { value: 1, configurable: true });
      },
      100,
      () => child,
    ),
  ).rejects.toThrow('exited during isolation verification');
  expect(fetch).not.toHaveBeenCalled();
  expect(child.kill).not.toHaveBeenCalled();
});
it('標準入力の切断時は要求トークンの引き渡し成功にしない', async () => {
  const child = createChild();
  vi.spyOn(child.stdin!, 'end').mockImplementation(() => {
    child.stdin!.emit('error', new Error('fixture'));
    return child.stdin!;
  });
  await expect(
    authenticateProxy(
      env,
      '/fixture/info',
      () => {},
      100,
      () => child,
    ),
  ).rejects.toThrow('did not become ready');
  expect(child.kill).toHaveBeenCalledWith('SIGKILL');
});
it('プロキシ起動のerrorイベントを成功扱いせず子を回収する', async () => {
  const child = createChild();
  vi.spyOn(child.stdin!, 'end').mockImplementation(() => {
    child.emit('error', new Error('fixture'));
    return child.stdin!;
  });
  await expect(
    authenticateProxy(
      env,
      '/fixture/info',
      () => {},
      100,
      () => child,
    ),
  ).rejects.toThrow('did not become ready');
  expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  expect(rmSync).toHaveBeenLastCalledWith('/fixture/info', { force: true });
});
function createChild() {
  const child = new ChildProcess();
  Object.defineProperty(child, 'pid', { value: 12345 });
  child.stdin = new PassThrough();
  vi.spyOn(child, 'kill').mockImplementation(() => {
    Object.defineProperty(child, 'signalCode', { value: 'SIGKILL', configurable: true });
    queueMicrotask(() => child.emit('close', null, 'SIGKILL'));
    return true;
  });
  vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ pid: 12345, port: 43210 }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      Object.defineProperty(child, 'exitCode', { value: 0, configurable: true });
      return new Response(null, { status: 200 });
    }),
  );
  return child;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

it('必須のWIF設定が欠けていれば起動引数を作らない', () => {
  expect(() => wifProxyArgs({}, '/fixture/info')).toThrow('missing WIF settings');
});
