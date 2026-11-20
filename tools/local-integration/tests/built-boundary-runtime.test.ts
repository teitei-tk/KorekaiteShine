import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRuntime } from '@korekaite/runtime-config';
import { expect, test } from 'vitest';
import { startRuntime, runDatabaseCommand } from './helpers/built-runtime.ts';
import { readJson } from './helpers/json.ts';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
test('共通ビルドから同時起動してもD1・DO・Queueとフラグを混線させない', async () => {
  const runId = randomUUID();
  const configs = [0, 1].map((parallelIndex) =>
    resolveRuntime({ repositoryRoot, appEnv: 'test', runId, parallelIndex }),
  );
  const started = await Promise.allSettled(
    configs.map((config) =>
      startRuntime(config, 'dev', { manualDiagnostics: true, probeOnlyEvaluation: true }),
    ),
  );
  try {
    const runtimes = started.map((result) => {
      if (result.status === 'rejected') {
        throw result.reason;
      }
      return result.value;
    });
    const [first, second] = runtimes;
    const marker = randomUUID();
    const saved = await fetch(`${first.baseUrl}/api/isolation-test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ marker }),
    });
    expect(saved.status).toBe(200);
    expect(await readJson(await fetch(`${second.baseUrl}/api/isolation-test`))).toBeNull();
    expect(await readJson(await fetch(`${first.baseUrl}/api/isolation-test`))).toBe(marker);
    for (const [index, config] of configs.entries()) {
      await runDatabaseCommand(config, [
        'execute',
        `INSERT INTO connection_checks (writer, value) VALUES ('isolated', '${index}')`,
      ]);
    }
    for (const [index, runtime] of runtimes.entries()) {
      const response = await fetch(`${runtime.baseUrl}/api/database-topology`);
      expect(response.status).toBe(200);
      const rows = await readJson(response);
      expect(rows).toContainEqual({ writer: 'isolated', value: String(index) });
      expect(rows).not.toContainEqual({ writer: 'isolated', value: String(1 - index) });
    }
    const jobId = randomUUID();
    const sent = await fetch(`${first.baseUrl}/api/formal-queue-test?source=web`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schemaVersion: 1, jobId }),
    });
    expect(sent.status).toBe(202);
    await expect
      .poll(
        async () => readJson(await fetch(`${first.baseUrl}/api/check-object-test?jobId=${jobId}`)),
        { timeout: 10_000 },
      )
      .toMatchObject({ queue: configs[0].queues.evaluation.queue });
    expect(
      await readJson(await fetch(`${second.baseUrl}/api/check-object-test?jobId=${jobId}`)),
    ).toBeNull();
  } finally {
    await Promise.all(
      started.flatMap((result) => (result.status === 'fulfilled' ? [result.value.stop()] : [])),
    );
    await rm(dirname(dirname(configs[0].artifactDirectory)), { recursive: true, force: true });
  }
}, 60_000);
