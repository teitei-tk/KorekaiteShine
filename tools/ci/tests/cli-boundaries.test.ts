import type * as childProcess from 'node:child_process';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Plan, Result, Test } from '../src/types.ts';
import { parsePlan } from '../src/schema.ts';
import { identity } from '../src/types.ts';
const mocks = vi.hoisted(() => ({
  git: vi.fn<(command: string, args: string[]) => string>(),
  inventory: vi.fn<() => Promise<Test[]>>(),
  run: vi.fn(),
}));
vi.mock('node:child_process', () => ({ execFileSync: mocks.git }));
vi.mock('../src/inventory.ts', () => ({ inventory: mocks.inventory }));
vi.mock('../src/run.ts', () => ({ runShard: mocks.run }));
const state = {
  exitCode: process.exitCode,
  root: '',
  main: async (): Promise<void> => {
    throw new Error('未初期化');
  },
};
const sha = 'a'.repeat(40);
const sample: Test = {
  id: 'node:tools/a:unit:tools/a/a.test.ts',
  file: 'tools/a/a.test.ts',
  project: 'tools/a',
  suite: 'unit',
  runnerClass: 'node',
};
beforeEach(async () => {
  state.exitCode = process.exitCode;
  process.exitCode = undefined;
  state.root = await mkdtemp(path.join(tmpdir(), 'ci-cli-'));
  vi.resetModules();
  vi.spyOn(process, 'cwd').mockReturnValue(state.root);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  for (const key of [
    'GITHUB_SHA',
    'HEAD_SHA',
    'BASE_SHA',
    'GITHUB_REPOSITORY',
    'GITHUB_WORKFLOW',
    'EVENT_NAME',
    'CI_TEST_SELECTION',
    'CI_HISTORY_PATH',
    'CI_TEST_WEIGHTS',
    'GITHUB_OUTPUT',
    'GITHUB_EVENT_NAME',
    'GITHUB_REF',
    'GITHUB_RUN_ID',
  ]) {
    vi.stubEnv(key, undefined);
  }
  mocks.inventory.mockResolvedValue([sample]);
  mocks.git.mockImplementation((_command: string, args: string[]) => {
    switch (args[0]) {
      case 'rev-parse': {
        return sha;
      }
      case 'config': {
        return 'owner/repo';
      }
      case 'merge-base': {
        return sha;
      }
      case 'diff': {
        return 'tools/a/a.test.ts\0';
      }
      case 'ls-tree': {
        return 'tools/a/a.test.ts\0image.png\0';
      }
      case 'show': {
        return '';
      }
      default: {
        throw new Error('unexpected git command');
      }
    }
  });
  state.main = (await import('../src/cli.ts')).main;
});
afterEach(async () => {
  process.exitCode = state.exitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(state.root, { recursive: true, force: true });
});
async function command(...args: string[]) {
  vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'cli.ts', ...args]);
  await state.main();
}
async function plan(): Promise<Plan> {
  return parsePlan(await readFile(path.join(state.root, '.ci/plan.json'), 'utf8'));
}
async function savePlan(value: Plan) {
  await writeFile(path.join(state.root, '.ci/plan.json'), JSON.stringify(value));
}
function pullRequest() {
  vi.stubEnv('EVENT_NAME', 'pull_request');
  vi.stubEnv('BASE_SHA', 'b'.repeat(40));
  vi.stubEnv('HEAD_SHA', 'c'.repeat(40));
}
test('環境未設定ではgitから全件計画を作る', async () => {
  await command('plan');
  expect(await plan()).toMatchObject({
    sha,
    repository: 'owner/repo',
    workflow: 'CI',
    mode: 'all',
    selected: [sample.id],
    shards: [{ predictedMs: 1 }],
  });
});
test('環境指定と均等配分を使いActionsへmatrixを出す', async () => {
  pullRequest();
  vi.stubEnv('CI_TEST_SELECTION', 'all');
  vi.stubEnv('CI_TEST_WEIGHTS', 'equal');
  vi.stubEnv('GITHUB_SHA', sha);
  vi.stubEnv('GITHUB_REPOSITORY', 'explicit/repo');
  vi.stubEnv('GITHUB_WORKFLOW', 'Custom');
  vi.stubEnv('GITHUB_OUTPUT', path.join(state.root, 'output'));
  await command('plan');
  expect(await plan()).toMatchObject({
    mode: 'all',
    repository: 'explicit/repo',
    workflow: 'Custom',
  });
  expect(await readFile(path.join(state.root, 'output'), 'utf8')).toContain('has_tests=true');
});
test.each(['missing', 'invalid', 'git-error'])('比較不能なPRは全件へ戻す: %s', async (reason) => {
  pullRequest();
  if (reason === 'missing') {
    vi.stubEnv('HEAD_SHA', undefined);
  }
  if (reason === 'invalid') {
    vi.stubEnv('BASE_SHA', 'bad');
  }
  if (reason === 'git-error') {
    mocks.git.mockImplementation(() => {
      throw new Error('git unavailable');
    });
  }
  vi.stubEnv('GITHUB_SHA', sha);
  vi.stubEnv('GITHUB_REPOSITORY', 'owner/repo');
  await command('plan');
  expect(await plan()).toMatchObject({
    mode: 'all',
    selected: [sample.id],
    reasons: [expect.stringContaining('比較不能')],
  });
});
test.each(['changed', 'empty', 'unsafe'])('PR差分を選択して理由を記録する: %s', async (mode) => {
  pullRequest();
  const original = mocks.git.getMockImplementation();
  mocks.git.mockImplementation((command: string, args: string[]) =>
    args[0] === 'diff' && mode === 'empty'
      ? ''
      : args[0] === 'show' && mode === 'unsafe'
        ? 'const = broken'
        : original
          ? original(command, args)
          : '',
  );
  await command('plan');
  const value = await plan();
  expect(value.mode).toBe('affected');
  expect(value.selected).toEqual(mode === 'empty' ? [] : [sample.id]);
  expect(value.reasons.join(' ')).toContain(
    mode === 'empty' ? '比較差分は空' : mode === 'unsafe' ? '解析不能' : '変更起点',
  );
});
test('履歴の実測値と未計測テストの代替時間を使う', async () => {
  mocks.inventory.mockResolvedValue([
    sample,
    { ...sample, id: 'second' },
    { ...sample, id: 'third' },
  ]);
  await mkdir(path.join(state.root, 'tools/ci'), { recursive: true });
  await mkdir(path.join(state.root, '.ci'));
  await writeFile(path.join(state.root, 'tools/ci/timing-seed.json'), '{}');
  await writeFile(
    path.join(state.root, '.ci/history-input.json'),
    JSON.stringify({
      schema: 1,
      id: 'history',
      repository: 'owner/repo',
      workflow: 'CI',
      event: 'push',
      branch: 'main',
      conclusion: 'success',
      createdAt: Temporal.Now.instant().toString(),
      samples: [
        { id: sample.id, identity: identity('node'), durationMs: 8 },
        { id: 'second', identity: identity('node'), durationMs: 4 },
      ],
    }),
  );
  await command('plan');
  expect(await plan()).toMatchObject({
    historyId: 'history',
    shards: [{ predictedMs: 8 }, { predictedMs: 8 }, { predictedMs: 4 }],
  });
  vi.stubEnv('CI_TEST_WEIGHTS', 'equal');
  await command('plan');
  expect(await plan()).toMatchObject({
    historyId: null,
    shards: [{ predictedMs: 1 }, { predictedMs: 1 }, { predictedMs: 1 }],
  });
});
test.each(['passed', 'failed'] as const)('シャード実行結果を保存する: %s', async (status) => {
  await command('plan');
  const value = await plan();
  const result: Result = {
    schema: 1,
    sha,
    inventoryHash: value.inventoryHash,
    shardId: 'node-1',
    status,
    executed: [sample.id],
    durations: { [sample.id]: 12 },
    elapsedMs: 12,
    timings: { prepareMs: 0, collectMs: 0, runMs: 12, teardownMs: 0 },
    fileTimings: {},
    identity: identity('node'),
    error: 'failure',
  };
  mocks.run.mockResolvedValue(result);
  await command('run', 'node-1');
  expect(
    JSON.parse(await readFile(path.join(state.root, '.ci/results/node-1.json'), 'utf8')),
  ).toEqual(result);
  expect(process.exitCode).toBe(status === 'failed' ? 1 : undefined);
});
test('SHA不一致と存在しないシャードと不正コマンドを拒否する', async () => {
  await command('plan');
  vi.stubEnv('GITHUB_SHA', 'different');
  await expect(command('result')).rejects.toThrow('実行SHA');
  vi.stubEnv('GITHUB_SHA', undefined);
  await expect(command('run', 'missing')).rejects.toThrow('シャードID');
  await expect(command('invalid')).rejects.toThrow('plan、run');
  const value = await plan();
  value.shards[0].id = '../escape';
  await savePlan(value);
  await expect(command('run', '../escape')).rejects.toThrow('シャードID');
});
test.each(['main', 'branch', 'pull_request', 'affected'])(
  '結果検証とmain全件の履歴更新: %s',
  async (mode) => {
    await command('plan');
    const value = await plan();
    if (mode === 'affected') {
      value.mode = 'affected';
      await savePlan(value);
    }
    await writeFile(path.join(state.root, '.ci/results/ignore.txt'), 'ignored');
    await writeFile(
      path.join(state.root, '.ci/results/node-1.json'),
      JSON.stringify({
        schema: 1,
        sha,
        inventoryHash: value.inventoryHash,
        shardId: 'node-1',
        status: 'passed',
        executed: [sample.id],
        durations: { [sample.id]: 12 },
        elapsedMs: 12,
        timings: { prepareMs: 0, collectMs: 0, runMs: 12, teardownMs: 0 },
        fileTimings: {},
        identity: identity('node'),
      }),
    );
    vi.stubEnv('GITHUB_EVENT_NAME', mode === 'pull_request' ? 'pull_request' : 'push');
    vi.stubEnv('GITHUB_REF', mode === 'branch' ? 'refs/heads/other' : 'refs/heads/main');
    await command('result');
    if (mode === 'main') {
      expect(
        JSON.parse(await readFile(path.join(state.root, '.ci/history.json'), 'utf8')),
      ).toMatchObject({ id: sha, samples: [{ durationMs: 12 }] });
      vi.stubEnv('GITHUB_RUN_ID', 'run-id');
      vi.stubEnv('CI_HISTORY_PATH', path.join(state.root, '.ci/history.json'));
      await command('result');
      expect(
        JSON.parse(await readFile(path.join(state.root, '.ci/history.json'), 'utf8')),
      ).toMatchObject({ id: 'run-id' });
    } else {
      await expect(readFile(path.join(state.root, '.ci/history.json'))).rejects.toThrow();
    }
  },
);

test('CLI入口は失敗を終了コードと標準エラーへ反映する', async () => {
  const { spawnSync } = await vi.importActual<typeof childProcess>('node:child_process');
  const result = spawnSync(
    process.execPath,
    [new URL('../src/cli.ts', import.meta.url).pathname, 'result'],
    { cwd: state.root, encoding: 'utf8', env: process.env },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('ENOENT');
});
