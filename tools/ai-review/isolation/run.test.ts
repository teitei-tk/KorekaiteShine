import type * as LintTypeModule0 from 'node:net';
import type * as LintTypeModule1 from 'node:child_process';
import type * as LintTypeModule2 from 'node:fs';
import type * as LintTypeModule3 from '../isolation-probe.ts';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createConnection, createServer, Socket } from 'node:net';
import { readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { probeIsolation } from '../isolation-probe.ts';

vi.mock('node:net', async (original) => ({
  ...(await original<typeof LintTypeModule0>()),
  createConnection: vi.fn(),
  createServer: vi.fn(),
}));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof LintTypeModule1>()),
  spawn: vi.fn(),
}));
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof LintTypeModule2>()),
  chmodSync: vi.fn(),
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
  readlinkSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: (path: string) => path.endsWith('.git-credentials') || path.endsWith('docker.sock'),
  statSync: () => ({ isSocket: () => true }),
}));
vi.mock('../isolation-probe.ts', async (original) => ({
  ...(await original<typeof LintTypeModule3>()),
  probeIsolation: vi.fn(),
}));

function closedAllServers() {
  return (
    vi
      .mocked(createServer)
      // oxlint-disable-next-line typescript/no-unsafe-member-access -- NodeのEventEmitter API互換な部分mockを検証する。実API全体の実装やEventTargetへの置換は行わない。
      .mock.results.every(({ value: server }) => vi.mocked(server.close).mock.calls.length === 1)
  );
}
it('検査後に受信器へ接続できなければ隔離成功としない', async () => {
  vi.mocked(createConnection).mockImplementationOnce(() => {
    const socket = new Socket();
    queueMicrotask(() => {
      socket.emit('error', new Error('fixture connection'));
    });
    return socket;
  });
  await expect(import('./run.ts')).rejects.toThrow('fixture connection');
  expect(closedAllServers()).toBe(true);
});
it('root権限やActionパスがなければ受け入れ検査を開始しない', async () => {
  vi.spyOn(process, 'getuid').mockReturnValue(1000);
  await expect(import('./run.ts')).rejects.toThrow('requires disposable Linux root environment');
  vi.resetModules();
  vi.spyOn(process, 'getuid').mockReturnValue(0);
  process.argv = ['node', 'fixture'];
  await expect(import('./run.ts')).rejects.toThrow('official Action dist/main.js path required');
  expect(createServer).not.toHaveBeenCalled();
});
it('Actionの非ゼロ終了を受け入れ成功にしない', async () => {
  // oxlint-disable-next-line eslint/no-use-before-define -- Vitestが初期化後に呼ぶ遅延コールバック。
  statusContext.status = 1;
  await expect(import('./run.ts')).rejects.toThrow('isolation acceptance failed');
  expect(closedAllServers()).toBe(true);
});
it('Actionの完了中にrunnerが置換された場合は拒否する', async () => {
  // oxlint-disable-next-line eslint/no-use-before-define -- Vitestが初期化後に呼ぶ遅延コールバック。
  statusContext.changed = true;
  await expect(import('./run.ts')).rejects.toThrow('runner process changed during probe');
});
it('runnerと親のPID名前空間が一致しなければ拒否する', async () => {
  vi.mocked(readlinkSync).mockImplementation((path) =>
    String(path).endsWith('/exe') ? '/runner/bin/Runner.Worker' : 'pid:[200]',
  );
  await expect(import('./run.ts')).rejects.toThrow('runner PID namespace mismatch');
});
it('親PID名前空間を観測できなければ検査を中止する', async () => {
  vi.mocked(probeIsolation).mockResolvedValue({ ...fixtureReport(), pidNamespace: undefined });
  await expect(import('./run.ts')).rejects.toThrow('parent PID namespace unavailable');
});
it('負の対照が保護対象へのアクセスを拒否した場合は検証を中止する', async () => {
  const report = fixtureReport();
  report.checks[0].passed = true;
  vi.mocked(probeIsolation).mockResolvedValue(report);
  await expect(import('./run.ts')).rejects.toThrow('negative control failed');
  expect(spawn).not.toHaveBeenCalled();
});
it('runnerの開始時刻が取得不能なら同一プロセスと扱わない', async () => {
  vi.mocked(readFileSync).mockImplementation((path) =>
    String(path).endsWith('/101/comm') ? 'Runner.Worker' : '',
  );
  await expect(import('./run.ts')).rejects.toThrow('process identity unavailable');
});
it('github検証で実runnerがなければ成功扱いしない', async () => {
  vi.mocked(readdirSync).mockReturnValue([]);
  await expect(import('./run.ts')).rejects.toThrow('real runner processes not found');
  expect(spawn).not.toHaveBeenCalled();
});
it('受信器のアドレス不明時は両受信器を閉じて失敗する', async () => {
  // oxlint-disable-next-line eslint/no-use-before-define -- Vitestが初期化後に呼ぶ遅延コールバック。
  address.mockReturnValue(null);
  await expect(import('./run.ts')).rejects.toThrow('listener not ready');
  expect(closedAllServers()).toBe(true);
});
const address = vi.fn<() => { port: number } | null>();
function fixtureReport(): LintTypeModule3.IsolationReport {
  return {
    passed: false,
    pidNamespace: 'pid:[100]',
    checks: [
      'uid',
      'protected-file-0',
      'read-only-directory-0',
      'network',
      'parent-environ',
      'parent-mem',
      'groups',
      'protected-socket-0',
      'read-only-file-0',
      'read-only-file-1',
      'read-only-file-2',
    ].map((name) => ({ name, passed: false })),
  };
}
const statusContext = { status: 0, changed: false, statReads: 0 };
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  address.mockReturnValue({ port: 43_210 });
  statusContext.status = 0;
  statusContext.changed = false;
  statusContext.statReads = 0;
  vi.spyOn(process, 'getuid').mockReturnValue(0);
  vi.stubGlobal('process', {
    ...process,
    platform: 'linux',
    argv: ['node', 'fixture', '/fixture/action.js', 'github'],
  });
  vi.spyOn(console, 'log').mockImplementation(() => {
    /* この実装では追加の処理を行わない。 */
  });
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- NodeのEventEmitter API互換な部分mockを検証する。実API全体の実装やEventTargetへの置換は行わない。
  vi.mocked(readdirSync).mockReturnValue(['101', '102', 'self'] as object as ReturnType<
    typeof readdirSync
  >);
  vi.mocked(readFileSync).mockImplementation((path) => {
    if (String(path).endsWith('/101/comm')) {
      return 'Runner.Worker\n';
    }
    if (String(path).endsWith('/101/stat')) {
      return `101 (fixture) ${[
        'S',
        ...Array.from({ length: 18 }, () => '0'),
        statusContext.changed && ++statusContext.statReads > 1 ? '100' : '99',
      ].join(' ')}`;
    }
    throw new Error('fixture proc disappeared');
  });
  vi.mocked(readlinkSync).mockImplementation((path) =>
    String(path).endsWith('/exe') ? '/runner/bin/Runner.Worker' : 'pid:[100]',
  );
  vi.mocked(probeIsolation).mockResolvedValue(fixtureReport());
  vi.mocked(createServer).mockImplementation((callback) => {
    const socket = new Socket();
    vi.spyOn(socket, 'end').mockImplementation(() => socket);
    // oxlint-disable-next-line unicorn/prefer-event-target, typescript/no-unsafe-type-assertion -- NodeのEventEmitter API互換な部分mockを検証する。実API全体の実装やEventTargetへの置換は行わない。
    const server = new (class extends EventEmitter {
      listen = vi.fn((...args) => {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- NodeのEventEmitter API互換な部分mockを検証する。実API全体の実装やEventTargetへの置換は行わない。
        (callback as (socket: Socket) => void)(socket);
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- NodeのEventEmitter API互換な部分mockを検証する。実API全体の実装やEventTargetへの置換は行わない。
        (args.at(-1) as () => void)();
        return server;
      });
      address = address;
      close = vi.fn((callback) => {
        // oxlint-disable-next-line typescript/no-unsafe-call -- NodeのEventEmitter API互換な部分mockを検証する。実API全体の実装やEventTargetへの置換は行わない。
        callback();
        return server;
      });
    })() as object as LintTypeModule0.Server;
    return server;
  });
  vi.mocked(createConnection).mockImplementation(() => {
    const socket = new Socket();
    queueMicrotask(() => {
      socket.emit('connect');
    });
    return socket;
  });
  vi.mocked(spawn).mockImplementation(() => {
    const child = new ChildProcess();
    queueMicrotask(() => {
      child.emit('exit', statusContext.status);
    });
    return child;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('負の対照と実runnerの同一性を確かめてActionの結果を受け入れる', async () => {
  await import('./run.ts');
  expect(console.log).toHaveBeenCalledWith(
    'official Action boundary + official CLI sandbox: passed',
  );
  expect(writeFileSync).toHaveBeenCalledWith(
    '/opt/ai-review-probe/input.json',
    expect.stringContaining('"protectedProcesses":[101]'),
    { mode: 0o444 },
  );
  expect(closedAllServers()).toBe(true);
});
