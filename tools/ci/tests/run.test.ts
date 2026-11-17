import { expect, test } from 'vitest';
import { exactSpecifications, validateResults } from '../src/run.ts';
import type { Plan, Result } from '../src/types.ts';
import { parseResult } from '../src/schema.ts';
const planDefaults = {
  baseSha: null,
  headSha: null,
  mode: 'all',
  graphVersion: 1,
  historyId: null,
  repository: 'test/repo',
  workflow: 'CI',
} as const;
const resultDefaults = {
  durations: {},
  elapsedMs: 0,
  timings: { prepareMs: 0, collectMs: 0, runMs: 0, teardownMs: 0 },
  fileTimings: {},
  identity: 'node:linux:node26:workers2',
};

test('ファイル名の部分一致を許さず、検出にない指定を拒否する', () => {
  const specs = [{ moduleId: '/x/a.test.ts' }, { moduleId: '/x/aa.test.ts' }];
  expect(exactSpecifications(specs, ['/x/a.test.ts'])).toStrictEqual([specs[0]]);
  expect(() => exactSpecifications(specs, ['/x/missing.ts'])).toThrow(/./u);
});

test('不足・失敗・重複した結果とSHA不一致を拒否する', () => {
  const plan: Plan = {
    ...planDefaults,
    tests: [{ id: 'test', file: 'test.ts', project: 'test', suite: 'unit', runnerClass: 'node' }],
    schema: 1,
    sha: 'a',
    inventoryHash: 'hash',
    selected: ['test'],
    shards: [
      {
        id: 'node-1',
        tests: ['test'],
        runner: 'ubuntu-latest',
        runnerClass: 'node',
        predictedMs: 1,
      },
    ],
    reasons: ['all'],
  };
  const result: Result = {
    ...resultDefaults,
    schema: 1,
    sha: 'a',
    inventoryHash: 'hash',
    shardId: 'node-1',
    status: 'passed',
    executed: ['test'],
  };
  expect(() => validateResults(plan, [result])).not.toThrow(/./u);
  for (const results of [
    [],
    [result, result],
    [{ ...result, status: 'failed' }],
    [{ ...result, executed: [] }],
    [{ ...result, sha: 'b' }],
  ]) {
    expect(() => validateResults(plan, results)).toThrow(/./u);
  }
});

test('実runnerは成功・失敗を結果JSONと終了コードへ伝え、部分一致の別ファイルを実行しない', async () => {
  const { mkdtemp, mkdir, writeFile, readFile, symlink, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { default: path } = await import('node:path');
  const { resolve } = path;
  const { spawnSync } = await import('node:child_process');
  const root = await mkdtemp(resolve(tmpdir(), 'ci-run-'));
  const repository = resolve(import.meta.dirname, '../../..');
  try {
    await mkdir(resolve(root, 'project/tests'), { recursive: true });
    await mkdir(resolve(root, '.ci/results'), { recursive: true });
    await writeFile(resolve(root, 'project/package.json'), '{"type":"module"}');
    await symlink(resolve(repository, 'node_modules'), resolve(root, 'node_modules'), 'dir');
    await writeFile(
      resolve(root, 'project/tests/a.test.ts'),
      "import {test,expect} from 'vitest';test('ok',()=>expect(1).toBe(1));",
    );
    await writeFile(
      resolve(root, 'project/tests/aa.test.ts'),
      "throw Error('部分一致で実行してはいけません');",
    );
    const test = {
      id: 'node:project:unit:project/tests/a.test.ts',
      file: 'project/tests/a.test.ts',
      project: 'project',
      suite: 'unit',
      runnerClass: 'node',
    };
    const plan = {
      ...planDefaults,
      schema: 1,
      sha: 'a',
      inventoryHash: 'hash',
      tests: [test],
      selected: [test.id],
      reasons: ['all'],
      shards: [
        {
          id: 'node-1',
          runnerClass: 'node',
          tests: [test.id],
          runner: 'ubuntu-latest',
          predictedMs: 1,
        },
      ],
    };
    await writeFile(resolve(root, '.ci/plan.json'), JSON.stringify(plan));
    const run = () =>
      spawnSync(process.execPath, [resolve(repository, 'tools/ci/src/cli.ts'), 'run', 'node-1'], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, GITHUB_SHA: '' },
      });
    const success = run();
    expect({
      status: success.status,
      output: success.status === 0 ? null : success.stderr + success.stdout,
    }).toStrictEqual({ status: 0, output: null });
    expect(
      parseResult(await readFile(resolve(root, '.ci/results/node-1.json'), 'utf8')).executed,
    ).toStrictEqual([test.id]);
    expect(
      Object.keys(
        parseResult(await readFile(resolve(root, '.ci/results/node-1.json'), 'utf8')).timings,
      ).toSorted(),
    ).toStrictEqual(['collectMs', 'prepareMs', 'runMs', 'teardownMs']);
    await writeFile(
      resolve(root, 'project/tests/a.test.ts'),
      "import {test,expect} from 'vitest';test('bad',()=>expect(1).toBe(2));",
    );
    expect(run().status).toBe(1);
    expect(
      parseResult(await readFile(resolve(root, '.ci/results/node-1.json'), 'utf8')).status,
    ).toBe('failed');
    await writeFile(
      resolve(root, 'project/tests/a.test.ts'),
      "import test from 'node:test';import assert from 'node:assert/strict';test('node',()=>assert.equal(1,1));",
    );
    await writeFile(
      resolve(root, '.ci/plan.json'),
      JSON.stringify({ ...plan, tests: [{ ...test, suite: 'node-test' }] }),
    );
    expect(run().status).toBe(0);
    expect(
      parseResult(await readFile(resolve(root, '.ci/results/node-1.json'), 'utf8')).executed,
    ).toStrictEqual([test.id]);
    await mkdir(resolve(root, 'tools/e2e'), { recursive: true });
    await writeFile(
      resolve(root, 'tools/e2e/run.mjs'),
      "import assert from 'node:assert/strict';assert.equal(process.argv[2],'pr');",
    );
    const e2eTest = { ...test, suite: 'e2e', runnerClass: 'e2e' };
    await writeFile(
      resolve(root, '.ci/plan.json'),
      JSON.stringify({
        ...plan,
        tests: [e2eTest],
        shards: [{ ...plan.shards[0], id: 'e2e-1', runnerClass: 'e2e' }],
      }),
    );
    const e2e = spawnSync(
      process.execPath,
      [resolve(repository, 'tools/ci/src/cli.ts'), 'run', 'e2e-1'],
      { cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_SHA: '' } },
    );
    expect({ status: e2e.status, error: e2e.stderr }).toStrictEqual({ status: 0, error: '' });
    expect(
      parseResult(await readFile(resolve(root, '.ci/results/e2e-1.json'), 'utf8')).executed,
    ).toStrictEqual([test.id]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test('外部JSONの計画・結果は形状と数値を検証してから受け付ける', async () => {
  const { parsePlan, parseResult } = await import('../src/schema.ts');
  for (const input of ['null', '{}', '[]', '{"schema":1,"tests":[],"shards":[]}']) {
    expect(() => parsePlan(input)).toThrow(/計画/u);
  }
  for (const input of ['null', '{}', '{"schema":1,"status":"passed"}']) {
    expect(() => parseResult(input)).toThrow(/結果/u);
  }
});
