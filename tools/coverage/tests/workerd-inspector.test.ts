import { SystemError } from '../../testing/system-error.mts';
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, readlinkSync, readdirSync } from 'node:fs';
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

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  readFileSync: vi.fn(),
  readlinkSync: vi.fn(),
  readdirSync: vi.fn(),
}));
beforeEach(() => {
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
