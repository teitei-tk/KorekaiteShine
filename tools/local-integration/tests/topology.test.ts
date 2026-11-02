import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
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
  let succeeded = false;
  try {
    const response = await fetch(`${runtime.baseUrl}/api/topology`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ saved: 'interview-do', environment: 'test' });
    succeeded = true;
  } finally {
    await runtime.stop();
    if (succeeded) await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
  }
}, 60_000);

test('DB管理CLIと3 Workersが同じD1を読み書きできる', async () => {
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  const runtime = await startRuntime(config);
  let succeeded = false;
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
    succeeded = true;
  } finally {
    await runtime.stop();
    if (succeeded) await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
  }
}, 60_000);

test('ローカルランタイムからEvaluationのscheduledイベントを起動できる', async () => {
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  const runtime = await startRuntime(config);
  let succeeded = false;
  try {
    await runtime.runScheduled();
    const response = await fetch(`${runtime.baseUrl}/api/database-topology`);
    expect(response.status).toBe(200);
    expect(await response.json()).toContainEqual({ writer: 'scheduled', value: '* * * * *' });
    succeeded = true;
  } finally {
    await runtime.stop();
    if (succeeded) await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
  }
}, 60_000);

test('開発とテストを同時起動してもD1とViteキャッシュを共有しない', async () => {
  const isolatedRoot = await mkdtemp(join(tmpdir(), 'korekaite-environments-'));
  const configs = [
    resolveRuntime({ repositoryRoot: isolatedRoot, appEnv: 'development' }),
    resolveRuntime({
      repositoryRoot: isolatedRoot,
      appEnv: 'test',
      runId: randomUUID(),
      parallelIndex: 0,
    }),
  ];
  const started = await Promise.allSettled(configs.map((config) => startRuntime(config)));
  let succeeded = false;
  try {
    for (const result of started) {
      if (result.status === 'rejected') throw result.reason;
    }
    for (const [index, result] of started.entries()) {
      if (result.status !== 'fulfilled') throw new Error('起動に失敗しました。');
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
    }
    succeeded = true;
  } finally {
    await Promise.all(
      started.map((result) => (result.status === 'fulfilled' ? result.value.stop() : undefined)),
    );
    if (succeeded) await rm(isolatedRoot, { recursive: true, force: true });
  }
}, 120_000);

test('D1 batchの途中で一意制約違反が起きると全体がロールバックされる', async () => {
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  const runtime = await startRuntime(config);
  let succeeded = false;
  try {
    const response = await fetch(`${runtime.baseUrl}/api/batch-topology`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ rejected: true, rows: [] });
    succeeded = true;
  } finally {
    await runtime.stop();
    if (succeeded) await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
  }
}, 60_000);

test('VoidのDB接続でfirst-primaryを指定し、保存後の値を読み戻す', async () => {
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  const runtime = await startRuntime(config);
  let succeeded = false;
  try {
    const response = await fetch(`${runtime.baseUrl}/api/primary-topology`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      constraints: ['first-primary'],
      rows: [{ writer: 'primary', value: 'saved' }],
    });
    succeeded = true;
  } finally {
    await runtime.stop();
    if (succeeded) await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
  }
}, 60_000);

test('停止後に同じ環境を再起動するとD1の保存値を維持する', async () => {
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  let runtime = await startRuntime(config);
  let succeeded = false;
  try {
    await runDatabaseCommand(config, [
      'execute',
      "INSERT INTO connection_checks (writer, value) VALUES ('restart', 'retained')",
    ]);
    await runtime.stop();
    runtime = await startRuntime(config);
    const response = await fetch(`${runtime.baseUrl}/api/database-topology`);
    expect(response.status).toBe(200);
    expect(await response.json()).toContainEqual({ writer: 'restart', value: 'retained' });
    succeeded = true;
  } finally {
    await runtime.stop();
    if (succeeded) await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
  }
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
  let succeeded = false;
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
    succeeded = true;
  } finally {
    await runtime.stop();
    if (succeeded) await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
  }
}, 120_000);
