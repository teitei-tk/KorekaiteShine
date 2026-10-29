import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { parentAccessIsolated, probeIsolation, requireIsolationReport } from './isolation-probe.ts';

const directories: string[] = [];

it.each([
  ['ENOENT', 'pid:[100]', 'pid:[200]', true],
  ['ENOENT', 'pid:[100]', 'pid:[100]', false],
  ['ENOENT', undefined, 'pid:[200]', false],
  ['ENOENT', 'pid:[100]', undefined, false],
  ['ENOENT', '', 'pid:[200]', false],
  ['ENOENT', 'pid:[100]', 'invalid', false],
  ['readable', 'pid:[100]', 'pid:[200]', false],
  ['ESRCH', 'pid:[100]', 'pid:[200]', false],
  ['other-error', 'pid:[100]', 'pid:[200]', false],
  ['EACCES', 'pid:[100]', 'pid:[100]', true],
  ['EPERM', 'pid:[100]', 'pid:[100]', true],
] as const)(
  '親procの%sは名前空間%s→%sの証拠に応じて判定する',
  (code, parent, current, expected) => {
    expect(parentAccessIsolated(code, parent, current)).toBe(expected);
  },
);
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

it('隔離されていない環境の資格情報・読取・書込を成功扱いせず、値を報告しない', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'isolation-test-'));
  directories.push(directory);
  const protectedFile = join(directory, 'protected');
  writeFileSync(protectedFile, 'dummy-secret-do-not-report');
  const report = await probeIsolation({
    expectedUid: (process.getuid?.() ?? 0) + 1,
    protectedFiles: [protectedFile],
    readOnlyDirectories: [directory],
    parentPid: process.pid,
    port: 0,
    env: { ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'dummy-secret-do-not-report' },
  });
  expect(report.passed).toBe(false);
  expect(report.checks).toEqual(
    expect.arrayContaining([
      { name: 'uid', passed: false },
      { name: 'credential-environment', passed: false },
      { name: 'protected-file-0', passed: false },
      { name: 'read-only-directory-0', passed: false },
    ]),
  );
  expect(JSON.stringify(report)).not.toContain('dummy-secret-do-not-report');
  expect(readFileSync(protectedFile, 'utf8')).toBe('dummy-secret-do-not-report');
});

it('資格情報が空でも環境変数が継承されていれば拒否する', async () => {
  const report = await probeIsolation({
    expectedUid: process.getuid?.() ?? 0,
    protectedFiles: [],
    readOnlyDirectories: [],
    parentPid: process.pid,
    port: 0,
    env: { GH_TOKEN: '' },
  });
  expect(report.checks).toContainEqual({ name: 'credential-environment', passed: false });
});

it('通信先へ到達できる場合にネットワーク隔離成功と表示しない', async () => {
  const server = createServer((socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('listener not ready');
    const report = await probeIsolation({
      expectedUid: process.getuid?.() ?? 0,
      protectedFiles: [],
      readOnlyDirectories: [],
      parentPid: process.pid,
      port: address.port,
      env: {},
    });
    expect(report.checks).toContainEqual({ name: 'network', passed: false });
    expect(report.passed).toBe(false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('終了コード0でも検査結果の欠落・一部だけの成功を合格にしない', () => {
  expect(() => requireIsolationReport('', ['uid', 'network'])).toThrow();
  expect(() =>
    requireIsolationReport(
      JSON.stringify({ stage: 'sandbox', passed: true, checks: [{ name: 'uid', passed: true }] }),
      ['uid', 'network'],
    ),
  ).toThrow();
  expect(() =>
    requireIsolationReport(
      JSON.stringify({
        stage: 'sandbox',
        passed: true,
        checks: [
          { name: 'uid', passed: true },
          { name: 'network', passed: false },
        ],
      }),
      ['uid', 'network'],
    ),
  ).toThrow();
  expect(() =>
    requireIsolationReport(
      JSON.stringify({
        stage: 'sandbox',
        passed: true,
        checks: [
          { name: 'uid', passed: true },
          { name: 'uid', passed: true },
        ],
      }),
      ['uid', 'network'],
    ),
  ).toThrow();
  expect(() =>
    requireIsolationReport(
      JSON.stringify({
        stage: 'sandbox',
        passed: true,
        checks: [
          { name: 'uid', passed: true },
          { name: 'network', passed: true },
        ],
      }),
      ['uid', 'network'],
    ),
  ).not.toThrow();
});

it('存在しない親PIDは合格にせず、秘密を含まない原因を報告する', async () => {
  const report = await probeIsolation({
    expectedUid: process.getuid?.() ?? 0,
    protectedFiles: [],
    readOnlyDirectories: [],
    parentPid: 2147483647,
    port: 0,
    env: {},
  });
  expect(report.checks).toContainEqual({
    name: 'parent-environ',
    passed: false,
    observation: 'ENOENT',
  });
  expect(report.checks).toContainEqual({
    name: 'parent-mem',
    passed: false,
    observation: 'ENOENT',
  });
});
