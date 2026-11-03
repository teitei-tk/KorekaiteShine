import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { resolveRuntime } from '@korekaite/runtime-config';
import { startRuntime, runDatabaseCommand } from '../src/runtime.ts';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

test('配送保存失敗を30秒間隔で最大3回再試行し、実DLQで隔離して終了する', async () => {
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  const queues = config.queues.diagnostics;
  if (!queues) throw new Error('診断Queueがありません。');
  const runtime = await startRuntime(config, 'dev', { manualDiagnostics: true });
  let succeeded = false;
  try {
    // 通常Queueだけ記録不能にし、DLQでは同じ異常を保存できる状態にする。
    await runDatabaseCommand(config, [
      'execute',
      `CREATE TRIGGER reject_normal_quarantine BEFORE INSERT ON delivery_anomalies WHEN NEW.queue_name = '${queues.queue}' BEGIN SELECT RAISE(FAIL, 'simulated_delivery_storage_failure'); END;`,
    ]);
    const jobId = randomUUID();
    const response = await fetch(`${runtime.baseUrl}/api/evaluation-test?transport=queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schemaVersion: 1, jobId }),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ enqueued: true });
    await expect
      .poll(
        async () => (await fetch(`${runtime.baseUrl}/api/check-object-test?jobId=${jobId}`)).json(),
        { timeout: 125_000, interval: 500 },
      )
      .toEqual({
        queue: queues.dlq,
        message: { schemaVersion: 1, jobId },
      });
    await runDatabaseCommand(config, [
      'execute',
      `
      CREATE TEMP TABLE four (count INTEGER CHECK (count = 4));
      INSERT INTO four SELECT COUNT(*) FROM connection_checks WHERE writer LIKE 'queue-attempt:${queues.queue}:%';
      CREATE TEMP TABLE one (count INTEGER CHECK (count = 1));
      INSERT INTO one SELECT COUNT(DISTINCT json_extract(value, '$.messageId')) FROM connection_checks WHERE writer LIKE 'queue-attempt:${queues.queue}:%';
      INSERT INTO one SELECT MIN(json_extract(value, '$.attempt')) FROM connection_checks WHERE writer LIKE 'queue-attempt:${queues.queue}:%';
      INSERT INTO four SELECT MAX(json_extract(value, '$.attempt')) FROM connection_checks WHERE writer LIKE 'queue-attempt:${queues.queue}:%';
      INSERT INTO one SELECT COUNT(*) FROM connection_checks WHERE writer LIKE 'queue-attempt:${queues.dlq}:%';
      INSERT INTO one SELECT COUNT(*) FROM delivery_anomalies WHERE queue_name = '${queues.dlq}' AND code = 'JOB_NOT_FOUND' AND job_id = '${jobId}';
      CREATE TEMP TABLE zero (count INTEGER CHECK (count = 0));
      INSERT INTO zero SELECT COUNT(*) FROM (
        SELECT json_extract(value, '$.receivedAt') - LAG(json_extract(value, '$.receivedAt')) OVER (ORDER BY json_extract(value, '$.attempt')) AS elapsed
        FROM connection_checks WHERE writer LIKE 'queue-attempt:${queues.queue}:%'
      ) WHERE elapsed < 30000;
      INSERT INTO zero SELECT COUNT(*) FROM delivery_anomalies WHERE queue_name = '${queues.queue}';
      INSERT INTO zero SELECT COUNT(*) FROM jobs;
      INSERT INTO zero SELECT COUNT(*) FROM job_attempts;
      INSERT INTO zero SELECT COUNT(*) FROM job_outbox;
    `,
    ]);
    succeeded = true;
  } finally {
    await runtime.stop();
    if (succeeded) await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
  }
}, 180_000);
