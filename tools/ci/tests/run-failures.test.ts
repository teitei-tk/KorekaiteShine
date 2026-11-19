import { ChildProcess } from 'node:child_process';
import type * as ChildProcessModule from 'node:child_process';
import { runShard, exactSpecifications } from '../src/run.ts';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Plan, Shard } from '../src/types.ts';
const mocks = vi.hoisted(() => ({
  createVitest: vi.fn(),
  spawn: vi.fn(),
  bundle: vi.fn(),
  boundary: vi.fn(),
}));
vi.mock('vitest/node', () => ({ createVitest: mocks.createVitest }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcessModule>()),
  spawn: mocks.spawn,
}));
vi.mock('../../local-integration/src/boundary-bundle.ts', () => ({
  createBoundaryBundle: mocks.bundle,
  boundaryTestFile: mocks.boundary,
}));
const shard: Shard = {
  id: 'node-1',
  runner: 'ubuntu-latest',
  runnerClass: 'node',
  tests: ['a'],
  predictedMs: 1,
};
const plan: Plan = {
  schema: 1,
  sha: 'a',
  baseSha: null,
  headSha: null,
  mode: 'all',
  graphVersion: 1,
  historyId: null,
  inventoryHash: 'h',
  reasons: ['all'],
  repository: 'r',
  workflow: 'CI',
  selected: ['a'],
  tests: [
    {
      id: 'a',
      file: 'tools/local-integration/a.test.ts',
      project: 'tools/local-integration',
      suite: 'unit',
      runnerClass: 'node',
    },
  ],
  shards: [shard],
};
const diagnostic = () => ({
  prepareDuration: 1,
  environmentSetupDuration: 2,
  collectDuration: 3,
  duration: 4,
  setupDuration: 5,
});
const module = {
  moduleId: '/repo/tools/local-integration/a.test.ts',
  state: () => 'passed',
  diagnostic,
};
const close = vi.fn();
const dispose = vi.fn();
const context = () => ({
  globTestSpecifications: vi.fn().mockResolvedValue([module]),
  runTestSpecifications: vi.fn().mockResolvedValue({ testModules: [module], unhandledErrors: [] }),
  close,
});
beforeEach(() => {
  vi.resetAllMocks();
  mocks.boundary.mockReturnValue(false);
  mocks.bundle.mockResolvedValue({ directory: '/bundle', dispose });
  mocks.createVitest.mockResolvedValue(context());
});
afterEach(() => {
  process.exitCode = undefined;
});
test('重複対象と検出時の重複に隠れた不足を拒否する', () => {
  expect(() => exactSpecifications([module], [module.moduleId, module.moduleId])).toThrow('重複');
  expect(() => exactSpecifications([module, module], [module.moduleId, '/missing'])).toThrow(
    '一致',
  );
});
test('不明IDは実行せず失敗として返す', async () => {
  expect(await runShard('/repo', plan, { ...shard, tests: ['missing'] })).toMatchObject({
    status: 'failed',
    executed: [],
  });
  expect(mocks.createVitest).not.toHaveBeenCalled();
});
test('境界bundleをVitestへ渡し成功時に解放する', async () => {
  mocks.boundary.mockReturnValue(true);
  expect(await runShard('/repo', plan, shard)).toMatchObject({
    status: 'passed',
    executed: ['a'],
    durations: { a: 15 },
  });
  expect(mocks.createVitest).toHaveBeenCalledWith(
    expect.objectContaining({ env: { KOREKAITE_BOUNDARY_BUNDLE: '/bundle' } }),
  );
  expect(dispose).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});
test('Vitest作成失敗時もbundleを解放する', async () => {
  mocks.boundary.mockReturnValue(true);
  mocks.createVitest.mockRejectedValue(new Error('create failed'));
  expect(await runShard('/repo', plan, shard)).toMatchObject({ status: 'failed' });
  expect(dispose).toHaveBeenCalledOnce();
});
test('bundleなしの作成失敗と文字列例外も結果に残す', async () => {
  mocks.createVitest.mockRejectedValue('unavailable');
  expect(await runShard('/repo', plan, shard)).toMatchObject({
    status: 'failed',
    error: 'unavailable',
  });
});
test('未処理エラーと終了コードを失敗として扱う', async () => {
  for (const exitCode of [undefined, 0, 1]) {
    process.exitCode = exitCode;
    const ctx = context();
    ctx.runTestSpecifications.mockResolvedValue({
      testModules: [module],
      unhandledErrors: exitCode === undefined ? [new Error('unhandled')] : [],
    });
    mocks.createVitest.mockResolvedValue(ctx);
    expect((await runShard('/repo', plan, shard)).status).toBe(
      exitCode === 0 ? 'passed' : 'failed',
    );
  }
});
test('close失敗時にもbundleを解放する', async () => {
  mocks.boundary.mockReturnValue(true);
  close.mockRejectedValue(new Error('close failed'));
  expect(await runShard('/repo', plan, shard)).toMatchObject({ status: 'failed' });
  expect(dispose).toHaveBeenCalledOnce();
});
test('未完了のmoduleを成功として記録しない', async () => {
  const ctx = context();
  ctx.runTestSpecifications.mockResolvedValue({
    testModules: [{ ...module, state: () => 'skipped' }],
    unhandledErrors: [],
  });
  mocks.createVitest.mockResolvedValue(ctx);
  expect(await runShard('/repo', plan, shard)).toMatchObject({ status: 'failed', executed: [] });
});
test.each(['node-test', 'features/a.feature:1'])(
  '%sの終了・シグナル・起動失敗を報告する',
  async (suite) => {
    const runnerClass = suite === 'node-test' ? 'node' : 'e2e';
    for (const code of [0, 1, null, 'error']) {
      mocks.spawn.mockImplementation(() => {
        const child = new ChildProcess();
        queueMicrotask(() => {
          if (code === 'error') {
            child.emit('error', new Error('spawn failed'));
          } else {
            child.emit('exit', code);
          }
        });
        return child;
      });
      const result = await runShard(
        '/repo',
        { ...plan, tests: [{ ...plan.tests[0], suite }] },
        { ...shard, runnerClass },
      );
      expect(result.status).toBe(code === 0 ? 'passed' : 'failed');
      expect(result.executed).toStrictEqual(code === 0 ? ['a'] : []);
    }
  },
);
test('不正なE2E位置を起動前に拒否する', async () => {
  expect(await runShard('/repo', plan, { ...shard, runnerClass: 'e2e' })).toMatchObject({
    status: 'failed',
  });
  expect(mocks.spawn).not.toHaveBeenCalled();
});
