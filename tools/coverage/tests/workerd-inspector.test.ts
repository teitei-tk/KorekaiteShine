import { SystemError } from '../../testing/system-error.mts';
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, readlinkSync, readdirSync } from 'node:fs';
import { platform } from 'node:os';
import { findWorkerdInspector } from '../src/workerd-inspector.ts';
test('全候補の接続が失敗した場合はInspectorを発見したことにしない', async () => {
  vi.mocked(fetch).mockRejectedValue(new Error('not inspector'));
  await expect(findWorkerdInspector(100, ['worker'])).rejects.toThrow(
    '直接Inspectorが見つかりません',
  );
});
test('所有ソケットを読めない権限エラーを欠落扱いで隠さない', async () => {
  vi.mocked(readlinkSync).mockImplementation(() => {
    throw new SystemError('permission', 'EPERM');
  });
  await expect(findWorkerdInspector(100, ['worker'])).rejects.toThrow('permission');
  expect(fetch).not.toHaveBeenCalled();
});

test.each(['linux', 'darwin'] as const)(
  '%sで子孫workerdがなければ別プロセスのソケットを探索せず失敗する',
  async (os) => {
    vi.mocked(platform).mockReturnValue(os);
    vi.mocked(execFileSync).mockReturnValue('200 100 node\n300 99 workerd');

    await expect(findWorkerdInspector(100, ['worker'])).rejects.toThrow(
      '子workerdの直接Inspectorが見つかりません',
    );

    expect(execFileSync).toHaveBeenCalledExactlyOnceWith('ps', ['-eo', 'pid=,ppid=,comm='], {
      encoding: 'utf8',
    });
    expect(readdirSync).not.toHaveBeenCalled();
    expect(readlinkSync).not.toHaveBeenCalled();
    expect(readFileSync).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  },
);

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('node:os', () => ({ platform: vi.fn() }));
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  readFileSync: vi.fn(),
  readlinkSync: vi.fn(),
  readdirSync: vi.fn(),
}));
beforeEach(() => {
  vi.mocked(platform).mockReturnValue('linux');
  vi.mocked(execFileSync).mockReturnValue('200 100 node\n300 200 workerd\n400 99 workerd');
  vi.mocked(readdirSync).mockReturnValue(['1', '2', '3'] as object as ReturnType<
    typeof readdirSync
  >);
  vi.mocked(readlinkSync).mockImplementation((path) => {
    if (String(path).endsWith('/1')) {
      return 'socket:[123]';
    }
    if (String(path).endsWith('/2')) {
      return '/dev/null';
    }
    throw new SystemError('disappeared', 'ENOENT');
  });
  vi.mocked(readFileSync).mockReturnValue(
    'header\n' +
      [10001, 10002]
        .map((port) =>
          ['0:', '0100007F:' + port.toString(16), '0:0', '0A', '0', '0', '0', '0', '0', '123'].join(
            ' ',
          ),
        )
        .join('\n'),
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json([{ id: 'core:user:worker', webSocketDebuggerUrl: 'ws://fixture/worker' }]),
    ),
  );
});

test('macOSでは子孫workerdだけの待受ポートをlsofから探索する', async () => {
  vi.mocked(platform).mockReturnValue('darwin');
  vi.mocked(execFileSync)
    .mockReturnValueOnce('200 100 node\n300 200 /bin/workerd\n400 99 /bin/workerd\n500 300 workerd')
    .mockReturnValueOnce('p300\nfc4\nn127.0.0.1:10001\np500\nf5\nn[::1]:10002\n');
  vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 404 }));
  expect(await findWorkerdInspector(100, ['worker'])).toEqual([
    { id: 'core:user:worker', webSocketDebuggerUrl: 'ws://fixture/worker' },
  ]);
  expect(execFileSync).toHaveBeenLastCalledWith(
    'lsof',
    ['-nP', '-a', '-p', '300,500', '-iTCP', '-sTCP:LISTEN', '-Fn'],
    { encoding: 'utf8' },
  );
  expect(fetch).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:10002/json/list', expect.any(Object));
  expect(readFileSync).not.toHaveBeenCalled();
  expect(readdirSync).not.toHaveBeenCalled();
});
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

test('子孫workerdの待受だけを探索しHTTP失敗の候補を読み飛ばす', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 404 }));
  expect(await findWorkerdInspector(100, ['worker'])).toEqual([
    { id: 'core:user:worker', webSocketDebuggerUrl: 'ws://fixture/worker' },
  ]);
  expect(readdirSync).toHaveBeenCalledExactlyOnceWith('/proc/300/fd');
  expect(fetch).toHaveBeenCalledTimes(2);
});

test('別WorkerのInspector一覧を対象と誤認せず次の候補を調べる', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(
    Response.json([{ id: 'core:user:other', webSocketDebuggerUrl: 'ws://fixture/other' }]),
  );
  expect(await findWorkerdInspector(100, ['worker'])).toEqual([
    { id: 'core:user:worker', webSocketDebuggerUrl: 'ws://fixture/worker' },
  ]);
  expect(fetch).toHaveBeenCalledTimes(2);
});
