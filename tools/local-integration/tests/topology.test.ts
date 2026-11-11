import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from 'vitest';
import { resolveRuntime } from '@korekaite/runtime-config';
import { startRuntime, buildRuntime, runDatabaseCommand } from '../src/runtime.ts';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

test('Webから別WorkerのDOを呼び、DOの保存値を読み戻せる', async () => {
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  const runtime = await startRuntime(config);

  try {
    const response = await fetch(`${runtime.baseUrl}/api/topology`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ saved: 'interview-do', environment: 'test' });
  } finally {
    await runtime.stop();
  }

  await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
}, 60_000);

test('DB管理CLIと3 Workersが同じD1を読み書きできる', async () => {
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  const runtime = await startRuntime(config);

  try {
    await runDatabaseCommand(config, [
      'execute',
      "INSERT INTO connection_checks (writer, value) VALUES ('cli', 'shared')",
    ]);
    const response = await fetch(`${runtime.baseUrl}/api/database-topology`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      { writer: 'cli', value: 'shared' },
      { writer: 'evaluation', value: 'shared' },
      { writer: 'interview', value: 'shared' },
      { writer: 'web', value: 'shared' },
    ]);
  } finally {
    await runtime.stop();
  }

  await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
}, 60_000);

test('ローカルランタイムからEvaluationのscheduledイベントを起動できる', async () => {
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  const runtime = await startRuntime(config);

  try {
    await runtime.runScheduled();
    const response = await fetch(`${runtime.baseUrl}/api/database-topology`);
    expect(response.status).toBe(200);
    expect(await response.json()).toContainEqual({ writer: 'scheduled', value: '* * * * *' });
  } finally {
    await runtime.stop();
  }

  await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
}, 60_000);

test('開発とテストを同時起動してもD1とViteキャッシュを共有しない', async () => {
  const isolatedRoot = await mkdtemp(join(tmpdir(), 'korekaite-environments-'));
  const parallelRunId = randomUUID();
  const configs = [
    resolveRuntime({ repositoryRoot: isolatedRoot, appEnv: 'development' }),
    resolveRuntime({
      repositoryRoot: isolatedRoot,
      appEnv: 'test',
      runId: parallelRunId,
      parallelIndex: 0,
    }),
    resolveRuntime({
      repositoryRoot: isolatedRoot,
      appEnv: 'test',
      runId: parallelRunId,
      parallelIndex: 1,
    }),
  ];
  const started = await Promise.allSettled(configs.map((config) => startRuntime(config)));

  try {
    for (const result of started) {
      if (result.status === 'rejected') {
        throw result.reason;
      }
    }
    for (const [index, result] of started.entries()) {
      if (result.status !== 'fulfilled') {
        throw new Error('起動に失敗しました。');
      }
      await runDatabaseCommand(configs[index]!, [
        'execute',
        `INSERT INTO connection_checks (writer, value) VALUES ('isolated', '${index}')`,
      ]);
      const response = await fetch(`${result.value.baseUrl}/api/database-topology`);
      expect(response.status).toBe(200);
      expect(await response.json()).toContainEqual({ writer: 'isolated', value: String(index) });
      expect(
        (await stat(join(configs[index]!.artifactDirectory, 'vite-cache'))).isDirectory(),
      ).toBe(true);
      for (const project of ['web', 'database']) {
        const projectRoot = join(configs[index]!.artifactDirectory, project);
        const metadata = JSON.parse(
          await readFile(join(projectRoot, '.void/local-d1.json'), 'utf8'),
        );
        expect(await realpath(metadata.projectRoot)).toBe(await realpath(projectRoot));
        expect(await realpath(metadata.persistRoot)).toBe(
          await realpath(configs[index]!.stateDirectory!),
        );
      }
    }
  } finally {
    await Promise.all(
      started.map((result) => (result.status === 'fulfilled' ? result.value.stop() : undefined)),
    );
  }

  await rm(isolatedRoot, { recursive: true, force: true });
}, 120_000);

test('D1 batchの途中で一意制約違反が起きると全体がロールバックされる', async () => {
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  const runtime = await startRuntime(config);

  try {
    const response = await fetch(`${runtime.baseUrl}/api/batch-topology`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ rejected: true, rows: [] });
  } finally {
    await runtime.stop();
  }

  await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
}, 60_000);

test('VoidのDB接続でfirst-primaryを指定し、保存後の値を読み戻す', async () => {
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  const runtime = await startRuntime(config);

  try {
    const response = await fetch(`${runtime.baseUrl}/api/primary-topology`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      constraints: ['first-primary'],
      rows: [{ writer: 'primary', value: 'saved' }],
    });
  } finally {
    await runtime.stop();
  }

  await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
}, 60_000);

