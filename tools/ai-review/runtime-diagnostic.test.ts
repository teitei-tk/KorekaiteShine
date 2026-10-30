import { expect, it, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const mock = vi.hoisted(() => ({ stage: 'copy' }));
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  readFileSync: vi.fn((await original<typeof import('node:fs')>()).readFileSync),
  mkdirSync: vi.fn(),
  cpSync: vi.fn(() => {
    if (mock.stage === 'copy') throw new Error('SECRET /private/path Bearer token');
  }),
  lstatSync: vi.fn(() => ({
    uid: 1001,
    mode: 0o644,
    isSymbolicLink: () => false,
    isDirectory: () => false,
  })),
  chownSync: vi.fn(),
}));
import { executeRuntime } from './runtime.ts';
import { recordExecutionFailure, readStatusReports, validReport } from './status-report.ts';
const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
it.each([
  ['copy', 'setup/pr-copy'],
  ['owner', 'setup/pr-owner'],
])('外部例外を出さず%sの固定診断を保存し、汎用失敗で上書きしない', async (stage, target) => {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-diagnostic-'));
  dirs.push(dir);
  mock.stage = stage;
  const env = {
    RUNNER_TEMP: dir,
    AI_REVIEW_JOB: 'generate',
    GITHUB_RUN_ID: '20',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_STEP_SUMMARY: join(dir, 'summary.md'),
  };
  vi.mocked(readFileSync).mockReturnValueOnce(
    JSON.stringify({
      version: 2,
      repository: 'teitei-tk/KorekaiteShine',
      number: 7,
      head: 'a'.repeat(40),
      base: 'b'.repeat(40),
      sourceRun: '12',
      lines: {},
      history: { issues: [], inline: [], threads: [] },
    }),
  );
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await executeRuntime('setup', dir, '/source', env)).toBe(false);
  recordExecutionFailure(env);
  expect(readStatusReports(dir, 20, 1)[0]).toMatchObject({
    status: 'failure',
    target,
    reason: 'EXECUTION_FAILED',
  });
  const text =
    readFileSync(join(dir, 'status.json'), 'utf8') +
    readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8') +
    JSON.stringify(log.mock.calls);
  expect(text).toContain(target);
  expect(text).not.toMatch(/SECRET|Bearer|private\/path/);
  expect(validReport({ ...readStatusReports(dir, 20, 1)[0], target: 'setup/SECRET' })).toBe(false);
});
it.each(['missing', 'invalid', 'old-attempt'])('%s記録は汎用の固定失敗へ置き換える', (kind) => {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-fallback-'));
  dirs.push(dir);
  const env = {
    RUNNER_TEMP: dir,
    AI_REVIEW_JOB: 'generate',
    GITHUB_RUN_ID: '20',
    GITHUB_RUN_ATTEMPT: '2',
  };
  if (kind !== 'missing')
    writeFileSync(
      join(dir, 'status.json'),
      kind === 'invalid'
        ? 'SECRET invalid JSON'
        : JSON.stringify({
            version: 1,
            run: '20',
            attempt: '1',
            job: 'generate',
            status: 'failure',
            target: 'setup/pr-owner',
            reason: 'EXECUTION_FAILED',
          }),
    );
  recordExecutionFailure(env);
  expect(readStatusReports(dir, 20, 2)[0]).toMatchObject({
    target: 'generate',
    reason: 'EXECUTION_FAILED',
  });
});
vi.mock('./isolation/lifecycle.ts', async (original) => ({
  ...(await original<typeof import('./isolation/lifecycle.ts')>()),
  readInfo: vi.fn(),
  alive: vi.fn(() => false),
}));
import { readInfo, alive } from './isolation/lifecycle.ts';
it.each([false, true])(
  '終了処理の成否に応じて元の診断か終了診断を残す: %s',
  async (shutdownFails) => {
    const dir = mkdtempSync(join(tmpdir(), 'runtime-finish-'));
    dirs.push(dir);
    const env = {
      RUNNER_TEMP: dir,
      AI_REVIEW_JOB: 'generate',
      GITHUB_RUN_ID: '20',
      GITHUB_RUN_ATTEMPT: '1',
    };
    vi.mocked(readFileSync).mockReturnValueOnce(
      JSON.stringify({ proxy: { pid: 123, start: '1' }, infoPath: join(dir, 'info.json') }),
    );
    if (shutdownFails) vi.mocked(readInfo).mockRejectedValueOnce(new Error('SECRET upstream body'));
    else {
      vi.mocked(readInfo).mockResolvedValueOnce({ pid: 123, port: 1234 });
      vi.mocked(alive).mockReturnValueOnce(true);
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('', { status: 200 }));
    }
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await executeRuntime('finish', dir, 'failure', env)).toBe(false);
    expect(readStatusReports(dir, 20, 1)[0].target).toBe(
      shutdownFails ? 'finish/shutdown' : 'finish/action',
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain('SECRET');
  },
);
