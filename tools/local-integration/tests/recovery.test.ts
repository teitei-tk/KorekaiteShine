import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { resolveRuntime } from '@korekaite/runtime-config';
import { startRuntime, runDatabaseCommand } from '../src/runtime.ts';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

test('再起動後のscheduledが期限到来した再試行通知を送り、Queue経由で評価を再開する', async () => {
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
      "CREATE TRIGGER reject_retry_sent BEFORE UPDATE OF sent_at ON job_outbox WHEN OLD.operation = 'notify' AND OLD.generation > 0 BEGIN SELECT RAISE(FAIL, 'simulated_sent_failure'); END;",
    ]);
    const response = await fetch(`${runtime.baseUrl}/api/diagnostics/check-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: '{"scenario":"retry_then_success"}',
    });
    expect(response.status).toBe(202);
    const accepted = await response.json();
    const status = async () =>
      (await fetch(`${runtime.baseUrl}/api/diagnostics/check-jobs/${accepted.jobId}`)).json();
    await expect
      .poll(status, { timeout: 8_000, interval: 100 })
      .toMatchObject({ status: 'retry_wait', attemptCount: 1 });
    await runtime.stop();
    // 独立test DBだけで時刻を進め、配送と回復の接続を検証する。
    await runDatabaseCommand(config, [
      'execute',
      `
      DROP TRIGGER reject_retry_sent;
      UPDATE jobs SET next_attempt_at = 0 WHERE status = 'retry_wait';
      UPDATE job_outbox SET scheduled_at = 0 WHERE operation = 'notify' AND sent_at IS NULL;
    `,
    ]);
    runtime = await startRuntime(config);
    await runtime.runScheduled();
    await expect.poll(status, { timeout: 8_000, interval: 100 }).toMatchObject({
      status: 'completed',
      attemptCount: 2,
      lastErrorCode: 'SIMULATED_AI_FAILURE',
      checks: { consumerCompletion: 'passed' },
    });
    await runtime.runScheduled();
    await runDatabaseCommand(config, [
      'execute',
      `
      CREATE TEMP TABLE two (count INTEGER CHECK (count = 2));
      INSERT INTO two SELECT COUNT(*) FROM job_attempts;
      INSERT INTO two SELECT COUNT(*) FROM job_outbox WHERE operation = 'notify' AND sent_at IS NOT NULL;
    `,
    ]);
    succeeded = true;
  } finally {
    await runtime.stop();
    if (succeeded) {
      await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
    }
  }
}, 60_000);

test('評価失敗直後に遅延通知を送り、scheduledを待たずに2回目を実行する', async () => {
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  const runtime = await startRuntime(config);
  let succeeded = false;
  try {
    const response = await fetch(`${runtime.baseUrl}/api/diagnostics/check-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: '{"scenario":"retry_then_success"}',
    });
    expect(response.status).toBe(202);
    const accepted = await response.json();
    const status = async () =>
      (await fetch(`${runtime.baseUrl}/api/diagnostics/check-jobs/${accepted.jobId}`)).json();
    await expect
      .poll(status, { timeout: 8_000, interval: 100 })
      .toMatchObject({ status: 'retry_wait', attemptCount: 1 });
    await expect
      .poll(
        async () => {
          try {
            await runDatabaseCommand(config, [
              'execute',
              `CREATE TEMP TABLE sent (count INTEGER CHECK (count = 1)); INSERT INTO sent SELECT COUNT(*) FROM job_outbox WHERE operation = 'notify' AND generation = 1 AND sent_at IS NOT NULL;`,
            ]);
            return true;
          } catch {
            return false;
          }
        },
        { timeout: 5_000, interval: 100 },
      )
      .toBe(true);
    const waiting = await status();
    expect(waiting).toMatchObject({ status: 'retry_wait', attemptCount: 1 });
    const nextAttemptAt = Temporal.Instant.from(waiting.nextAttemptAt).epochMilliseconds;
    await expect
      .poll(status, { timeout: 40_000, interval: 250 })
      .toMatchObject({ status: 'completed', attemptCount: 2 });
    const completed = await status();
    expect(Temporal.Instant.from(completed.finishedAt).epochMilliseconds).toBeGreaterThanOrEqual(
      nextAttemptAt,
    );
    succeeded = true;
  } finally {
    await runtime.stop();
    if (succeeded) {
      await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
    }
  }
}, 60_000);

test('送信済みで未実行の期限到来通知を並行scheduledで回復し、評価は一度だけ実行する', async () => {
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  let runtime = await startRuntime(config, 'dev', { probeOnlyEvaluation: true });
  let succeeded = false;
  try {
    const response = await fetch(`${runtime.baseUrl}/api/diagnostics/check-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ scenario: 'success' }),
    });
    expect(response.status).toBe(202);
    const { jobId } = await response.json();
    await expect
      .poll(
        async () => (await fetch(`${runtime.baseUrl}/api/check-object-test?jobId=${jobId}`)).json(),
        { timeout: 8_000, interval: 100 },
      )
      .toMatchObject({ message: { jobId } });
    await runtime.stop();
    await runDatabaseCommand(config, [
      'execute',
      `UPDATE job_outbox SET scheduled_at = 0, sent_at = 0 WHERE job_id = '${jobId}' AND operation = 'notify';`,
    ]);
    runtime = await startRuntime(config, 'dev');
    await Promise.all([runtime.runScheduled(), runtime.runScheduled()]);
    const status = async () =>
      (await fetch(`${runtime.baseUrl}/api/diagnostics/check-jobs/${jobId}`)).json();
    await expect
      .poll(status, { timeout: 10_000, interval: 100 })
      .toMatchObject({ status: 'completed', attemptCount: 1 });
    await Promise.all([runtime.runScheduled(), runtime.runScheduled()]);
    await runDatabaseCommand(config, [
      'execute',
      `
      CREATE TEMP TABLE one (count INTEGER CHECK (count = 1));
      INSERT INTO one SELECT COUNT(*) FROM job_attempts WHERE job_id = '${jobId}' AND finished_at IS NOT NULL;
      INSERT INTO one SELECT COUNT(*) FROM job_outbox WHERE job_id = '${jobId}' AND operation = 'notify' AND generation = 0 AND sent_at > 0;
      INSERT INTO one SELECT COUNT(*) FROM jobs WHERE job_id = '${jobId}' AND status = 'completed' AND attempt_count = 1;
      CREATE TEMP TABLE zero (count INTEGER CHECK (count = 0));
      INSERT INTO zero SELECT COUNT(*) FROM execution_slots;
    `,
    ]);
    succeeded = true;
  } finally {
    await runtime.stop();
    if (succeeded) {
      await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
    }
  }
}, 60_000);
