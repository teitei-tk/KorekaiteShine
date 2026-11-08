import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  createServer,
  type RequestListener,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from 'node:http';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { networkInterfaces } from 'node:os';

vi.mock('node:http', () => ({ createServer: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  rmSync: vi.fn(),
}));
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  networkInterfaces: vi.fn(),
}));

let handler: RequestListener;
it('PIDがないまま期限を迎えても別プロセスを停止しない', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  timedOut = true;
  childPid = undefined;
  const pending = import('./startup.ts');
  const rejected = expect(pending).rejects.toThrow('offline startup timed out');
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
  await vi.advanceTimersByTimeAsync(30_000);
  await rejected;
  expect(process.kill).not.toHaveBeenCalled();
});
it('子プロセスのerrorイベントでタイマーを解放し設定を復元する', async () => {
  vi.mocked(spawn).mockImplementationOnce(() => {
    const child = new ChildProcess();
    Object.defineProperty(child, 'stderr', { value: new PassThrough() });
    queueMicrotask(() => child.emit('error', new Error('fixture spawn')));
    return child;
  });
  await expect(import('./startup.ts')).rejects.toThrow('fixture spawn');
  expect(writeFileSync).toHaveBeenLastCalledWith(
    '/home/ai-review/.codex/config.toml',
    'original config',
  );
  expect(server.close).toHaveBeenCalled();
});
it('要求パスが欠落した応答を安全な接続先への到達と扱わない', async () => {
  requestUrl = undefined;
  await expect(import('./startup.ts')).rejects.toThrow('offline startup boundary failed');
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"receiverReached":false'));
});
it('起動期限を超えたプロセス群を停止して設定を復元する', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  timedOut = true;
  const pending = import('./startup.ts');
  const rejected = expect(pending).rejects.toThrow('offline startup timed out');
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
  await vi.advanceTimersByTimeAsync(30_000);
  await rejected;
  expect(process.kill).toHaveBeenCalledWith(-12345, 'SIGKILL');
  expect(server.close).toHaveBeenCalled();
});
it('外部インターフェイスがある環境では起動検証を実行しない', async () => {
  vi.mocked(networkInterfaces).mockReturnValue({
    eth0: [
      {
        address: '10.0.0.1',
        netmask: '255.0.0.0',
        family: 'IPv4',
        mac: '00:00:00:00:00:00',
        internal: false,
        cidr: '10.0.0.1/8',
      },
    ],
  });
  await expect(import('./startup.ts')).rejects.toThrow(
    'requires root in an offline Linux network namespace',
  );
  expect(spawn).not.toHaveBeenCalled();
});
it('Actionパスがなければ検証用ファイルを変更しない', async () => {
  process.argv = ['node', 'fixture'];
  await expect(import('./startup.ts')).rejects.toThrow('official Action path required');
  expect(writeFileSync).not.toHaveBeenCalled();
});
it('受信器のアドレスが取得不能でも設定復元と終了を行う', async () => {
  address = null;
  await expect(import('./startup.ts')).rejects.toThrow('local receiver unavailable');
  expect(writeFileSync).toHaveBeenLastCalledWith(
    '/home/ai-review/.codex/config.toml',
    'original config',
  );
  expect(server.close).toHaveBeenCalled();
});
it('受信器に到達しなければ起動検証を失敗にし設定を復元する', async () => {
  noRequest = true;
  await expect(import('./startup.ts')).rejects.toThrow('offline startup boundary failed');
  expect(console.error).toHaveBeenCalledWith('fixture diagnostic');
  expect(writeFileSync).toHaveBeenLastCalledWith(
    '/home/ai-review/.codex/config.toml',
    'original config',
  );
  expect(server.close).toHaveBeenCalled();
});
let count = 0;
let canaries = false;
let noRequest = false;
let timedOut = false;
let childPid: number | undefined;
let requestUrl: string | undefined;
let address: { port: number } | null;
let server: Server;
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  count = 0;
  canaries = false;
  noRequest = false;
  timedOut = false;
  address = { port: 43210 };
  childPid = 12345;
  requestUrl = '/safe/responses';
  vi.spyOn(process, 'getuid').mockReturnValue(0);
  vi.spyOn(process, 'kill').mockReturnValue(true);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('process', { ...process, argv: ['node', 'fixture', '/fixture/action.js'] });
  vi.mocked(networkInterfaces).mockReturnValue({
    lo: [
      {
        address: '127.0.0.1',
        netmask: '255.0.0.0',
        family: 'IPv4',
        mac: '00:00:00:00:00:00',
        internal: true,
        cidr: '127.0.0.1/8',
      },
    ],
  });
  vi.mocked(readFileSync).mockReturnValue('original config');
  vi.mocked(existsSync).mockImplementation(() => canaries);
  vi.mocked(rmSync).mockImplementation(() => {
    canaries = false;
  });
  server = Object.assign(new EventEmitter(), {
    listen: vi.fn((_port, _host, callback) => {
      callback();
      return server;
    }),
    address: vi.fn(() => address),
    closeAllConnections: vi.fn(),
    close: vi.fn((callback) => {
      callback();
      return server;
    }),
  }) as object as Server;
  vi.mocked(createServer).mockImplementation((callback) => {
    handler = callback as RequestListener;
    return server;
  });
  vi.mocked(spawn).mockImplementation(() => {
    const child = new ChildProcess();
    Object.defineProperty(child, 'pid', { value: childPid });
    Object.defineProperty(child, 'stderr', { value: new PassThrough() });
    const trusted = count++ === 0;
    queueMicrotask(() => {
      if (timedOut) {
        return;
      }
      if (!noRequest) {
        handler.call(
          server,
          { url: requestUrl, resume() {} } as IncomingMessage,
          { writeHead: vi.fn(), end: vi.fn() } as object as ServerResponse,
        );
      }
      canaries = trusted;
      child.stderr!.emit('data', Buffer.from('fixture diagnostic'));
      child.emit('close', 1);
    });
    return child;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('trusted対照だけcanaryが起動しuntrustedでは起動しないことを確認する', async () => {
  await import('./startup.ts');
  expect(spawn).toHaveBeenCalledTimes(2);
  expect(console.log).toHaveBeenCalledWith(
    expect.stringContaining('"stage":"startup-untrusted","passed":true'),
  );
  expect(writeFileSync).toHaveBeenLastCalledWith(
    '/home/ai-review/.codex/config.toml',
    'original config',
  );
  expect(server.closeAllConnections).toHaveBeenCalledOnce();
});