test('停止後に同じ環境を再起動するとD1の保存値を維持する', async () => {
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  const runtimeContext = { runtime: await startRuntime(config) };
  try {
    await runDatabaseCommand(config, [
      'execute',
      "INSERT INTO connection_checks (writer, value) VALUES ('restart', 'retained')",
    ]);
    await runtimeContext.runtime.stop();
    runtimeContext.runtime = await startRuntime(config);
    const response = await fetch(`${runtimeContext.runtime.baseUrl}/api/database-topology`);
    expect(response.status).toBe(200);
    expect(await response.json()).toContainEqual({ writer: 'restart', value: 'retained' });
  } finally {
    await runtimeContext.runtime.stop();
  }

  await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
}, 120_000);

test('3 Workersのビルド済み成果物でもWeb・DO・共有D1が接続できる', async () => {
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  await buildRuntime(config);
  const runtime = await startRuntime(config, 'preview');

  try {
    const topology = await fetch(`${runtime.baseUrl}/api/topology`);
    expect(topology.status).toBe(200);
    expect(await topology.json()).toEqual({ saved: 'interview-do', environment: 'test' });
    const database = await fetch(`${runtime.baseUrl}/api/database-topology`);
    expect(database.status).toBe(200);
    expect(await database.json()).toEqual([
      { writer: 'evaluation', value: 'shared' },
      { writer: 'interview', value: 'shared' },
      { writer: 'web', value: 'shared' },
    ]);
  } finally {
    await runtime.stop();
  }

  await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
}, 120_000);

test('明示したreset-seedだけが既存データを消して固定データを投入する', async () => {
  const runId = randomUUID();
  const config = resolveRuntime({ repositoryRoot, appEnv: 'test', runId, parallelIndex: 0 });
  const runtimeContext = { runtime: await startRuntime(config) };
  try {
    await runDatabaseCommand(config, [
      'execute',
      "INSERT INTO connection_checks (writer, value) VALUES ('temporary', 'remove-me')",
    ]);
    const before = await fetch(`${runtimeContext.runtime.baseUrl}/api/database-topology`);
    const beforeRows = await before.json();
    expect(beforeRows).toContainEqual({ writer: 'temporary', value: 'remove-me' });
    expect(beforeRows).not.toContainEqual({ writer: 'fixture', value: 'local-only' });
    await runtimeContext.runtime.stop();
    const seeded = spawnSync('pnpm', ['db:reset-seed'], {
      cwd: repositoryRoot,
      env: { ...process.env, APP_ENV: 'test', LOCAL_TEST_RUN_ID: runId, LOCAL_TEST_SLOT: '0' },
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(seeded.status, seeded.stderr).toBe(0);
    runtimeContext.runtime = await startRuntime(config);
    const after = await fetch(`${runtimeContext.runtime.baseUrl}/api/database-topology`);
    expect(after.status).toBe(200);
    expect(await after.json()).toEqual([
      { writer: 'evaluation', value: 'shared' },
      { writer: 'fixture', value: 'local-only' },
      { writer: 'interview', value: 'shared' },
      { writer: 'web', value: 'shared' },
    ]);
  } finally {
    await runtimeContext.runtime.stop();
  }

  await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
}, 120_000);

test('起動中の環境では別プロセスのreset-seedを拒否しデータを維持する', async () => {
  const runId = randomUUID();
  const config = resolveRuntime({ repositoryRoot, appEnv: 'test', runId, parallelIndex: 0 });
  const runtime = await startRuntime(config);

  try {
    await runDatabaseCommand(config, [
      'execute',
      "INSERT INTO connection_checks (writer, value) VALUES ('active', 'retained')",
    ]);
    const attempted = spawnSync('pnpm', ['db:reset-seed'], {
      cwd: repositoryRoot,
      env: { ...process.env, APP_ENV: 'test', LOCAL_TEST_RUN_ID: runId, LOCAL_TEST_SLOT: '0' },
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(attempted.status).toBe(1);
    expect(attempted.stderr).toContain('環境は使用中です');
    const response = await fetch(`${runtime.baseUrl}/api/database-topology`);
    expect(response.status).toBe(200);
    expect(await response.json()).toContainEqual({ writer: 'active', value: 'retained' });
  } finally {
    await runtime.stop();
  }

  await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
}, 60_000);

test('生成したQueue検証コードを実Workerへimportし、入力を変換せず検証する', async () => {
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  const runtime = await startRuntime(config);
  const jobId = '7e318b72-f255-4f17-845b-714d487ae621';

  try {
    for (const input of [
      { body: { schemaVersion: 1, jobId }, valid: true },
      { body: { schemaVersion: '1', jobId }, valid: false },
      { body: { schemaVersion: 1, jobId, extra: 'preserved' }, valid: false },
      { body: { schemaVersion: 1, jobId: 'invalid' }, valid: false },
      { body: { jobId }, valid: false },
      { body: { schemaVersion: 1 }, valid: false },
      { body: null, valid: false },
    ]) {
      const response = await fetch(`${runtime.baseUrl}/api/queue-contract-topology`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input.body),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(input);
    }
  } finally {
    await runtime.stop();
  }

  await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
}, 60_000);
