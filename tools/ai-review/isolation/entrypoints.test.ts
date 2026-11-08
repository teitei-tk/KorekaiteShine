import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { writeFileSync, writeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { probeIsolation, type IsolationReport } from '../isolation-probe.ts';

const state = vi.hoisted(() => ({
  input: { parentPidNamespace: 'pid:[100]' },
  report: {
    passed: true,
    pidNamespace: 'pid:[100]',
    checks: [
      { name: 'uid', passed: true },
      { name: 'network', passed: false },
      { name: 'protected-file-0', passed: true },
    ],
  } as IsolationReport,
}));
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  readFileSync: () => JSON.stringify(state.input),
  writeSync: vi.fn(),
  writeFileSync: vi.fn(),
}));
vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));
vi.mock('../isolation-probe.ts', async (original) => ({
  ...(await original<typeof import('../isolation-probe.ts')>()),
  probeIsolation: vi.fn(async () => state.report),
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  state.input = { parentPidNamespace: 'pid:[100]' };
  state.report = {
    passed: true,
    pidNamespace: 'pid:[100]',
    checks: [
      { name: 'uid', passed: true },
      { name: 'network', passed: false },
      { name: 'protected-file-0', passed: true },
    ],
  };
  vi.stubGlobal('process', {
    ...process,
    argv: [
      'node',
      'fixture',
      'exec',
      '--output-last-message',
      '/fixture/output',
      '--sandbox',
      'read-only',
    ],
    exitCode: undefined,
    exit: vi.fn(() => {
      throw new Error('fixture exit');
    }),
    stdout: { write: vi.fn() },
    stderr: { write: vi.fn() },
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.mocked(spawnSync).mockReturnValue({
    pid: 0,
    output: [],
    stdout: JSON.stringify({
      stage: 'sandbox',
      passed: true,
      checks: state.report.checks.map((check) => ({ ...check, passed: true })),
    }),
    stderr: '',
    status: 0,
    signal: null,
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('sandbox起動失敗では出力がなくても安全に終了する', async () => {
  vi.mocked(spawnSync).mockReturnValueOnce({
    pid: 0,
    error: new Error('fixture'),
    output: [],
    stdout: null,
    stderr: null,
    status: null,
    signal: null,
  } as object as ReturnType<typeof spawnSync>);
  await expect(import('./action-probe.ts')).rejects.toThrow('fixture exit');
  expect(process.stdout.write).toHaveBeenCalledWith('');
  expect(process.stderr.write).toHaveBeenCalledWith('');
  expect(writeFileSync).not.toHaveBeenCalled();
});
it('Action境界で資格情報保護に失敗したらsandboxへ進まない', async () => {
  state.report.checks[2].passed = false;
  await expect(import('./action-probe.ts')).rejects.toThrow('fixture exit');
  expect(process.exit).toHaveBeenCalledWith(1);
  expect(spawnSync).not.toHaveBeenCalled();
});
it('Action境界のPID名前空間が親と違えば拒否する', async () => {
  state.report.pidNamespace = 'pid:[200]';
  await expect(import('./action-probe.ts')).rejects.toThrow('Action boundary must share');
  expect(spawnSync).not.toHaveBeenCalled();
});
it('公式Actionがread-onlyを指定しなければ検査を開始しない', async () => {
  process.argv = ['node', 'fixture', 'exec'];
  await expect(import('./action-probe.ts')).rejects.toThrow(
    'official Action did not select read-only exec',
  );
  expect(probeIsolation).not.toHaveBeenCalled();
});
it('Action境界とsandboxの両検査後だけ成功成果物を保存する', async () => {
  await import('./action-probe.ts');
  expect(spawnSync).toHaveBeenCalledWith(
    '/usr/local/bin/codex',
    expect.arrayContaining(['sandbox', ':read-only']),
    expect.any(Object),
  );
  expect(writeFileSync).toHaveBeenCalledWith('/fixture/output', 'isolation fixture passed');
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"stage":"action-boundary"'));
});
it('子プローブの失敗結果は終了コード1で返す', async () => {
  state.report.passed = false;
  await import('./probe-child.ts');
  expect(process.exitCode).toBe(1);
  expect(writeSync).toHaveBeenCalledWith(1, expect.stringContaining('"passed":false'));
});

it('子プローブは実行環境を検査へ渡して構造化結果と成功コードを返す', async () => {
  await import('./probe-child.ts');
  expect(probeIsolation).toHaveBeenCalledWith(expect.objectContaining({ env: process.env }));
  expect(writeSync).toHaveBeenCalledWith(1, expect.stringContaining('"stage":"sandbox"'));
  expect(process.exitCode).toBe(0);
});
