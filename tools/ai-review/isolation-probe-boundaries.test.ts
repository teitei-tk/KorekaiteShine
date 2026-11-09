import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openSync, readlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createConnection, Socket } from 'node:net';
import { probeIsolation } from './isolation-probe.ts';
it('補助グループ取得APIがない環境でもUID不一致とsudo成功を拒否する', async () => {
  vi.stubGlobal('process', { ...process, getuid: () => 0, getgroups: undefined });
  vi.mocked(spawnSync).mockReturnValue({
    pid: 0,
    output: [],
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    status: 0,
    signal: null,
  });
  const report = await probe();
  expect(report.checks).toContainEqual({ name: 'uid', passed: false });
  expect(report.checks).toContainEqual({ name: 'sudo', passed: false });
  expect(report.passed).toBe(false);
});
it('GID取得APIがない環境はグループ隔離を成功扱いしない', async () => {
  vi.stubGlobal('process', { ...process, getgid: undefined });
  const report = await probe();
  expect(report.checks).toContainEqual({ name: 'groups', passed: false });
  expect(report.passed).toBe(false);
});
it('不正なPID名前空間表記と起動失敗を隔離の証拠にしない', async () => {
  vi.mocked(readlinkSync).mockReturnValue('invalid');
  vi.mocked(spawnSync).mockReturnValue({
    pid: 0,
    output: [],
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    status: null,
    signal: null,
  });
  const report = await probe();
  expect(report.pidNamespace).toBeUndefined();
  expect(report.checks).toContainEqual({ name: 'sudo', passed: false });
});
it('Error以外の例外も拒否の証拠にせず内容を隠す', async () => {
  vi.mocked(openSync).mockImplementation(() => {
    throw 'private fixture';
  });
  const report = await probe();
  expect(report.checks).toContainEqual({ name: 'protected-file-0', passed: false });
  expect(report.checks).toContainEqual({
    name: 'parent-mem',
    passed: false,
    observation: 'other-error',
  });
  expect(JSON.stringify(report)).not.toContain('private fixture');
});
it('コードのない例外を権限拒否の証拠にしない', async () => {
  vi.mocked(openSync).mockImplementation(() => {
    throw new Error('private fixture');
  });
  vi.mocked(createConnection).mockImplementation(() => {
    const socket = new Socket();
    queueMicrotask(() => socket.emit('error', new Error('private fixture')));
    return socket;
  });
  const report = await probe();
  expect(report.passed).toBe(false);
  expect(report.checks).toContainEqual({ name: 'protected-file-0', passed: false });
  expect(report.checks).toContainEqual({
    name: 'parent-environ',
    passed: false,
    observation: 'other-error',
  });
  expect(report.checks).toContainEqual({ name: 'network', passed: false });
  expect(report.checks).toContainEqual({ name: 'protected-socket-0', passed: false });
});
it('接続タイムアウトだけではネットワークやソケットの隔離成功にしない', async () => {
  vi.mocked(createConnection).mockImplementation(() => {
    const socket = new Socket();
    vi.spyOn(socket, 'setTimeout').mockImplementation((_milliseconds, callback) => {
      queueMicrotask(() => callback?.());
      return socket;
    });
    return socket;
  });
  const report = await probe();
  expect(report.checks).toContainEqual({ name: 'network', passed: false });
  expect(report.checks).toContainEqual({ name: 'protected-socket-0', passed: false });
});

vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  openSync: vi.fn(),
  readlinkSync: vi.fn(),
  writeFileSync: vi.fn(),
}));
vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));
vi.mock('node:net', async (original) => ({
  ...(await original<typeof import('node:net')>()),
  createConnection: vi.fn(),
}));

function denied(): never {
  throw Object.assign(new Error('private fixture'), { code: 'EACCES' });
}

beforeEach(() => {
  vi.mocked(openSync).mockImplementation(denied);
  vi.mocked(writeFileSync).mockImplementation(denied);
  vi.mocked(readlinkSync).mockReturnValue('pid:[100]');
  vi.mocked(spawnSync).mockReturnValue({
    pid: 0,
    output: [],
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    status: 1,
    signal: null,
  });
  vi.spyOn(process, 'getuid').mockReturnValue(1000);
  vi.spyOn(process, 'getgid').mockReturnValue(1000);
  vi.spyOn(process, 'getgroups').mockReturnValue([1000]);
  vi.mocked(createConnection).mockImplementation(() => {
    const socket = new Socket();
    queueMicrotask(() =>
      socket.emit('error', Object.assign(new Error('private fixture'), { code: 'EACCES' })),
    );
    return socket;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

function probe() {
  return probeIsolation({
    expectedUid: 1000,
    parentPid: 1,
    protectedFiles: ['/fixture/private'],
    readOnlyDirectories: ['/fixture/readonly'],
    readOnlyFiles: ['/fixture/readonly/file'],
    protectedSockets: ['/fixture/private.sock'],
    port: 43210,
    env: {},
  });
}

it('権限エラーを確認した各境界を拒否の証拠として扱う', async () => {
  const report = await probe();
  expect(report.passed).toBe(true);
  expect(report.checks).toContainEqual({ name: 'network', passed: true });
  expect(report.checks).toContainEqual({ name: 'protected-socket-0', passed: true });
  expect(JSON.stringify(report)).not.toContain('private fixture');
});
